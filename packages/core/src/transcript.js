// 文字起こしの結合（docs/minutes-design.md §5.2）。
// 文字起こしは 10 分の区切りごとに行い、区切りの中での時刻（先頭が 00:00）を出させる。
// 区切りの開始時刻を足して、通しの時刻にそろえる。

const pad = (n) => String(n).padStart(2, '0');

function formatHms(totalSec) {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/**
 * 行頭の `[分:秒]`（または `[時:分:秒]`）に offsetSec を足し、`[時:分:秒]` にそろえる。
 * 行頭だけを見るのは、発言の中の `[10:00]` のような文字を書き換えないため。
 */
export function offsetTimestamps(text, offsetSec) {
  const offset = Math.round(Number(offsetSec) || 0);
  return String(text ?? '').replace(/^([ \t]*)\[(\d{1,3}):(\d{2})(?::(\d{2}))?\]/gm, (_, lead, a, b, c) => {
    const sec = c === undefined ? Number(a) * 60 + Number(b) : Number(a) * 3600 + Number(b) * 60 + Number(c);
    return `${lead}[${formatHms(sec + offset)}]`;
  });
}

// 会話が無い区切りに付く記録。通しの文字起こしには入れない
const NO_SPEECH = /^[（(]\s*会話なし\s*[)）]$/;

/**
 * 区切りごとの結果を、通しの文字起こしにする。開始時刻の順に並べ、時刻を通しにそろえる。
 * @param {Array<{ startSec: number, text: string }>} segments
 */
export function joinSegments(segments) {
  return [...(segments ?? [])]
    .sort((x, y) => (x.startSec ?? 0) - (y.startSec ?? 0))
    .map((seg) => offsetTimestamps(String(seg.text ?? '').trim(), seg.startSec ?? 0))
    .filter((text) => text && !NO_SPEECH.test(text))
    .join('\n');
}
