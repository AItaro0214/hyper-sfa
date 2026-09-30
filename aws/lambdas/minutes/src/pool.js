// 同時実行数を絞って順に処理する。worker の失敗は結果に入れ、ほかの区切りは止めない
// （成功した区切りの結果を残して、失敗した所だけやり直せるようにするため）。
// shouldStop() が true を返したら、新しい項目は始めない（API キーが無効なときに無駄な呼び出しをしない）。
export async function runPool(items, limit, worker, shouldStop = () => false) {
  const results = new Array(items.length).fill(null);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      if (shouldStop()) return;
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = { ok: true, value: await worker(items[i], i) };
      } catch (error) {
        results[i] = { ok: false, error };
      }
    }
  });
  await Promise.all(runners);
  return results; // 始めなかった項目は null
}
