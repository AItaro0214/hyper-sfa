// 名刺の詳細。編集・削除・読み取り直し・この人との議事録。
import { api } from '../api.js';
import { state } from '../state.js';
import { esc, toast, confirmDialog, formatDate, formatDateTime, errorMessage } from '../ui.js';
import { navigate } from '../router.js';
import { STATUS_LABEL, mountCardForm, cardViewHtml, bindZoom } from './cardEdit.js';

const MINUTES_STATUS = { recording: '録音中', uploaded: 'アップロード済み', queued: '待機中', transcribing: '文字起こし中', summarizing: '議事録作成中', done: '完了', failed: '失敗' };

export async function renderCardDetail(container, { id }) {
  const caps = state.me.capabilities || {};
  const root = document.createElement('div');
  root.className = 'page';
  container.appendChild(root);
  let stopped = false;
  const path = `/api/cards/${encodeURIComponent(id)}`;

  async function load() {
    let card;
    try { card = await api.get(path); } catch (e) {
      root.innerHTML = `<h1>名刺</h1><p class="alert alert-error">${esc(e.message)}</p><p><a href="/">名刺を探す</a></p>`;
      return;
    }
    show(card);
  }

  function canDelete(card) {
    return !!caps.deleteAnyCard || (!!caps.editCards && card.createdBy && card.createdBy.id === state.me.id);
  }

  function show(card) {
    const canEdit = !!caps.editCards;
    const canRescan = canEdit || (card.status !== 'confirmed' && card.createdBy && card.createdBy.id === state.me.id);
    root.innerHTML = `<p><a href="/">← 名刺を探す</a></p>
      <h1>${esc(card.name) || '名刺'} <span class="muted">${esc(card.company)}</span>
        ${card.status !== 'confirmed' ? `<span class="badge badge-${esc(card.status)}">${esc(STATUS_LABEL[card.status] || card.status)}</span>` : ''}</h1>
      <p class="muted">登録: ${esc(card.createdBy && card.createdBy.name)} ${esc(formatDate(card.createdAt))} ／ 最終編集: ${esc(card.updatedBy ? card.updatedBy.name : '-')} ${esc(formatDate(card.updatedAt))}</p>
      ${card.failure ? `<p class="alert alert-error">${esc(card.failure.message)}</p>` : ''}
      <div data-body>${cardViewHtml(card)}</div>
      <div class="actions">
        ${canEdit ? '<button type="button" class="btn btn-primary" data-edit>編集</button>' : ''}
        ${canRescan ? '<button type="button" class="btn" data-rescan>読み取り直し</button>' : ''}
        ${canDelete(card) ? '<button type="button" class="btn btn-danger" data-del>削除</button>' : ''}
      </div>
      ${state.config.features.minutes ? '<section><h2>この人との議事録</h2><div data-minutes><p class="muted">読み込んでいます…</p></div></section>' : ''}
      ${caps.viewHistory ? '<section><h2>変更履歴</h2><div data-history><p class="muted">読み込んでいます…</p></div></section>' : ''}`;
    bindZoom(root);
    const body = root.querySelector('[data-body]');
    root.querySelector('[data-edit]')?.addEventListener('click', async (e) => {
      e.target.closest('.actions').hidden = true;
      body.replaceChildren();
      await mountCardForm(body, { card, source: 'detail', onCancel: () => show(card), onSaved: () => load() });
    });
    root.querySelector('[data-del]')?.addEventListener('click', async () => {
      if (!(await confirmDialog('この名刺を削除しますか？', { okLabel: '削除する', danger: true }))) return;
      try { await api.del(path); toast('削除しました'); navigate('/'); } catch (e) { toast(errorMessage(e), 'error'); }
    });
    root.querySelector('[data-rescan]')?.addEventListener('click', async () => {
      if (card.status === 'confirmed' && !(await confirmDialog('直した内容は置き換わります。読み取り直しますか？', { okLabel: '読み取り直す' }))) return;
      try { await api.post(`${path}/rescan`); toast('読み取り直しています'); poll(); } catch (e) { toast(errorMessage(e), 'error'); }
    });
    if (card.status === 'processing') poll();
    loadMinutes();
    loadHistory();
  }

  async function poll() {
    root.querySelector('[data-body]')?.insertAdjacentHTML('afterbegin', '<p class="alert">読み取っています…</p>');
    for (let i = 0; i < 80 && !stopped; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        const r = await api.get(`${path}/status`);
        if (r.status !== 'processing') { if (!stopped) load(); return; }
      } catch { /* 一時的な失敗は続ける */ }
    }
    if (!stopped) load();
  }

  async function loadMinutes() {
    const box = root.querySelector('[data-minutes]');
    if (!box) return;
    try {
      const r = await api.get(`${path}/minutes`);
      const items = r.items || [];
      box.innerHTML = items.length ? `<ul class="plain">${items.map((m) => `<li><a href="/minutes/${encodeURIComponent(m.id)}">${esc(m.title || '(無題)')}</a>
        <span class="muted">${esc(formatDateTime(m.heldAt))}</span> <span class="badge">${esc(MINUTES_STATUS[m.status] || m.status)}</span></li>`).join('')}</ul>` : '<p class="muted">議事録はありません。</p>';
    } catch (e) { box.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
  }

  async function loadHistory() {
    const box = root.querySelector('[data-history]');
    if (!box) return;
    try {
      const r = await api.get(`/api/admin/cards/${encodeURIComponent(id)}/history`);
      box.innerHTML = historyList(r.items || []);
    } catch (e) { box.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
  }

  await load();
  return () => { stopped = true; };
}

export const TYPE_LABEL = { create: '登録', edit: '編集', rescan: '読み取り直し', delete: '削除', restore: '復元' };
export const FIELD_LABEL = { company: '会社名', department: '部署名', name: '氏名', nameReading: 'ふりがな', phones: '電話番号', mobiles: '携帯電話', emails: 'メール', note: '備考', deptIds: '担当部署' };
const val = (v) => (Array.isArray(v) ? v.join(', ') : v ?? '');

// 履歴の 1 件（管理コンソールの履歴と詳細で共用）。編集は項目ごとに変更前 → 変更後。
export function historyItemHtml(h, { withCard = false } = {}) {
  return `<li class="hist"><div class="hist-head"><span class="muted">${esc(formatDateTime(h.at))}</span>
    <strong>${esc(TYPE_LABEL[h.type] || h.type)}</strong>
    ${h.actor ? `${esc(h.actor.name)}${h.actor.deptName ? `（${esc(h.actor.deptName)}）` : ''}` : ''}
    ${withCard && h.card ? `<a href="/cards/${encodeURIComponent(h.card.id)}">${esc(h.card.company)} ${esc(h.card.name)}</a>` : ''}
    ${h.source ? `<span class="muted">${esc({ review: '確認画面', search: '検索画面', detail: '詳細画面' }[h.source] || h.source)}</span>` : ''}</div>
    ${(h.changes || []).map((c) => `<div class="change"><span>${esc(FIELD_LABEL[c.field] || c.field)}</span> ${esc(val(c.before))} → ${esc(val(c.after))}</div>`).join('')}</li>`;
}
function historyList(items) {
  return items.length ? `<ul class="plain">${items.map((h) => historyItemHtml(h)).join('')}</ul>` : '<p class="muted">履歴はありません。</p>';
}
