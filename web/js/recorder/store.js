// 録音の途中保存（IndexedDB）。ブラウザが落ちても、送り終えていない分を次に開いたときに送れるようにするため。
// キーは { minuteId, seq, index } の複合。値に mime / startSec / ms（区切りの先頭からの経過ミリ秒）も持たせ、
// 復旧のときにサーバーへ渡す情報をここだけから作れるようにしている。

const DB_NAME = 'hyper-sfa-recording';
const STORE = 'chunks';

// 同じタブで録音中の議事録。復旧の対象から外すために使う。
const activeMinutes = new Set();
export function markActive(minuteId, on) {
  if (on) activeMinutes.add(minuteId);
  else activeMinutes.delete(minuteId);
}
export function isActive(minuteId) {
  return activeMinutes.has(minuteId);
}

let dbPromise = null;
function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB が使えません'));
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE, { keyPath: ['minuteId', 'seq', 'index'] });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    // 失敗したら次回また開き直せるようにする
    dbPromise.catch(() => { dbPromise = null; });
  }
  return dbPromise;
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putChunk(rec) {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const done = new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
  tx.objectStore(STORE).put(rec);
  await done;
}

export async function deleteSegment(minuteId, seq) {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const done = new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  tx.objectStore(STORE).delete(IDBKeyRange.bound([minuteId, seq, 0], [minuteId, seq, Infinity]));
  await done;
}

export async function deleteMinute(minuteId) {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const done = new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  tx.objectStore(STORE).delete(IDBKeyRange.bound([minuteId, 0, 0], [minuteId, Infinity, Infinity]));
  await done;
}

// 区切りの Blob を結合して返す。
export async function readSegmentBlob(minuteId, seq) {
  const db = await openDb();
  const rows = await wrap(db.transaction(STORE).objectStore(STORE)
    .getAll(IDBKeyRange.bound([minuteId, seq, 0], [minuteId, seq, Infinity])));
  if (!rows.length) return null;
  rows.sort((a, b) => a.index - b.index);
  const mime = rows[0].mime || 'audio/webm';
  return { blob: new Blob(rows.map((r) => r.blob), { type: mime }), mime, startSec: rows[0].startSec || 0, durationSec: Math.round(Math.max(...rows.map((r) => r.ms || 0)) / 1000) };
}

// 送り終えていない区切りの一覧（Blob は読まない）。
export async function listPending() {
  const db = await openDb();
  const found = new Map();
  await new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve();
      const v = cur.value;
      const k = v.minuteId + '\u0000' + v.seq;
      const e = found.get(k) || { minuteId: v.minuteId, seq: v.seq, chunks: 0, startSec: v.startSec || 0, ms: 0 };
      e.chunks += 1;
      e.ms = Math.max(e.ms, v.ms || 0);
      found.set(k, e);
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });
  return [...found.values()].sort((a, b) => (a.minuteId < b.minuteId ? -1 : a.minuteId > b.minuteId ? 1 : a.seq - b.seq));
}
