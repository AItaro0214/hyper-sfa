// 前回の録音が残っていたら送れるようにする。ブラウザが落ちた、電池が切れた、通信が切れたままタブを閉じた、の後始末。
import { listPending, readSegmentBlob, deleteSegment, deleteMinute, isActive } from './store.js';
import { uploadSegment } from './upload.js';

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 別のタブで録音中のものは対象外にしたいが、確実に知る手段が無い。
// 同じタブで録音中のものだけ除く（別タブの録音中に開いた場合は、利用者が「捨てる」を選ばなければ害は無い）。
export async function findRecoverable() {
  let rows;
  try { rows = await listPending(); } catch { return []; }
  const byMinute = new Map();
  for (const r of rows) {
    if (isActive(r.minuteId)) continue;
    const e = byMinute.get(r.minuteId) || { minuteId: r.minuteId, segments: [] };
    e.segments.push(r);
    byMinute.set(r.minuteId, e);
  }
  return [...byMinute.values()];
}

export async function sendRecovered(api, item, onProgress) {
  // 議事録が消えていたら送れないので、残りを消して終える
  let minute;
  try {
    minute = await api.get(`/api/minutes/${item.minuteId}`);
  } catch (e) {
    if (e && (e.status === 404 || e.status === 403)) { await deleteMinute(item.minuteId); return { gone: true }; }
    throw e;
  }
  let done = 0;
  for (const s of item.segments) {
    const seg = await readSegmentBlob(item.minuteId, s.seq);
    if (seg && seg.blob.size > 0) {
      await uploadSegment(api, item.minuteId, { seq: s.seq, ...seg });
    }
    await deleteSegment(item.minuteId, s.seq);
    done += 1;
    if (onProgress) onProgress(done, item.segments.length);
  }
  if (minute.status === 'recording') {
    const last = item.segments[item.segments.length - 1];
    const durationSec = Math.max(minute.durationSec || 0, Math.round((last.startSec || 0) + last.ms / 1000));
    // 区切りの番号は 1 から連続なので、最大の番号が本数になる
    await api.post(`/api/minutes/${item.minuteId}/finish`, { durationSec, segments: last.seq });
  }
  return { gone: false, status: minute.status };
}

/**
 * container の先頭に「前回の録音が残っています」を出す。
 * navigate(path) は送り終えた後に議事録の画面へ進むために使う。
 */
export async function checkRecovery(container, { api, navigate }) {
  const items = await findRecoverable();
  if (!items.length || !container.isConnected) return;
  const box = document.createElement('div');
  box.className = 'mn-recovery';
  container.prepend(box);

  const render = () => {
    box.innerHTML = items.map((it, i) => {
      const min = Math.max(1, Math.round(it.segments.reduce((a, s) => a + s.ms, 0) / 60000));
      return `<div class="mn-recovery-item" data-i="${i}">
        <div><strong>前回の録音が残っています</strong><div class="mn-muted">送れていない録音が約 ${min} 分あります（${it.segments.length} 個の区切り）。</div><div class="mn-recovery-msg mn-muted"></div></div>
        <div class="mn-row"><button class="mn-btn mn-btn-primary" data-act="send">送る</button><button class="mn-btn" data-act="drop">捨てる</button></div>
      </div>`;
    }).join('');
  };
  render();

  box.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-act]');
    if (!btn) return;
    const row = btn.closest('.mn-recovery-item');
    const item = items[Number(row.dataset.i)];
    const msg = row.querySelector('.mn-recovery-msg');
    if (btn.dataset.act === 'drop') {
      if (!window.confirm('残っている録音を捨てます。元に戻せません。よろしいですか。')) return;
      await deleteMinute(item.minuteId).catch(() => {});
      row.remove();
      return;
    }
    row.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    msg.textContent = '送っています…';
    try {
      const r = await sendRecovered(api, item, (d, n) => { msg.textContent = `送っています（${d} / ${n}）`; });
      if (r.gone) { msg.textContent = 'この議事録は既に無いため、残りを消しました。'; return; }
      msg.textContent = '送りました。';
      if (navigate) navigate(`/minutes/${item.minuteId}`);
    } catch (e) {
      msg.textContent = `送れませんでした（${escHtml((e && e.message) || '通信の失敗')}）。通信を確かめて、もう一度押してください。`;
      row.querySelectorAll('button').forEach((b) => { b.disabled = false; });
    }
  });
}
