// 名刺の読み取り Workflow（docs/design.md §5、docs/cloudflare-small-design.md §2, §6）。
// ステップ: 設定を読む → Files API へ預ける（表、裏）→ generateContent → 応答の処理 → 保存 → Files の削除。
//
// 自動の試し直し（§5.7）:
//   - 混雑・一時的なエラー（429 / 5xx / 時間切れ）… generate ステップの retries（2 回、間隔を空ける）
//   - JSON を取り出せない / 主な項目がすべて空 … 生成から 1 回だけやり直す（ステップ名を変えて再実行）
// 注意: ステップの戻り値は Workflow の状態として保存される。API キーは絶対に返さない（各ステップで読み直す）。
import { WorkflowEntrypoint } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { cardScanParams } from './card-params.js';
import { failureFor, keyColumns } from '../lib/cards.js';
import {
  ProviderError,
  deleteFromFilesApi,
  generateCard,
  interpretCardResponse,
  uploadToFilesApi,
} from '../lib/gemini-run.js';
import { getApiKey, currentPrompt, getModel, selectedModelId } from '../lib/settings.js';
import { nowIso } from '../lib/time.js';
import { recordUsage } from '../lib/usage.js';

const RETRY_TRANSIENT = { limit: 2, delay: '5 seconds', backoff: 'exponential' };
const KIND_TAG = /\[kind=([a-z_]+)\]/;

// ステップの外へ出ると Error に作り直されるので、失敗の種類は message に埋めて運ぶ
function stepError(e) {
  const kind = e instanceof ProviderError ? e.kind : 'provider';
  const retryable = e instanceof ProviderError ? e.retryable : true;
  const err = retryable ? new Error(`[kind=${kind}] ${e.message}`) : new NonRetryableError(`[kind=${kind}] ${e.message}`);
  return err;
}

const kindOf = (e) => KIND_TAG.exec(String(e?.message))?.[1] ?? 'provider';

