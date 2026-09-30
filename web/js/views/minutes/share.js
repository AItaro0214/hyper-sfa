// 共有の画面（minutes-design §8）。同席者を上に出し、氏名や部署で絞って選ぶ。
import { api } from '../../api.js';
import { state } from '../../state.js';
import { toast } from '../../ui.js';
import { esc, showModal, itemsOf, deptNames, errMessage, ask } from './util.js';
import { loadDirectory } from './pickers.js';

const MAX_PER_SHARE = 50; // api-contract §9

/** 共有の画面を開く。共有が変わったら onChanged() を呼ぶ。 */
export async function openShareDialog(minute, onChanged) {
  const m = showModal({
    title: '共有する相手を選ぶ',
    wide: true,
    html: '<p class="mn-muted">読み込んでいます…</p>',
  });
  let users = [];
  let shares = [];
  try {
    const [dir, sh] = await Promise.all([loadDirectory(), api.get(`/api/minutes/${minute.id}/shares`)]);
    users = dir;
    shares = itemsOf(sh);
  } catch (e) {
    m.body.innerHTML = `<p class="mn-error">${esc(errMessage(e))}</p>`;
    return;
  }
  const me = state.me || {};
  const attendeeIds = (minute.attendees || []).map((a) => a.id);
  const sel = new Set();

  m.body.innerHTML = `
    <div data-r="current"></div>
    <input class="mn-input" type="search" data-f="q" placeholder="氏名や部署で探す" autocomplete="off">
    <div data-r="quick"></div>
    <div class="mn-user-list" data-r="list"></div>
    <div class="mn-row mn-end"><span class="mn-muted" data-r="count"></span>
      <button class="mn-btn" data-close="1">閉じる</button>
      <button class="mn-btn mn-btn-primary" data-ok="1" disabled>共有する</button></div>`;
  const cur = m.body.querySelector('[data-r=current]');
  const quick = m.body.querySelector('[data-r=quick]');
  const listEl = m.body.querySelector('[data-r=list]');
  const countEl = m.body.querySelector('[data-r=count]');
  const okBtn = m.body.querySelector('[data-ok]');
  const q = m.body.querySelector('[data-f=q]');

  const sharedIds = () => new Set(shares.map((s) => s.id));
  const paintCurrent = () => {
    cur.innerHTML = shares.length ? `<div class="mn-label">共有している人</div><div class="mn-chips">${shares.map((s) => `<span class="mn-tag">${esc(s.name)}<button type="button" data-unshare="${esc(s.id)}" aria-label="共有を取り消す">×</button></span>`).join('')}</div>` : '<p class="mn-muted">まだ誰にも共有していません。</p>';
  };
  const candidates = () => users.filter((u) => u.id !== me.id && u.id !== (minute.owner && minute.owner.id) && !sharedIds().has(u.id));
  const paintQuick = () => {
    const c = candidates().filter((u) => attendeeIds.includes(u.id));
    quick.innerHTML = c.length ? `<div class="mn-muted">同席者から選ぶ</div><div class="mn-chips">${c.map((u) => `<button type="button" class="mn-chip-btn${sel.has(u.id) ? ' on' : ''}" data-id="${esc(u.id)}">${esc(u.displayName)}</button>`).join('')}</div>` : '';
  };
  const paintCount = () => {
    countEl.textContent = `${sel.size} 人選択中`;
    okBtn.disabled = sel.size === 0 || sel.size > MAX_PER_SHARE;
  };
  const paintList = () => {
    const kw = q.value.trim().toLowerCase();
    const first = new Set(attendeeIds);
    const rows = candidates().filter((u) => !kw || `${u.displayName} ${deptNames(u)}`.toLowerCase().includes(kw))
      .sort((a, b) => (first.has(b.id) ? 1 : 0) - (first.has(a.id) ? 1 : 0));
    listEl.innerHTML = rows.length ? rows.map((u) => `<label class="mn-user"><input type="checkbox" value="${esc(u.id)}" ${sel.has(u.id) ? 'checked' : ''}><span><strong>${esc(u.displayName)}</strong> <span class="mn-muted">${esc(deptNames(u))}</span>${first.has(u.id) ? ' <em class="mn-badge">同席者</em>' : ''}</span></label>`).join('') : '<p class="mn-muted">選べる人がいません。</p>';
  };
  const paintAll = () => { paintCurrent(); paintQuick(); paintList(); paintCount(); };
  paintAll();

  q.addEventListener('input', paintList);
  listEl.addEventListener('change', (e) => {
    const i = e.target.closest('input[type=checkbox]');
    if (!i) return;
    if (i.checked) sel.add(i.value); else sel.delete(i.value);
    paintQuick(); paintCount();
  });
  quick.addEventListener('click', (e) => {
    const b = e.target.closest('[data-id]');
    if (!b) return;
    if (sel.has(b.dataset.id)) sel.delete(b.dataset.id); else sel.add(b.dataset.id);
    paintQuick(); paintList(); paintCount();
  });
  cur.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-unshare]');
    if (!b) return;
    const target = shares.find((s) => s.id === b.dataset.unshare);
    if (!(await ask(`${target ? target.name : 'この人'}への共有を取り消します。すぐに見られなくなります。`, { okLabel: '取り消す', danger: true }))) return;
    try {
      await api.del(`/api/minutes/${minute.id}/shares/${b.dataset.unshare}`);
      shares = shares.filter((s) => s.id !== b.dataset.unshare);
      paintAll();
      toast('共有を取り消しました');
      if (onChanged) onChanged();
    } catch (err) { toast(errMessage(err)); }
  });
  okBtn.addEventListener('click', async () => {
    okBtn.disabled = true;
    try {
      await api.post(`/api/minutes/${minute.id}/shares`, { userIds: [...sel] });
      toast(`${sel.size} 人に共有しました`);
      if (onChanged) onChanged();
      m.close();
    } catch (err) {
      toast(errMessage(err));
      paintCount();
    }
  });
}
