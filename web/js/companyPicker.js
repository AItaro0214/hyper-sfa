// 取引先（会社 → 部署 → 人）の共通部品。会社名の候補表示と、畳める木の描画。
// 集計はサーバー（GET /api/companies）が行うので、画面は応答をそのまま使う。
import { api } from './api.js';
import { esc } from './ui.js';

const toQ = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v !== undefined && v !== null));

export async function fetchCompanies({ q = '', limit = 20 } = {}) {
  const r = await api.get('/api/companies', toQ({ q, limit }));
  return (r && r.items) || [];
}

/**
 * 入力欄の下に会社名の候補を出す。選ぶと onPick({ company, key, departments })。
 * input の親要素（label など）を位置の基準にする。
 * 返り値: { close(), destroy() }
 */
export function mountCompanySuggest(input, { onPick, minChars = 1, debounce = 250, heading = '', onResults } = {}) {
  const host = input.closest('.cs-host') || input.parentElement;
  host.classList.add('cs-host');
  const box = document.createElement('div');
  box.className = 'cs-box';
  box.hidden = true;
  box.setAttribute('role', 'listbox');
  host.appendChild(box);
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('aria-autocomplete', 'list');

  let seq = 0, timer = 0, items = [], active = -1;

  const close = () => { box.hidden = true; active = -1; seq++; };
  const paintActive = () => {
    box.querySelectorAll('.cs-item').forEach((b, i) => {
      b.classList.toggle('on', i === active);
      b.setAttribute('aria-selected', String(i === active));
    });
    box.querySelector('.cs-item.on')?.scrollIntoView({ block: 'nearest' });
  };
  const pick = (i) => {
    const it = items[i];
    if (!it) return;
    close();
    if (onPick) onPick({ company: it.company, key: it.key, departments: (it.departments || []).map((d) => d.name).filter(Boolean) });
  };
  const paint = () => {
    if (!items.length) { box.hidden = true; return; }
    box.innerHTML = (heading ? `<div class="cs-head">${esc(heading)}</div>` : '') + items.map((c, i) => {
      const deps = (c.departments || []).filter((d) => d.name).length;
      return `<button type="button" class="cs-item" role="option" data-i="${i}"><span class="cs-name">${esc(c.company)}</span><span class="cs-meta">${c.count} 枚${deps ? ` / ${deps} 部署` : ''}</span></button>`;
    }).join('');
    active = -1;
    box.hidden = false;
  };
  const load = async () => {
    const q = input.value.trim();
    if (q.length < minChars) { close(); return; }
    const my = ++seq;
    try {
      const r = await fetchCompanies({ q, limit: 8 });
      if (my !== seq) return; // 古い応答で新しい結果を上書きしない
      items = r;
      if (onResults) onResults(r, q);
      paint();
    } catch { if (my === seq) close(); }
  };
  const onInput = () => {
    clearTimeout(timer);
    if (!input.value.trim()) { close(); if (onResults) onResults([], ''); return; }
    timer = setTimeout(load, debounce);
  };
  const onKey = (e) => {
    if (box.hidden) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % items.length; paintActive(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + items.length) % items.length; paintActive(); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); pick(active); }
    else if (e.key === 'Escape') { e.stopPropagation(); close(); }
  };
  // mousedown で選ぶ。click だと先に入力欄の blur が走って閉じてしまうため
  box.addEventListener('mousedown', (e) => {
    const b = e.target.closest('.cs-item');
    if (b) { e.preventDefault(); pick(Number(b.dataset.i)); }
  });
  const onDoc = (e) => { if (!host.contains(e.target)) close(); };
  input.addEventListener('input', onInput);
  input.addEventListener('keydown', onKey);
  document.addEventListener('mousedown', onDoc);
  return {
    close,
    destroy() {
      clearTimeout(timer);
      input.removeEventListener('input', onInput);
      input.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDoc);
      box.remove();
    },
  };
}

/**
 * 会社 → 部署 → 人の木の HTML。人は <button>、hrefOf があれば <a>。
 * 会社が 1 件だけなら開いておく。クリックは treeTarget(items, event) で引く。
 */
export function companyTreeHtml(items, { hrefOf } = {}) {
  if (!items.length) return '<p class="muted ct-empty">該当する取引先がありません。</p>';
  const only = items.length === 1;
  return `<div class="ct">${items.map((c, ci) => `
    <details class="ct-co" ${only ? 'open' : ''}>
      <summary><span class="ct-name">${esc(c.company)}</span><span class="ct-count">${c.count} 枚</span></summary>
      <div class="ct-body">${(c.departments || []).map((d, di) => `
        <details class="ct-dep" ${only && (c.departments || []).length === 1 ? 'open' : ''}>
          <summary><span class="ct-name">${esc(d.name || '（部署なし）')}</span><span class="ct-count">${d.count} 枚</span></summary>
          <ul class="ct-people">${(d.people || []).map((p, pi) => {
            const inner = `<strong>${esc(p.name || '（氏名なし）')}</strong>${p.title ? `<span>${esc(p.title)}</span>` : ''}`;
            const attrs = `data-ci="${ci}" data-di="${di}" data-pi="${pi}"`;
            return `<li>${hrefOf ? `<a class="ct-person" href="${esc(hrefOf(p))}" ${attrs}>${inner}</a>` : `<button type="button" class="ct-person" ${attrs}>${inner}</button>`}</li>`;
          }).join('')}</ul>
        </details>`).join('')}</div>
    </details>`).join('')}</div>`;
}

// 木のクリックから { company, department, person } を引く
export function treeTarget(items, e) {
  const b = e.target.closest('[data-pi]');
  if (!b) return null;
  const c = items[Number(b.dataset.ci)];
  const d = c && c.departments[Number(b.dataset.di)];
  const p = d && d.people[Number(b.dataset.pi)];
  return p ? { company: c.company, department: d.name || '', person: p } : null;
}
