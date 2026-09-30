// 利用量の記録（docs/design.md §6.1、docs/minutes-design.md §7.2、§10.1）。
// 一覧を出すたびに集計し直さなくて済むよう、記録するときにその月の合計へ足していく。
//
// 受け取る evt は core の usageEvent の形（kind, userId, modelId, inputTokens, outputTokens,
// audioSeconds, ok, failureKind, at, month）に、次の任意項目を足したもの。
//   retry:    true なら「やり直し」として数える（文字起こし、議事録の作成）
//   cost:     USD。無ければ、モデルの単価から概算する
//   kind:     'card' | 'transcribe' | 'summarize' | 'test' | 'recording'
//   'recording' は録音を終えたときに app が記録する（audioSeconds に録音時間）
//
// DynamoDB の項目:
//   USAGE#<月> / USE#<kind>#<モデルID>         用途ごと・モデルごとの合計
//   USAGE#<月> / MINUTES#USER#<メール>         ユーザーごとの合計（議事録の分だけ）
//   USAGE#<月> / MINLOG#<日時>#<乱数>          1 回ごとの記録（2 年で消える）。議事録の ID もタイトルも入れない
import { DEFAULT_MODELS, estimateCost } from '@hyper-sfa/core';
import { ddb } from './ddb.js';
import { K } from './keys.js';

const LOG_TTL_SEC = 2 * 365 * 24 * 3600;
const MINUTES_KINDS = new Set(['transcribe', 'summarize', 'recording']);

async function costOf(evt) {
  if (typeof evt.cost === 'number') return evt.cost;
  if (!evt.modelId || evt.kind === 'recording') return 0;
  try {
    const k = K.model(evt.modelId);
    const stored = await ddb.get(k.pk, k.sk);
    const fallback = DEFAULT_MODELS.find((m) => m.id === evt.modelId);
    const model = { ...(fallback ?? {}), ...(stored ?? {}) };
    if (!model.pricing) return 0;
    return estimateCost({
      model, inputTokens: evt.inputTokens, outputTokens: evt.outputTokens, audioSeconds: evt.audioSeconds, date: evt.at,
    });
  } catch {
    // 概算費用が出せなくても回数は記録する
    return 0;
  }
}

export async function recordUsage(evt) {
  const at = evt.at ?? new Date().toISOString();
  const month = evt.month ?? at.slice(0, 7);
  const kind = evt.kind ?? 'unknown';
  const ok = evt.ok !== false;
  const inputTokens = evt.inputTokens || 0;
  const outputTokens = evt.outputTokens || 0;
  const audioSeconds = evt.audioSeconds || evt.durationSec || 0;
  const cost = await costOf(evt);
  const ops = [];

  if (kind !== 'recording') {
    const k = K.usage(month, `USE#${kind}#${evt.modelId ?? 'unknown'}`);
    ops.push(ddb.update(k.pk, k.sk, {
      set: { kind, modelId: evt.modelId ?? null },
      add: { count: 1, failed: ok ? 0 : 1, inputTokens, outputTokens, audioSeconds, cost },
    }));
  }

  if (MINUTES_KINDS.has(kind) && evt.userId) {
    const email = String(evt.userId).toLowerCase();
    const k = K.usage(month, `MINUTES#USER#${email}`);
    const add = { inputTokens, outputTokens, cost };
    if (!ok) add.failed = 1;
    if (kind === 'recording') {
      add.recordings = 1;
      add.recordedSec = audioSeconds;
    } else if (kind === 'transcribe') {
      add[evt.retry ? 'transcribeRetry' : 'transcribeFirst'] = 1;
      add.transcribedSec = audioSeconds;
    } else {
      add[evt.retry ? 'summarizeRetry' : 'summarizeFirst'] = 1;
    }
    ops.push(ddb.update(k.pk, k.sk, { set: { lastUsedAt: at }, add }));

    const id = Math.random().toString(36).slice(2, 10);
    const logSk = `MINLOG#${at}#${id}`;
    ops.push(ddb.put({
      ...K.usage(month, logSk),
      userId: email,
      kind,
      retry: Boolean(evt.retry),
      durationSec: audioSeconds,
      modelId: evt.modelId ?? null,
      ok,
      failureKind: ok ? null : (evt.failureKind ?? 'unknown'),
      inputTokens,
      outputTokens,
      cost,
      at,
      // 1 人分の記録を新しい順に読むための索引（履歴と同じ gsi2 の属性名を使う）
      gsi2pk: `MINUSER#${email}`,
      gsi2sk: `${at}#${id}`,
      ttl: Math.floor(Date.parse(at) / 1000) + LOG_TTL_SEC,
    }));
  }

  await Promise.all(ops);
}
