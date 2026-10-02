// 名刺を探す。検索欄と編集パネルは描き直さず、結果の一覧だけを差し替える
// （入力のたびに全体を描くと日本語入力の変換が壊れるため）。
import { api } from '../api.js';
import { state } from '../state.js';
import { esc, el, chip, toast, confirmDialog, onTextInput, errorMessage, skeletonRows } from '../ui.js';
import { icon } from '../icons.js';
import { STATUS_LABEL, mountCardForm, cardViewHtml, bindZoom } from './cardEdit.js';

const FIELDS = [
  { key: 'company', label: '会社名', basic: true },
  { key: 'name', label: '氏名', basic: true },
  { key: 'department', label: '相手の部署名' },
  { key: 'phone', label: '電話番号' },
  { key: 'email', label: 'メール' },
  { key: 'note', label: '備考・役職' },
];

export async function renderHome(container, _p, query, minutesMod) {
  const caps = state.me.capabilities || {};
  const useDepts = !!state.config.features.departments;
  const cond = {};
  for (const k of ['company', 'name', 'department', 'phone', 'email', 'note', 'owner', 'from', 'to', 'dept']) if (query[k]) cond[k] = query[k];
  let items = [], nextCursor = null, total = null, loading = false, seq = 0;
  let directory = [], depts = [];
  let fresh = true; // 検索し直した直後の描画だけ、行を順に出す（「もっと見る」で再生し直さない）

  container.innerHTML = `<div class="page home">
    <div class="page-head"><h1>名刺を探す</h1>${state.config.features.minutes ? '<div id="home-minutes"></div>' : ''}</div>
    <form class="search" novalidate role="search">
      <div class="search-basic">
        ${FIELDS.filter((f) => f.basic).map((f) => `<label class="field"><span>${f.label}</span><input type="search" name="${f.key}" value="${esc(cond[f.key] || '')}" autocomplete="off" enterkeyhint="search"></label>`).join('')}
        <button type="submit" class="btn btn-primary">${icon('search')}検索</button>
      </div>
      <details class="more" ${Object.keys(cond).some((k) => !['company', 'name'].includes(k)) ? 'open' : ''}>
        <summary>その他の条件</summary>
        <div class="search-more">
          ${FIELDS.filter((f) => !f.basic).map((f) => `<label class="field"><span>${f.label}</span><input type="search" name="${f.key}" value="${esc(cond[f.key] || '')}" autocomplete="off"></label>`).join('')}
          <label class="field"><span>登録者</span><select name="owner"><option value="">指定しない</option></select></label>
          <div class="field"><span>登録日</span><div class="range"><input type="date" name="from" value="${esc(cond.from || '')}"><span>〜</span><input type="date" name="to" value="${esc(cond.to || '')}"></div></div>
          ${useDepts ? '<div class="field wide"><span>担当部署</span><div class="pills" data-depts></div></div>' : ''}
        </div>
      </details>
    </form>
    <div class="chips" data-chips></div>
    <p class="count" data-count></p>
    <div class="results" data-list></div>
    <div class="more-row"><button type="button" class="btn" data-more hidden>もっと見る</button></div>
    <div data-sentinel></div>
    <aside class="panel" data-panel hidden><div class="panel-head"><button type="button" class="icon-btn" data-close aria-label="閉じる">${icon('close')}</button></div><div class="panel-body"></div></aside>
  </div>`;

  const form = container.querySelector('form.search');
  const listEl = container.querySelector('[data-list]');
  const chipsEl = container.querySelector('[data-chips]');
  const countEl = container.querySelector('[data-count]');
  const moreBtn = container.querySelector('[data-more]');
  const panel = container.querySelector('[data-panel]');
  const panelBody = panel.querySelector('.panel-body');

  const valueLabel = (k, v) => {
    if (k === 'owner') return (directory.find((d) => d.id === v) || { displayName: v }).displayName;
    if (k === 'dept') return (depts.find((d) => d.id === v) || { name: v }).name;
    return v;
  };
  const NAMES = { owner: '登録者', from: '登録日(から)', to: '登録日(まで)', dept: '担当部署' };

  function renderChips() {
    chipsEl.replaceChildren();
    const keys = Object.keys(cond);
    if (!keys.length) return;
    for (const k of keys) {
      chipsEl.appendChild(chip(`${NAMES[k] || FIELDS.find((f) => f.key === k).label}: ${valueLabel(k, cond[k])}`, () => { delete cond[k]; syncInputs(); search(); }));
    }
    const clear = el('<button type="button" class="link">すべて解除</button>');
    clear.addEventListener('click', () => { for (const k of Object.keys(cond)) delete cond[k]; syncInputs(); search(); });
    chipsEl.appendChild(clear);
  }
  function syncInputs() {
    for (const inp of form.elements) {
      if (inp.name && inp.name in { company: 1, name: 1, department: 1, phone: 1, email: 1, note: 1, owner: 1, from: 1, to: 1 }) inp.value = cond[inp.name] || '';
    }
    renderDeptPills();
  }
  function renderDeptPills() {
    const box = container.querySelector('[data-depts]');
    if (!box) return;
    box.innerHTML = depts.map((d) => `<button type="button" class="pill ${cond.dept === d.id ? 'on' : ''}" data-dept="${esc(d.id)}" aria-pressed="${cond.dept === d.id}">${esc(d.name)}</button>`).join('');
  }

  function rowHtml(c, i = -1) {
    const thumb = c.imageUrls && c.imageUrls.thumb;
    const canEdit = !!caps.editCards;
    // 順に現れる演出は先頭 12 件まで。それ以上は遅延なし（i を付けない）
    const anim = i >= 0 && i < 12 ? ` row-in" style="--i:${i}` : '';
    const initial = [...String(c.company || c.name || '?')][0];
    return `<article class="row${anim}" data-id="${esc(c.id)}">
      <div class="row-thumb">${thumb ? `<img src="${esc(thumb)}" alt="" loading="lazy">` : `<span class="initial">${esc(initial)}</span>`}</div>
      <div class="row-main">
        <div class="row-company">${esc(c.company) || '<span class="muted">（会社名なし）</span>'} <span class="muted">${esc(c.department)}</span>
          ${c.status !== 'confirmed' ? `<span class="badge badge-${esc(c.status)}">${esc(STATUS_LABEL[c.status] || c.status)}</span>` : ''}</div>
        <div class="row-name"><a href="/cards/${encodeURIComponent(c.id)}">${esc(c.name) || '（氏名なし）'}</a>${c.title ? ` <small class="muted">${esc(c.title)}</small>` : ''}</div>
        <div class="row-sub mono">${[...(c.phones || []), ...(c.mobiles || [])].map((t) => `<span class="nw">${esc(t)}</span>`).join(' / ')}</div>
        <div class="row-sub">${(c.emails || []).map(esc).join(' / ')}</div>
      </div>
      <div class="row-act">${canEdit ? `<button type="button" class="btn btn-small" data-edit aria-label="編集">${icon('edit', 18)}<span class="lbl">編集</span></button>` : `<button type="button" class="btn btn-small" data-view aria-label="表示">${icon('chevron', 18)}<span class="lbl">表示</span></button>`}</div>
    </article>`;
  }
  function renderList() {
    listEl.innerHTML = items.map((c, i) => rowHtml(c, fresh ? i : -1)).join('') || (loading ? '' : '<p class="empty">見つかりませんでした</p>');
    fresh = false;
    countEl.textContent = total !== null ? `${total} 件` : '';
    moreBtn.hidden = !nextCursor;
  }
  async function deleteCard(card) {
    if (!(await confirmDialog('この名刺を削除しますか？', { okLabel: '削除する', danger: true }))) return;
    try {
      await api.del(`/api/cards/${encodeURIComponent(card.id)}`);
      items = items.filter((x) => x.id !== card.id);
      listEl.querySelector(`[data-id="${CSS.escape(card.id)}"]`)?.remove();
      closePanel();
      toast('削除しました');
    } catch (e) { toast(errorMessage(e), 'error'); }
  }

  function replaceRow(card) {
    const i = items.findIndex((x) => x.id === card.id);
    if (i < 0) return;
    items[i] = card;
    const old = listEl.querySelector(`[data-id="${CSS.escape(card.id)}"]`);
    if (old) old.replaceWith(el(rowHtml(card)));
  }

  function syncUrl() {
    const q = new URLSearchParams(cond).toString();
    history.replaceState(null, '', q ? `/?${q}` : '/');
  }
  async function fetchPage(reset) {
    const my = ++seq;
    loading = true;
    if (reset) { items = []; nextCursor = null; total = null; fresh = true; listEl.innerHTML = skeletonRows(5); }
    try {
      const r = await api.get('/api/cards', { ...cond, limit: 30, cursor: reset ? undefined : nextCursor });
      if (my !== seq) return;
      items = items.concat(r.items || []);
      nextCursor = r.nextCursor || null;
      total = r.total ?? total;
    } catch (e) {
      if (my !== seq) return;
      toast(errorMessage(e), 'error');
    } finally { if (my === seq) loading = false; }
    if (my === seq) renderList();
  }
  function search() { syncUrl(); renderChips(); return fetchPage(true); }

  // 入力欄 → 条件
  function readForm() {
    for (const k of ['company', 'name', 'department', 'phone', 'email', 'note', 'owner', 'from', 'to']) {
      const v = form.elements[k].value.trim();
      if (v) cond[k] = v; else delete cond[k];
    }
  }
  form.addEventListener('submit', (e) => { e.preventDefault(); readForm(); search(); });
  for (const inp of form.querySelectorAll('input[type=search]')) onTextInput(inp, () => { readForm(); search(); });
  for (const n of ['owner', 'from', 'to']) form.elements[n].addEventListener('change', () => { readForm(); search(); });
  container.querySelector('[data-depts]')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-dept]');
    if (!b) return;
    if (cond.dept === b.dataset.dept) delete cond.dept; else cond.dept = b.dataset.dept;
    renderDeptPills();
    search();
  });
  moreBtn.addEventListener('click', () => { if (!loading && nextCursor) fetchPage(false); });
  const io = 'IntersectionObserver' in window ? new IntersectionObserver((es) => { if (es[0].isIntersecting && !loading && nextCursor) fetchPage(false); }) : null;
  if (io) io.observe(container.querySelector('[data-sentinel]'));

  // 編集パネル
  function closePanel() { panel.hidden = true; panelBody.replaceChildren(); document.body.classList.remove('panel-open'); }
  panel.querySelector('[data-close]').addEventListener('click', closePanel);
  listEl.addEventListener('click', async (e) => {
    const row = e.target.closest('.row');
    if (!row || e.target.closest('a')) return;
    const card = items.find((x) => x.id === row.dataset.id);
    if (!card) return;
    const editBtn = e.target.closest('[data-edit]');
    const wantView = e.target.closest('[data-view]') || (!caps.editCards && !editBtn);
    if (!editBtn && !wantView) return;
    panel.hidden = false;
    document.body.classList.add('panel-open');
    if (editBtn) {
      panelBody.replaceChildren();
      await mountCardForm(panelBody, {
        card, source: 'search', onCancel: closePanel, onSaved: (saved) => { replaceRow(saved); closePanel(); },
        onDelete: caps.deleteAnyCard ? deleteCard : undefined,
      });
    } else {
      panelBody.innerHTML = cardViewHtml(card) + `<p><a class="btn" href="/cards/${encodeURIComponent(card.id)}">詳細を開く</a></p>`;
      bindZoom(panelBody);
    }
  });

  // 登録者と担当部署の選択肢は後から埋める（一覧の表示を待たせない）。
  Promise.all([
    api.get('/api/directory').then((r) => r.items || []).catch(() => []),
    useDepts ? api.get('/api/departments').then((r) => (r.items || []).filter((d) => d.active !== false)).catch(() => []) : [],
  ]).then(([dir, ds]) => {
    directory = dir;
    depts = caps.seeAllCards ? ds : ds.filter((d) => (state.me.deptIds || []).includes(d.id));
    const sel = form.elements.owner;
    sel.insertAdjacentHTML('beforeend', dir.map((d) => `<option value="${esc(d.id)}">${esc(d.displayName)}</option>`).join(''));
    sel.value = cond.owner || '';
    renderDeptPills();
    renderChips();
  });

  renderChips();
  fetchPage(true);

  if (state.config.features.minutes && minutesMod && typeof minutesMod.renderHomeMinutesBar === 'function') {
    try { minutesMod.renderHomeMinutesBar(container.querySelector('#home-minutes')); } catch (e) { console.warn('議事録の入口を描けませんでした', e); }
  }
  return () => { if (io) io.disconnect(); document.body.classList.remove('panel-open'); };
}
