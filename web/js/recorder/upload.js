// 区切り 1 つ（と通しの 1 本）を送る処理。segmenter と recovery が同じ手順を使う。
// api は { post, put, upload } を持つオブジェクト。画面では api.js のものを、確認ページでは差し替えたものを渡す。

// MediaRecorder の mimeType は codecs 付きなので、契約どおり種類だけにする。
export function baseMime(mime) {
  return String(mime || 'audio/webm').split(';')[0].trim();
}

export async function uploadSegment(api, minuteId, seg) {
  const mime = baseMime(seg.mime);
  const target = await api.post(`/api/minutes/${minuteId}/segments`, {
    seq: seg.seq, mime, startSec: seg.startSec, durationSec: seg.durationSec, size: seg.blob.size,
  });
  await api.upload(target.url, seg.blob, target.headers || { 'Content-Type': mime });
  await api.put(`/api/minutes/${minuteId}/segments/${seg.seq}/done`);
}

// Cloudflare 版だけ。本文は契約に明記が無いので segments と揃えた形にしている。
export async function uploadFullAudio(api, minuteId, blob, mime, durationSec) {
  const m = baseMime(mime);
  const target = await api.post(`/api/minutes/${minuteId}/full-audio`, { mime: m, durationSec, size: blob.size });
  await api.upload(target.url, blob, target.headers || { 'Content-Type': m });
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
