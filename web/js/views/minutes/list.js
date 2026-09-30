// /minutes 議事録の一覧。検索欄は描き直しの範囲の外に置き、入力中の文字を失わないようにする。
import { api } from '../../api.js';
import { navigate } from '../../router.js';
import { formatDateTime } from '../../ui.js';
import { esc, statusChipHtml, clock, counterpartLabel, toQuery, itemsOf, errMessage, deptNames } from './util.js';
import { pickCard, loadDirectory } from './pickers.js';
import { checkRecovery } from '../../recorder/recovery.js';
import { hasActiveSession } from './new.js';

const TABS = [['owner', '自分が作った'], ['shared', '共有された'], ['all', 'すべて']];

// 戻ってきたときに条件を保つ
const saved = { relation: 'all', company: '', name: '', cardId: '', cardLabel: '', attendee: '', from: '', to: '', title: '', owner: '' };

export function renderList(container, _params, query = {}) {
  // 名刺の画面などから ?cardId= で来たとき
  if (query && query.cardId) { saved.cardId = query.cardId; saved.cardLabel = query.label || '選んだ名刺'; }
  const f = saved;
  let seq = 0; // 古い応答で新しい結果を上書きしない
  let dirUsers = null;

  container.innerHTML = `
    <div class="mn-page">
      <div class="mn-head"><h1>議事録</h1><a class="mn-btn mn-btn-primary" href="#" data-go="/minutes/new">🎙 議事録を作る</a></div>
      ${hasActiveSession() ? '<div class="mn-alert mn-alert-warn">録音中です。<a href="/minutes/new">録音の画面に戻る</a></div>' : ''}
      <div class="mn-tabs" role="tablist">${TABS.map(([k, l]) => `<button role="tab" class="mn-tab" data-tab="${k}">${l}</button>`).join('')}</div>
      <form class="mn-search" data-f="search">
        <label>相手の会社名 <input class="mn-input" name="company" autocomplete="off"></label>
        <label>相手の氏名 <input class="mn-input" name="name" autocomplete="off"></label>
        <button type="button" class="mn-btn" data-pick>名刺から選ぶ</button>
        <button type="submit" class="mn-btn mn-btn-primary">検索</button>
        <details class="mn-fold mn-fold-wide" data-more>
          <summary>その他の条件で絞る</summary>
          <div class="mn-more">
            <label>自社の同席者 <select class="mn-input" name="attendee"><option value="">指定なし</option></select></label>
            <label>期間（から） <input class="mn-input" type="date" name="from"></label>
            <label>期間（まで） <input class="mn-input" type="date" name="to"></label>
            <label>タイトル <input class="mn-input" name="title" autocomplete="off"></label>
            <label>作った人 <select class="mn-input" name="owner"><option value="">指定なし</option></select></label>
          </div>
        </details>
      </form>
      <div class="mn-chips mn-cond" data-r="chips"></div>
      <div data-r="results" class="mn-results" aria-live="polite"></div>
    </div>`;

  const form = container.querySelector('[data-f=search]');
  const resultsEl = container.querySelector('[data-r=results]');
  const chipsEl = container.querySelector('[data-r=chips]');
  for (const k of ['company', 'name', 'from', 'to', 'title']) form.elements[k].value = f[k];

  const syncTabs = () => container.querySelectorAll('[data-tab]').forEach((b) => {
    const on = b.dataset.tab === f.relation;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
  });

  const readForm = () => {
    for (const k of ['company', 'name', 'from', 'to', 'title']) f[k] = form.elements[k].value.trim();
    f.attendee = form.elements.attendee.value;
    f.owner = form.elements.owner.value;
  };

  const userName = (id) => (dirUsers || []).find((u) => u.id === id)?.displayName || '選んだ人';
  const paintChips = () => {
    const c = [];
    if (f.company) c.push(['company', `相手の会社名: ${f.company}`]);
    if (f.name) c.push(['name', `相手の氏名: ${f.name}`]);
    if (f.cardId) c.push(['cardId', `名刺: ${f.cardLabel}`]);
    if (f.attendee) c.push(['attendee', `同席者: ${userName(f.attendee)}`]);
    if (f.from) c.push(['from', `${f.from} から`]);
    if (f.to) c.push(['to', `${f.to} まで`]);
    if (f.title) c.push(['title', `タイトル: ${f.title}`]);
    if (f.owner) c.push(['owner', `作った人: ${userName(f.owner)}`]);
    chipsEl.innerHTML = c.length ? `<span class="mn-muted">絞り込み中:</span>${c.map(([k, t]) => `<span class="mn-tag">${esc(t)}<button type="button" data-clear="${k}" aria-label="この条件を外す">×</button></span>`).join('')}` : '';
  };

  const rowHtml = (m) => {
    const people = (m.counterparts || []).map(counterpartLabel).join('、');
    return `<a class="mn-row-item" href="#" data-go="/minutes/${esc(m.id)}">
      <span class="mn-r-date">${esc(formatDateTime(m.heldAt))}</span>
      <span class="mn-r-title">${esc(m.title || '（無題）')}</span>
      <span class="mn-r-people">${esc(people)}</span>
      <span class="mn-r-dur">${esc(clock(m.durationSec))}</span>
      <span class="mn-r-st">${statusChipHtml(m)}${m.relation === 'shared' ? '<span class="mn-badge">共有された</span>' : ''}</span>
    </a>`;
  };

  async function load(cursor) {
    const my = ++seq;
    if (!cursor) resultsEl.innerHTML = '<p class="mn-muted">読み込んでいます…</p>';
    try {
      const r = await api.get('/api/minutes', toQuery({
        relation: f.relation, company: f.company, name: f.name, cardId: f.cardId, attendee: f.attendee,
        from: f.from, to: f.to, title: f.title, owner: f.owner, cursor,
      }));
      if (my !== seq || !container.isConnected) return;
      const items = itemsOf(r);
      const more = r && r.nextCursor;
      const html = items.map(rowHtml).join('');
      if (!cursor) {
        resultsEl.innerHTML = items.length ? `<div class="mn-list">${html}</div>` : '<p class="mn-empty">該当する議事録はありません。</p>';
      } else {
        resultsEl.querySelector('.mn-list')?.insertAdjacentHTML('beforeend', html);
        resultsEl.querySelector('[data-more-btn]')?.remove();
      }
      if (more) resultsEl.insertAdjacentHTML('beforeend', `<button class="mn-btn mn-more-btn" data-more-btn data-cursor="${esc(more)}">続きを読み込む</button>`);
    } catch (e) {
      if (my !== seq) return;
      resultsEl.innerHTML = `<p class="mn-error">${esc(errMessage(e))}</p><button class="mn-btn" data-retry>もう一度試す</button>`;
    }
  }
  const run = () => { syncTabs(); paintChips(); load(); };

  container.addEventListener('click', async (e) => {
    const go = e.target.closest('[data-go]');
    if (go) { e.preventDefault(); navigate(go.dataset.go); return; }
    const tab = e.target.closest('[data-tab]');
    if (tab) { f.relation = tab.dataset.tab; run(); return; }
    const clr = e.target.closest('[data-clear]');
    if (clr) {
      const k = clr.dataset.clear;
      f[k] = '';
      if (k === 'cardId') f.cardLabel = '';
      if (form.elements[k]) form.elements[k].value = '';
      run();
      return;
    }
    if (e.target.closest('[data-pick]')) {
      const c = await pickCard({ title: '名刺から選ぶ' });
      if (c && c.cardId) {
        f.cardId = c.cardId; f.cardLabel = counterpartLabel(c);
        run();
      }
      return;
    }
    const more = e.target.closest('[data-more-btn]');
    if (more) { more.disabled = true; load(more.dataset.cursor); return; }
    if (e.target.closest('[data-retry]')) load();
  });
  form.addEventListener('submit', (e) => { e.preventDefault(); readForm(); run(); });
  form.elements.attendee.addEventListener('change', () => { readForm(); run(); });
  form.elements.owner.addEventListener('change', () => { readForm(); run(); });

  // 「その他の条件」を開いたときにだけユーザー一覧を読む
  container.querySelector('[data-more]').addEventListener('toggle', async (ev) => {
    if (!ev.target.open || dirUsers) return;
    try {
      dirUsers = await loadDirectory();
      for (const name of ['attendee', 'owner']) {
        const sel = form.elements[name];
        sel.insertAdjacentHTML('beforeend', dirUsers.map((u) => `<option value="${esc(u.id)}">${esc(u.displayName)}${deptNames(u) ? '（' + esc(deptNames(u)) + '）' : ''}</option>`).join(''));
        sel.value = f[name];
      }
    } catch { /* 一覧が読めなくても他の条件は使える */ }
  });
  if (f.attendee || f.owner || f.from || f.to || f.title) container.querySelector('[data-more]').open = true;

  run();
  checkRecovery(container.querySelector('.mn-page'), { api, navigate });
}
