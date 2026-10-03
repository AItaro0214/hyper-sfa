// 「名刺から選ぶ」と「ユーザーから選ぶ」の共通部品。
import { api } from '../../api.js';
import { state } from '../../state.js';
import { fetchCompanies, companyTreeHtml, treeTarget } from '../../companyPicker.js';
import { esc, showModal, itemsOf, deptNames, errMessage, counterpartLabel, toQuery } from './util.js';

let dirCache = null;
export async function loadDirectory() {
  if (!dirCache) {
    try {
      dirCache = itemsOf(await api.get('/api/directory'));
    } catch (e) { dirCache = null; throw e; }
  }
  return dirCache;
}

// ---- 名刺から 1 枚選ぶ ----
// 戻り値: { cardId, company, department, name } / 名刺が無い相手は cardId が null / やめたら null
export function pickCard({ title = '商談の相手を選ぶ', manual = true } = {}) {
  return new Promise((resolve) => {
    let picked = null;
    const m = showModal({
      title,
      wide: true,
      onClose: () => resolve(picked),
      html: `
        <form class="mn-form-row" data-f="search">
          <label>会社名 <input class="mn-input" name="company" autocomplete="off" placeholder="入れるたびに絞り込みます"></label>
          <label>氏名 <input class="mn-input" name="name" autocomplete="off"></label>
          <button class="mn-btn mn-btn-primary" type="submit">探す</button>
        </form>
        <div class="mn-pick-results" data-r="results" aria-live="polite"><p class="mn-muted">読み込んでいます…</p></div>
        ${manual ? `<details class="mn-fold"><summary>名刺が無い相手を、手で入力する</summary>
          <form class="mn-manual" data-f="manual">
            <label>会社名 <input class="mn-input" name="company"></label>
            <label>部署名 <input class="mn-input" name="department"></label>
            <label>氏名 <input class="mn-input" name="name"></label>
            <button class="mn-btn" type="submit">この内容で追加</button>
            <p class="mn-muted">後で名刺を登録したら、紐づけ直せます。</p>
          </form>
        </details>` : ''}`,
    });
    const results = m.el.querySelector('[data-r=results]');
    const searchForm = m.el.querySelector('[data-f=search]');
    const finish = (v) => { picked = v; m.close(v); };
    let seq = 0; // 古い応答で新しい結果を上書きしない
    let tree = [];
    let cardList = [];

    // 会社名の欄: 会社 → 部署 → 人の木。何も入れなければ件数の多い取引先を出す
    const loadTree = async () => {
      const my = ++seq;
      const q = searchForm.elements.company.value.trim();
      results.innerHTML = '<p class="mn-muted">探しています…</p>';
      try {
        const items = await fetchCompanies({ q, limit: 20 });
        if (my !== seq) return;
        tree = items;
        cardList = [];
        results.innerHTML = items.length ? companyTreeHtml(items) : '<p class="mn-muted">見つかりませんでした。下の「手で入力する」も使えます。</p>';
      } catch (e) {
        if (my === seq) results.innerHTML = `<p class="mn-error">${esc(errMessage(e))}</p>`;
      }
    };
    // 氏名の欄: 従来どおり名刺を直接探す
    const loadByName = async () => {
      const my = ++seq;
      const company = searchForm.elements.company.value.trim();
      const name = searchForm.elements.name.value.trim();
      results.innerHTML = '<p class="mn-muted">探しています…</p>';
      try {
        const cards = itemsOf(await api.get('/api/cards', toQuery({ company, name, limit: 20 })));
        if (my !== seq) return;
        tree = [];
        cardList = cards;
        if (!cards.length) { results.innerHTML = '<p class="mn-muted">見つかりませんでした。下の「手で入力する」も使えます。</p>'; return; }
        results.innerHTML = `<ul class="mn-pick-list">${cards.map((c, i) => `
          <li><button type="button" class="mn-pick-item" data-i="${i}">
            <strong>${esc(c.name || '')}</strong><span>${esc(c.company || '')}${c.department ? ' ' + esc(c.department) : ''}</span>
          </button></li>`).join('')}</ul>`;
      } catch (e) {
        if (my === seq) results.innerHTML = `<p class="mn-error">${esc(errMessage(e))}</p>`;
      }
    };
    const run = () => (searchForm.elements.name.value.trim() ? loadByName() : loadTree());

    results.onclick = (e) => {
      const b = e.target.closest('[data-i]');
      if (b && cardList[Number(b.dataset.i)]) {
        const c = cardList[Number(b.dataset.i)];
        finish({ cardId: c.id, company: c.company || '', department: c.department || '', name: c.name || '' });
        return;
      }
      const t = treeTarget(tree, e);
      if (t) finish({ cardId: t.person.id, company: t.company, department: t.department, name: t.person.name || '' });
    };
    let timer = 0;
    const later = () => { clearTimeout(timer); timer = setTimeout(run, 300); };
    searchForm.elements.company.addEventListener('input', later);
    searchForm.elements.name.addEventListener('input', later);
    searchForm.addEventListener('submit', (ev) => { ev.preventDefault(); clearTimeout(timer); run(); });
    run();

    m.el.querySelector('[data-f=manual]')?.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const fd = new FormData(ev.currentTarget);
      const company = String(fd.get('company')).trim();
      const name = String(fd.get('name')).trim();
      if (!company && !name) return;
      finish({ cardId: null, company, department: String(fd.get('department')).trim(), name });
    });
    m.el.querySelector('input[name=company]').focus();
  });
}

