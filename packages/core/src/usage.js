// 利用量の記録（docs/minutes-design.md §7.2、§10.1）。
// 議事録のタイトルや本文は入れない。開発コンソールから議事録の中身にたどれないようにするため。

const pad = (n) => String(n).padStart(2, '0');

/** '2026-10'。月の切り替えは UTC で数える。 */
export function monthKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

/**
 * 利用の記録の正規形。kind は 'card' 'transcribe' 'summarize' 'test' など。
 * ok が false のときだけ failureKind を持つ。retry は「やり直し」（再生成）かどうか。利用状況の一覧で初回と分けて数える。
 */
export function usageEvent({ kind, userId, modelId, inputTokens = 0, outputTokens = 0, audioSeconds = 0, ok = true, failureKind = null, retry = false, at } = {}) {
  const when = at instanceof Date ? at : at ? new Date(at) : new Date();
  return {
    kind: kind ?? null,
    userId: userId ?? null,
    modelId: modelId ?? null,
    inputTokens: Number(inputTokens) || 0,
    outputTokens: Number(outputTokens) || 0,
    audioSeconds: Number(audioSeconds) || 0,
    ok: Boolean(ok),
    retry: Boolean(retry),
    failureKind: ok ? null : failureKind ?? 'unknown',
    at: when.toISOString(),
    month: monthKey(when),
  };
}
