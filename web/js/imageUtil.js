// 名刺の写真をブラウザで縮小してからアップロードする（通信量と読み取り費用を抑えるため）。
import { api } from './api.js';

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