export class CardScanWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const { cardId, userId, userName, type } = cardScanParams(event.payload);
    const env = this.env;

    // 1. 設定（モデル、プロンプト、画像のキー）。キーが未設定でもここでは止めず、保存ステップで失敗として記録する
    const cfg = await step.do('load-config', async () => {
      const card = await env.DB.prepare('SELECT image_front_key, image_back_key FROM cards WHERE id = ?').bind(cardId).first();
      if (!card) throw new NonRetryableError('card not found');
      const modelId = await selectedModelId(env, 'card');
      const model = await getModel(env, modelId);
      const prompt = await currentPrompt(env, 'card');
      const hasKey = Boolean(await getApiKey(env, model?.provider === 'openai' ? 'openai' : 'gemini'));
      return {
        frontKey: card.image_front_key,
        backKey: card.image_back_key,
        model: model ? { id: model.id, provider: model.provider, thinkingLevel: model.thinkingLevel, pricing: model.pricing } : null,
        promptText: prompt.text,
        promptVersion: prompt.version,
        ready: Boolean(model) && model.provider === 'gemini' && hasKey,
      };
    });

    let failureKind = cfg.ready ? null : 'not_configured';
    let result = null; // interpretCardResponse の成功 / 失敗
    let tokens = { inputTokens: 0, outputTokens: 0 };
    let attempts = 0;
    const startedAt = Date.now();
    const files = [];

    if (cfg.ready) {
      // 2. Files API へ預ける（表、裏）。R2 の本文をそのまま流す
      for (const [side, key] of [['front', cfg.frontKey], ['back', cfg.backKey]]) {
        if (!key) continue;
        try {
          const file = await step.do(`upload-${side}`, { retries: RETRY_TRANSIENT, timeout: '2 minutes' }, async () => {
            const apiKey = await getApiKey(env, 'gemini');
            if (!apiKey) throw new NonRetryableError('[kind=not_configured] no key');
            const object = await env.IMAGES.get(key);
            if (!object) throw new NonRetryableError('[kind=provider] image missing');
            try {
              return await uploadToFilesApi({ apiKey, object, displayName: `card-${cardId}-${side}` });
            } catch (e) {
              throw stepError(e);
            }
          });
          files.push(file);
        } catch (e) {
          failureKind = kindOf(e);
          break;
        }
      }

      // 3〜4. 生成 → 応答の処理。JSON が壊れた / 空だったときだけ、生成から 1 回やり直す
      for (attempts = 0; !failureKind && attempts < 2; attempts++) {
        let gen;
        try {
          gen = await step.do(`generate-${attempts}`, { retries: RETRY_TRANSIENT, timeout: '3 minutes' }, async () => {
            const apiKey = await getApiKey(env, 'gemini');
            if (!apiKey) throw new NonRetryableError('[kind=not_configured] no key');
            try {
              return await generateCard({ apiKey, model: cfg.model, prompt: cfg.promptText, files });
            } catch (e) {
              throw stepError(e);
            }
          });
        } catch (e) {
          failureKind = kindOf(e);
          break;
        }
        tokens.inputTokens += gen.usage.inputTokens;
        tokens.outputTokens += gen.usage.outputTokens + (gen.usage.thoughtTokens ?? 0);

        result = await step.do(`process-${attempts}`, async () => interpretCardResponse(gen));
        if (result.ok || !result.retryable || result.kind === 'truncated') break;
      }
      if (!failureKind && result && !result.ok) failureKind = result.kind;
    }

    // 5. 保存（成功なら確認待ち、失敗なら failed）。何度実行されても同じ結果になる書き方にする
    await step.do('save', async () => {
      const at = nowIso();
      const elapsedMs = Date.now() - startedAt;
      const extraction = JSON.stringify({
        modelId: cfg.model?.id ?? null,
        promptVersion: cfg.promptVersion,
        inputTokens: tokens.inputTokens,
        outputTokens: tokens.outputTokens,
        elapsedMs,
        attempts: Math.min(attempts, 2),
        repairs: result?.repairs ?? [],
        coerced: result?.coerced ?? [],
      });
      if (!failureKind && result?.ok) {
        const c = result.card;
        const k = keyColumns(result.keys);
        await env.DB.prepare(
          `UPDATE cards SET status = 'review', company = ?, department = ?, title = ?, name = ?, name_reading = ?,
             phones = ?, mobiles = ?, emails = ?, note = ?, raw_text = ?,
             company_n = ?, name_n = ?, reading_n = ?, department_n = ?, phones_digits = ?, emails_n = ?, title_n = ?, note_n = ?,
             failure = NULL, extraction = ?, updated_at = ?, version = version + 1
           WHERE id = ?`,
        )
          .bind(
            c.company, c.department, c.title, c.name, c.nameReading,
            JSON.stringify(c.phones), JSON.stringify(c.mobiles), JSON.stringify(c.emails), c.note, c.rawText,
            k.company_n, k.name_n, k.reading_n, k.department_n, k.phones_digits, k.emails_n, k.title_n, k.note_n,
            extraction, at, cardId,
          )
          .run();
      } else if (result?.kind === 'truncated' && result.card) {
        // 途中で切れた場合は、読めた項目を残して失敗にする（画面は読めた項目を表示する）
        const c = result.card;
        const k = keyColumns(result.keys);
        await env.DB.prepare(
          `UPDATE cards SET status = 'failed', company = ?, department = ?, title = ?, name = ?, name_reading = ?,
             phones = ?, mobiles = ?, emails = ?, note = ?, raw_text = ?,
             company_n = ?, name_n = ?, reading_n = ?, department_n = ?, phones_digits = ?, emails_n = ?, title_n = ?, note_n = ?,
             failure = ?, extraction = ?, updated_at = ?, version = version + 1
           WHERE id = ?`,
        )
          .bind(
            c.company, c.department, c.title, c.name, c.nameReading,
            JSON.stringify(c.phones), JSON.stringify(c.mobiles), JSON.stringify(c.emails), c.note, c.rawText,
            k.company_n, k.name_n, k.reading_n, k.department_n, k.phones_digits, k.emails_n, k.title_n, k.note_n,
            JSON.stringify(failureFor('truncated')), extraction, at, cardId,
          )
          .run();
      } else {
        await env.DB.prepare(
          `UPDATE cards SET status = 'failed', failure = ?, extraction = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
        )
          .bind(JSON.stringify(failureFor(failureKind ?? 'provider')), extraction, at, cardId)
          .run();
      }

      const ok = !failureKind;
      await recordUsage(env, {
        id: `scan:${event.instanceId}`,
        kind: 'card',
        userId,
        modelId: cfg.model?.id,
        model: cfg.model,
        ok,
        failureKind,
        inputTokens: tokens.inputTokens,
        outputTokens: tokens.outputTokens,
        at,
      });
      if (type === 'rescan') {
        await env.DB.prepare(
          `INSERT OR IGNORE INTO card_history (id, card_id, type, actor_id, actor_name, source, changes, at)
           VALUES (?, ?, 'rescan', ?, ?, '', ?, ?)`,
        )
          .bind(`rescan-${event.instanceId}`, cardId, userId, userName, JSON.stringify([{ field: 'result', before: '', after: ok ? 'success' : failureKind }]), at)
          .run();
      }
    });

    // 6. 預けたファイルを消す。失敗しても読み取りの結果には影響しない
    if (files.length) {
      await step.do('cleanup-files', async () => {
        const apiKey = await getApiKey(env, 'gemini');
        if (!apiKey) return;
        for (const f of files) await deleteFromFilesApi({ apiKey, name: f.name });
      });
    }
  }
}
