// 名刺の写真をブラウザで縮小してからアップロードする（通信量と読み取り費用を抑えるため）。
import { api } from './api.js';
import { getAuthHeader } from './auth.js';

async function loadBitmap(file) {
  // 端末によっては写真が横倒しで入るので、EXIF の向きを反映して読む。
  if (window.createImageBitmap) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* 下の方法で読み直す */ }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('画像を読み込めませんでした。別の写真をお試しください。'));
      img.src = url;
    });
  } finally { setTimeout(() => URL.revokeObjectURL(url), 10_000); }
}

function toBlob(canvas, quality) {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('画像を変換できませんでした。'))), 'image/jpeg', quality));
}

// 長辺 maxEdge に収まる JPEG にする。
export async function resizeToJpeg(source, maxEdge, quality) {
  const bmp = source instanceof Blob ? await loadBitmap(source) : source;
  const w = bmp.width, h = bmp.height;
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  if (bmp.close) bmp.close();
  return toBlob(canvas, quality);
}

// 表面（必須）と裏面（任意）から、front / thumb / back の Blob を作る。
export async function prepareImages(frontFile, backFile) {
  const bmp = await loadBitmap(frontFile);
  const thumb = await resizeToJpeg(bmp, 320, 0.8);
  // bmp は resizeToJpeg が閉じるので、front は読み直す。
  const front = await resizeToJpeg(frontFile, 1600, 0.85);
  const out = { front, thumb };
  if (backFile) out.back = await resizeToJpeg(backFile, 1600, 0.85);
  return out;
}

// アップロード先をもらって PUT し、kind ごとの key を返す。
export async function uploadImages(blobs) {
  const kinds = Object.keys(blobs);
  const { uploads } = await api.post('/api/uploads', { kinds });
  const keys = {};
  await Promise.all(uploads.map(async (u) => {
    await api.upload(u.url, blobs[u.kind], u.headers || { 'Content-Type': 'image/jpeg' });
    keys[u.kind] = u.key;
  }));
  return keys;
}

// ---- 確認済みの名刺の画像を、保管用に攻めて縮小する ----
// 読み取りが済んだ後の画像は、見返す用途しか無い。容量を減らすため、ブラウザで縮小して同じ場所に上書きする。
// サーバーは画像を触らない（Cloudflare 版の CPU 時間の制約のため）。
const STORE_EDGE = 900;
const STORE_QUALITY = 0.4;
// 縮小しても 1 割も減らないなら上書きしない。縮小済みの画像を作り直して劣化させないため
const MIN_GAIN = 0.9;

// createImageBitmap は Safari が古い場合や HEIC などで失敗するので、loadBitmap（<img> での読み込みに戻る）を通す。
// 向きは EXIF を反映済み。canvas は 900px までなので iOS の canvas の大きさの上限にも掛からない。
export function shrinkForStorage(blob) {
  return resizeToJpeg(blob, STORE_EDGE, STORE_QUALITY);
}

async function fetchImage(url) {
  // 自分のサーバーの画像（Cloudflare 版）だけ認証を付ける。S3 の署名付き URL に付けると署名が合わなくなる
  const headers = url.startsWith('/') ? await getAuthHeader() : {};
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`画像を取得できませんでした（${res.status}）`);
  return res.blob();
}

// 同じ名刺で同時に 2 回走らせない
const running = new Set();

// 成功（縮小済みの印を付けた）なら true。失敗しても投げない。次に詳細画面を開いたときにやり直す。
export async function optimizeCardImages(card, client = api) {
  if (!card || !card.id || running.has(card.id)) return false;
  running.add(card.id);
  try {
    const urls = card.imageUrls || {};
    const shrunk = {};
    for (const kind of ['front', 'back']) {
      if (!urls[kind]) continue;
      const original = await fetchImage(urls[kind]);
      const small = await shrinkForStorage(original);
      if (small.size < original.size * MIN_GAIN) shrunk[kind] = small;
    }
    const id = encodeURIComponent(card.id);
    if (Object.keys(shrunk).length) {
      const { uploads } = await client.post(`/api/cards/${id}/images/replace`);
      // 片方だけ書けた場合は印を付けない。やり直しは MIN_GAIN で二重の劣化を防ぐ
      for (const u of uploads || []) {
        if (shrunk[u.kind]) await client.upload(u.url, shrunk[u.kind], u.headers || { 'Content-Type': 'image/jpeg' });
      }
    }
    await client.post(`/api/cards/${id}/images/optimized`);
    return true;
  } catch (e) {
    // 名刺の内容は出さない。メッセージだけ
    console.warn('画像の縮小を見送りました:', e && e.message);
    return false;
  } finally {
    running.delete(card.id);
  }
}
