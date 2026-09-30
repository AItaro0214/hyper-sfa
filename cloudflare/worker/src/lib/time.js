// 日時の扱い。保存は ISO 8601（UTC）。日付の区切りだけは日本時間で数える。
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export const nowIso = () => new Date().toISOString();

export function addDays(iso, days) {
  return new Date(new Date(iso).getTime() + days * 86400000).toISOString();
}

export function addMinutes(iso, minutes) {
  return new Date(new Date(iso).getTime() + minutes * 60000).toISOString();
}

// 1 日の上限の数え方に使う日付（日本時間の YYYY-MM-DD）
export function jstDay(date = new Date()) {
  return new Date(date.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

// 'YYYY-MM-DD'（日本時間の 0 時）→ UTC の ISO。不正なら null
export function jstDayStart(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd ?? '')) return null;
  const d = new Date(`${ymd}T00:00:00+09:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// 「to を含む」検索の上端（排他）に使う、翌日の 0 時（日本時間）
export function jstNextDayStart(ymd) {
  const s = jstDayStart(ymd);
  return s ? addDays(s, 1) : null;
}

// 'YYYY-MM' → その月の初日 0 時（日本時間）の ISO。不正なら null
export function jstMonthStart(ym) {
  if (!/^\d{4}-\d{2}$/.test(ym ?? '')) return null;
  return jstDayStart(`${ym}-01`);
}

export function jstNextMonthStart(ym) {
  if (!/^\d{4}-\d{2}$/.test(ym ?? '')) return null;
  const [y, m] = ym.split('-').map(Number);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return jstDayStart(`${ny}-${String(nm).padStart(2, '0')}-01`);
}

export function safeJson(text, fallback) {
  try {
    return text == null || text === '' ? fallback : JSON.parse(text);
  } catch {
    return fallback;
  }
}
