// 利用量の記録（usage_events と usage_monthly）と、監査ログ。
//
// usage の kind の決まり（議事録側も同じ名前で記録する。/api/dev/usage* の集計がこれに依存する）:
//   card              名刺の読み取り（再生成を含む）
//   recording         録音 1 本（count=1、seconds=録音の長さ）
//   transcribe        文字起こし（初回）        seconds=Gemini / OpenAI に渡した音声の長さ
//   transcribe_retry  文字起こしのやり直し
//   summarize         議事録の作成（初回）
//   summarize_retry   議事録の作り直し
//   qa                議事録への質問（1 往復で 1 件。minutes-design.md §16）
// 失敗した呼び出しは ok=false で同じ kind に記録する（usage_monthly.failed が増える）。
import { estimateCost, monthKey, ulid } from '../core.js';
import { nowIso } from './time.js';

export const MINUTES_USAGE_KINDS = ['recording', 'transcribe', 'transcribe_retry', 'summarize', 'summarize_retry', 'qa'];

/**
 * @param o.id 同じ呼び出しを二重に数えないための ID（Workflow のステップ再実行対策）。省略で新規
 * @param o.model 単価の計算に使うモデル（pricing 付き）。cost が渡されていればそれを使う
 * core の usageEvent() の結果（kind: 'record' | 'transcribe' | 'summarize' | 'card' | 'test'、retry、audioSeconds）も
 * そのまま受け取る。'record' は 'recording'、retry 付きの文字起こし / 議事録は '_retry' の付いた kind に直して数える。
 */
export async function recordUsage(env, input) {
  const o = { ...input };
  if (o.kind === 'record') o.kind = 'recording';
  if (o.retry && (o.kind === 'transcribe' || o.kind === 'summarize')) o.kind += '_retry';
  if (o.seconds === undefined) o.seconds = o.audioSeconds ?? 0;
  const at = o.at ?? nowIso();
  const inputTokens = o.inputTokens ?? 0;
  const outputTokens = o.outputTokens ?? 0;
  const seconds = Math.round(o.seconds ?? 0);
  let cost = typeof o.cost === 'number' ? o.cost : 0;
  if (typeof o.cost !== 'number' && o.model && (inputTokens || outputTokens || seconds)) {
    try {
      cost = estimateCost({ model: o.model, inputTokens, outputTokens, audioSeconds: o.kind.startsWith('transcribe') ? seconds : 0, date: at });
    } catch {
      cost = 0;
    }
  }
  const ok = o.ok !== false;
  const ins = await env.DB.prepare(
    `INSERT OR IGNORE INTO usage_events (id, at, user_id, kind, duration_sec, model_id, ok, failure_kind, input_tokens, output_tokens, cost)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(o.id ?? ulid(), at, o.userId, o.kind, seconds, o.modelId ?? null, ok ? 1 : 0, o.failureKind ?? null, inputTokens, outputTokens, cost)
    .run();
  if (!ins.meta.changes) return; // 記録済み
  await env.DB.prepare(
    `INSERT INTO usage_monthly (year_month, user_id, kind, count, failed, seconds, input_tokens, output_tokens, cost, last_used_at)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(year_month, user_id, kind) DO UPDATE SET
       count = count + 1, failed = failed + excluded.failed, seconds = seconds + excluded.seconds,
       input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens,
       cost = cost + excluded.cost, last_used_at = excluded.last_used_at`,
  )
    .bind(monthKey(new Date(at)), o.userId, o.kind, ok ? 0 : 1, seconds, inputTokens, outputTokens, cost, at)
    .run();
}

// 監査ログ（docs/design.md §11 の操作）。detail に名刺の内容・API キー・パスワードを入れない
export async function audit(env, actorId, action, detail = {}) {
  await env.DB.prepare('INSERT INTO audit_log (id, at, actor_id, action, detail) VALUES (?, ?, ?, ?, ?)')
    .bind(ulid(), nowIso(), actorId ?? null, action, JSON.stringify(detail))
    .run();
}
