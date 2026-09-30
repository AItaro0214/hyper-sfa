// 「今この議事録に generate / regenerate を受け付けてよいか」の判定。D1 にも Workflows にも触れない純粋な関数。
// なぜ切り出すか: 音声の期限切れ、処理中の二重起動、止まった処理の引き継ぎなど、分岐が多いので単体で確かめたい。
import { HttpError, validationError } from './errors.js';
import { safeJson, audioState } from './store.js';

export const STALE_MS = 20 * 60 * 1000; // 20 分動きが無い処理は失敗扱いにして再開できるようにする（設計書 §5.4）
const IN_PROGRESS = new Set(['queued', 'transcribing', 'summarizing']);

export function isInProgress(row) {
  return IN_PROGRESS.has(row.status);
}
export function isStale(row, now = new Date()) {
  return isInProgress(row) && now.getTime() - new Date(row.updated_at).getTime() > STALE_MS;
}

/**
 * @param {object} row minutes の行
 * @param {{ mode: 'generate'|'regenerate', target?: string }} req
 * @returns {{ target: 'generate'|'summary'|'transcript', takeover: boolean }}
 * @throws HttpError 開始できないとき
 */
export function planStart(row, req, now = new Date()) {
  if (row.status === 'recording') throw validationError('録音がまだ終わっていません');
  const stale = isStale(row, now);
  if (isInProgress(row) && !stale) throw new HttpError(409, 'conflict', '処理中です。しばらくお待ちください');

  let target;
  if (req.mode === 'generate') {
    if (row.status === 'done') throw new HttpError(409, 'conflict', 'すでに作成済みです。作り直すときは「議事録を作り直す」を押してください');
    // 議事録の作成だけ失敗していたなら、文字起こしは残っているので議事録だけをやり直す
    const failure = safeJson(row.failure);
    target = row.transcript_key && failure?.step === 'summarize' ? 'summary' : 'generate';
  } else {
    if (req.target !== 'summary' && req.target !== 'transcript') {
      throw validationError('target は summary か transcript です', [{ field: 'target', message: 'summary か transcript を指定してください' }]);
    }
    target = req.target;
    if (target === 'summary' && !row.transcript_key) throw validationError('文字起こしがありません');
  }
  // 音声が要るのは文字起こしをやるとき。7 日を過ぎていたら断る
  if (target !== 'summary' && !audioState(row, now).available) throw validationError('音声は削除されました');
  return { target, takeover: stale };
}