// ---- ユーザーを選ぶ ----
// selectedIds: 最初から選ばれている人。first: 上に出す人（同席者など）。single: 1 人だけ選ぶ。
// 戻り値: 選んだ users の配列 / やめたら null
export function pickUsers({ title = 'ユーザーを選ぶ', selectedIds = [], firstIds = [], firstLabel = '同席者から選ぶ', excludeIds = [], single = false, okLabel = '決める' } = {}) {
  return new Promise((resolve) => {
    let result = null;
    const sel = new Set(selectedIds);
    const m = showModal({
      title,
      wide: true,
      onClose: () => resolve(result),
      html: `<input class="mn-input" type="search" data-f="q" placeholder="氏名や部署で探す" autocomplete="off">
        <div data-r="quick" class="mn-quick"></div>
        <div data-r="list" class="mn-user-list"><p class="mn-muted">読み込んでいます…</p></div>
        <div class="mn-row mn-end"><span class="mn-muted" data-r="count"></span><button class="mn-btn" data-close="1">やめる</button><button class="mn-btn mn-btn-primary" data-ok="1">${esc(okLabel)}</button></div>`,
    });
    const listEl = m.el.querySelector('[data-r=list]');
    const quickEl = m.el.querySelector('[data-r=quick]');
    const countEl = m.el.querySelector('[data-r=count]');
    let users = [];
    const exclude = new Set(excludeIds);

    const paint = () => {
      const q = m.el.querySelector('[data-f=q]').value.trim().toLowerCase();
      const rows = users.filter((u) => !exclude.has(u.id)).filter((u) => !q || `${u.displayName} ${deptNames(u)}`.toLowerCase().includes(q));
      const first = new Set(firstIds);
      rows.sort((a, b) => (first.has(b.id) ? 1 : 0) - (first.has(a.id) ? 1 : 0));
      listEl.innerHTML = rows.length ? rows.map((u) => `
        <label class="mn-user"><input type="${single ? 'radio' : 'checkbox'}" name="u" value="${esc(u.id)}" ${sel.has(u.id) ? 'checked' : ''}>
          <span><strong>${esc(u.displayName)}</strong> <span class="mn-muted">${esc(deptNames(u))}</span></span></label>`).join('')
        : '<p class="mn-muted">該当する人がいません。</p>';
      countEl.textContent = single ? '' : `${sel.size} 人選択中`;
    };
    // 同席者の絞り込みボタンは、押すとその人を選択に加える
    const paintQuick = () => {
      const q = users.filter((u) => firstIds.includes(u.id) && !exclude.has(u.id));
      quickEl.innerHTML = q.length ? `<div class="mn-muted">${esc(firstLabel)}</div><div class="mn-chips">${q.map((u) => `<button type="button" class="mn-chip-btn" data-id="${esc(u.id)}">${esc(u.displayName)}</button>`).join('')}</div>` : '';
    };
    listEl.addEventListener('change', (e) => {
      const inp = e.target.closest('input[name=u]');
      if (!inp) return;
      if (single) { sel.clear(); sel.add(inp.value); } else if (inp.checked) sel.add(inp.value); else sel.delete(inp.value);
      countEl.textContent = single ? '' : `${sel.size} 人選択中`;
    });
    quickEl.addEventListener('click', (e) => {
      const b = e.target.closest('[data-id]');
      if (!b) return;
      if (single) sel.clear();
      sel.add(b.dataset.id);
      paint();
    });
    m.el.querySelector('[data-f=q]').addEventListener('input', paint);
    m.el.querySelector('[data-ok]').addEventListener('click', () => {
      result = users.filter((u) => sel.has(u.id));
      m.close(result);
    });
    loadDirectory().then((u) => { users = u; paintQuick(); paint(); })
      .catch((e) => { listEl.innerHTML = `<p class="mn-error">${esc(errMessage(e))}</p>`; });
  });
}

/**
 * 相手と同席者の欄。model = { counterparts: [{cardId, company, department, name}], attendees: [{id, name}] }。
 * 変更は model を書き換えて onChange を呼ぶ。描き直すのはこの欄だけで、隣の入力欄には触らない。
 */
export function mountPeopleEditor(root, model, { onChange } = {}) {
  const me = state.me || {};
  const paint = () => {
    root.innerHTML = `
      <div class="mn-field"><div class="mn-label">商談の相手</div>
        <div class="mn-chips">${model.counterparts.map((c, i) => `<span class="mn-tag">${esc(counterpartLabel(c))}${c.cardId ? '' : '<em>名刺なし</em>'}<button type="button" data-rm-c="${i}" aria-label="外す">×</button></span>`).join('')}
        <button type="button" class="mn-btn mn-btn-sm" data-add-c>名刺から選ぶ</button></div>
        <div class="mn-muted">社内だけの会議なら、空のままで構いません。</div></div>
      <div class="mn-field"><div class="mn-label">自社の同席者</div>
        <div class="mn-chips">${model.attendees.map((a, i) => `<span class="mn-tag">${esc(a.name)}${a.id === me.id ? '' : `<button type="button" data-rm-a="${i}" aria-label="外す">×</button>`}</span>`).join('')}
        <button type="button" class="mn-btn mn-btn-sm" data-add-a>ユーザーから選ぶ</button></div></div>`;
  };
  paint();
  root.addEventListener('click', async (e) => {
    const rc = e.target.closest('[data-rm-c]');
    const ra = e.target.closest('[data-rm-a]');
    if (rc) { model.counterparts.splice(Number(rc.dataset.rmC), 1); paint(); if (onChange) onChange(); return; }
    if (ra) { model.attendees.splice(Number(ra.dataset.rmA), 1); paint(); if (onChange) onChange(); return; }
    if (e.target.closest('[data-add-c]')) {
      const c = await pickCard();
      if (c) { model.counterparts.push(c); paint(); if (onChange) onChange(); }
    } else if (e.target.closest('[data-add-a]')) {
      const users = await pickUsers({ title: '自社の同席者を選ぶ', selectedIds: model.attendees.map((a) => a.id), okLabel: '決める' });
      if (users) {
        // 作った人は外せないので、選び直しても残す
        const mine = model.attendees.filter((a) => a.id === me.id);
        const others = users.filter((u) => u.id !== me.id).map((u) => ({ id: u.id, name: u.displayName }));
        model.attendees = [...mine, ...others];
        paint();
        if (onChange) onChange();
      }
    }
  });
  return { repaint: paint };
}

// PUT /api/minutes/{id} の本文に使う形。
export function peopleToPayload(model) {
  return {
    counterparts: model.counterparts.map((c) => (c.cardId ? { cardId: c.cardId } : { company: c.company || undefined, department: c.department || undefined, name: c.name || undefined })),
    attendeeIds: model.attendees.map((a) => a.id),
  };
}
