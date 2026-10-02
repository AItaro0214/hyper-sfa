// 名刺の編集フォーム。登録の確認画面・詳細画面・検索画面のパネルで同じ部品を使う。
// どこから直しても同じ操作になるように、フォームの中身はここだけに持つ。
import { isValidEmail } from '/core/index.js';
import { api, ApiError } from '../api.js';
import { optimizeCardImages } from '../imageUtil.js';
import { state } from '../state.js';
import { esc, el, openModal, toast } from '../ui.js';
import { icon } from '../icons.js';
import { mountCompanySuggest } from '../companyPicker.js';

export const STATUS_LABEL = { processing: '読み取り中', review: '確認待ち', failed: '失敗', confirmed: '確認済み' };

let deptCache = null;
export function resetDepartmentCache() { deptCache = null; }
export async function loadDepartments() {
  if (!state.config.features.departments) return [];
  if (!deptCache) deptCache = (await api.get('/api/departments')).items || [];
  return deptCache;
}

// 写真。押すと拡大する（data-zoom）。URL は API が返したものをそのまま使う。
export function photoHtml(card) {
  const u = card.imageUrls || {};
  const one = (url, label) => (url ? `<figure class="photo"><img src="${esc(url)}" alt="${esc(label)}" data-zoom="${esc(url)}" loading="lazy"><figcaption>${esc(label)}</figcaption></figure>` : '');
  return one(u.front || u.thumb, '表面') + one(u.back, '裏面') || '<div class="photo photo-empty">写真なし</div>';
}
export function bindZoom(root) {
  root.addEventListener('click', (e) => {
    const img = e.target.closest('[data-zoom]');
    if (!img) return;
    openModal(`<img class="zoomed" src="${esc(img.dataset.zoom)}" alt="拡大">`, { title: '写真', wide: true });
  });
}

const splitLines = (s) => s.split(/[\n,、;；]+/).map((x) => x.trim()).filter(Boolean);
const joinLines = (a) => (a || []).join('\n');

// container に描く。返り値: { isDirty(), values() }
export async function mountCardForm(container, opts) {
  const { card, source, onSaved, onCancel, onDelete, extraButtons = [], banner = '' } = opts;
  const caps = (state.me && state.me.capabilities) || {};
  const useDepts = !!state.config.features.departments;
  const depts = useDepts ? await loadDepartments() : [];
  const activeDepts = depts.filter((d) => d.active !== false);
  const own = (state.me && state.me.deptIds) || [];
  const canOther = !!caps.assignOtherDepts;
  const initialDepts = new Set(card.deptIds && card.deptIds.length ? card.deptIds : (opts.defaultDeptIds || own));
  const selected = new Set(initialDepts);
  const nameOf = (id) => (depts.find((d) => d.id === id) || (card.departments || []).find((d) => d.id === id) || { name: id }).name;

  container.innerHTML = `<form class="card-form" novalidate>
    ${banner ? `<p class="alert alert-warn" role="alert">${esc(banner)}</p>` : ''}
    <div class="card-form-body">
      <div class="photos">${photoHtml(card)}</div>
      <div class="fields">
        <label class="field"><span>会社名</span><input name="company" value="${esc(card.company)}" autocomplete="off"></label>
        <p class="cs-similar" data-similar hidden></p>
        <label class="field"><span>部署名</span><input name="department" value="${esc(card.department)}" autocomplete="off"></label>
        <label class="field"><span>役職</span><input name="title" value="${esc(card.title)}" autocomplete="off"></label>
        <label class="field"><span>氏名</span><input name="name" value="${esc(card.name)}" autocomplete="off"></label>
        <label class="field"><span>ふりがな</span><input name="nameReading" value="${esc(card.nameReading)}" autocomplete="off"></label>
        <label class="field"><span>電話番号（複数は改行）</span><textarea name="phones" rows="2">${esc(joinLines(card.phones))}</textarea></label>
        <label class="field"><span>携帯電話（複数は改行）</span><textarea name="mobiles" rows="2">${esc(joinLines(card.mobiles))}</textarea></label>
        <label class="field"><span>メールアドレス（複数は改行）</span><textarea name="emails" rows="2">${esc(joinLines(card.emails))}</textarea></label>
        <p class="field-warn" data-email-warn hidden>形式がおかしいメールアドレスがあります。</p>
        <label class="field"><span>備考</span><textarea name="note" rows="3">${esc(card.note)}</textarea></label>
        <div data-depts></div>
      </div>
    </div>
    <p class="alert alert-error" role="alert" data-err hidden></p>
    <div class="actions">
      ${onCancel ? '<button type="button" class="btn" data-cancel>キャンセル</button>' : ''}
      ${extraButtons.map((b, i) => `<button type="button" class="btn" data-extra="${i}">${esc(b.label)}</button>`).join('')}
      <button type="submit" class="btn btn-primary">${esc(opts.submitLabel || '保存')}</button>
    </div>
  </form>
  ${onDelete ? `<div class="danger-zone">
    <p class="muted">この名刺を削除する（30 日は戻せます）。削除できるのは開発者だけです。</p>
    <button type="button" class="btn btn-danger" data-delete>${icon('trash', 18)}この名刺を削除</button>
  </div>` : ''}`;
  const form = container.querySelector('form');
  bindZoom(container);

  // 形式がおかしいメールアドレスには印を付ける。保存は止めない（読み取り結果を直す途中だから）。
  const emailsEl = form.elements.emails;
  const warn = form.querySelector('[data-email-warn]');
  const checkEmails = () => {
    const bad = splitLines(emailsEl.value).some((x) => !isValidEmail(x));
    warn.hidden = !bad;
    emailsEl.classList.toggle('invalid', bad);
  };
  emailsEl.addEventListener('input', checkEmails);
  checkEmails();

  // 会社名: 既存の取引先の候補を出して、表記を揃えやすくする。選ばなくても保存できる。
  const companyEl = form.elements.company;
  const similarEl = form.querySelector('[data-similar]');
  const showSimilar = (items, q) => {
    // 入れた表記と同じものは出さない。違う表記の 1 つ目だけを「似ている」として出す
    const alt = q ? items.find((c) => c.company !== q) : null;
    if (!alt || items.some((c) => c.company === q)) { similarEl.hidden = true; similarEl.replaceChildren(); return; }
    similarEl.replaceChildren('似た取引先があります: ');
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = `${alt.company}（${alt.count} 枚）`;
    b.addEventListener('click', () => { companyEl.value = alt.company; similarEl.hidden = true; });
    similarEl.append(b);
    similarEl.hidden = false;
  };
  mountCompanySuggest(companyEl, {
    heading: '既存の取引先',
    onPick: ({ company }) => { companyEl.value = company; similarEl.hidden = true; },
    onResults: showSimilar,
  });

  const deptBox = form.querySelector('[data-depts]');
  function renderDepts() {
    if (!useDepts) { deptBox.innerHTML = ''; return; }
    const btn = (d, on, locked) => `<button type="button" class="pill ${on ? 'on' : ''}" data-dept="${esc(d.id)}" ${locked ? 'disabled' : ''} aria-pressed="${on}">${esc(d.name)}</button>`;
    const ownList = activeDepts.filter((d) => own.includes(d.id));
    let html = `<div class="field"><span>担当部署（この名刺を見られる部署）</span><div class="pills">${ownList.map((d) => btn(d, selected.has(d.id))).join('') || '<span class="muted">所属部署がありません</span>'}</div></div>`;
    const others = [...selected].filter((id) => !own.includes(id));
    if (canOther) {
      const yes = deptBox.dataset.other === '1' || others.length > 0;
      html += `<div class="field"><span>他の部署にも見せる？</span>
        <div class="radios"><label><input type="radio" name="other" value="0" ${yes ? '' : 'checked'}> いいえ</label>
        <label><input type="radio" name="other" value="1" ${yes ? 'checked' : ''}> はい</label></div>
        ${yes ? `<div class="pills">${activeDepts.filter((d) => !own.includes(d.id)).map((d) => btn(d, selected.has(d.id))).join('')}
          <button type="button" class="btn btn-small" data-all>すべて選ぶ</button></div>` : ''}</div>`;
    } else if (others.length) {
      // 所属外の部署が既に付いている名刺。外せない部署は、そのまま残して見せる。
      html += `<div class="field"><span>ほかの担当部署（変更できません）</span><div class="pills">${others.map((id) => btn({ id, name: nameOf(id) }, true, true)).join('')}</div></div>`;
    }
    deptBox.innerHTML = html;
  }
  deptBox.addEventListener('click', (e) => {
    const b = e.target.closest('[data-dept]');
    if (b && !b.disabled) {
      const id = b.dataset.dept;
      if (selected.has(id)) selected.delete(id); else selected.add(id);
      renderDepts();
    } else if (e.target.closest('[data-all]')) {
      activeDepts.forEach((d) => selected.add(d.id));
      renderDepts();
    }
  });
  deptBox.addEventListener('change', (e) => {
    if (e.target.name !== 'other') return;
    deptBox.dataset.other = e.target.value;
    if (e.target.value === '0') [...selected].forEach((id) => { if (!own.includes(id)) selected.delete(id); });
    renderDepts();
  });
  renderDepts();

  const read = () => ({
    company: form.elements.company.value.trim(),
    department: form.elements.department.value.trim(),
    title: form.elements.title.value.trim(),
    name: form.elements.name.value.trim(),
    nameReading: form.elements.nameReading.value.trim(),
    phones: splitLines(form.elements.phones.value),
    mobiles: splitLines(form.elements.mobiles.value),
    emails: splitLines(emailsEl.value),
    note: form.elements.note.value.trim(),
  });
  const snapshot = () => JSON.stringify([read(), [...selected].sort()]);
  const initial = snapshot();
  const errBox = form.querySelector('[data-err]');
  const showErr = (m) => { errBox.textContent = m; errBox.hidden = false; };

  if (onCancel) form.querySelector('[data-cancel]').addEventListener('click', onCancel);
  // 削除は保存の流れと分けて、フォームの一番下に置く（押し間違いを防ぐ。確認は呼び出し元で出す）
  if (onDelete) container.querySelector('[data-delete]').addEventListener('click', () => onDelete(card));
  const handle = { isDirty: () => snapshot() !== initial, values: () => ({ ...read(), deptIds: [...selected] }) };
  extraButtons.forEach((b, i) => form.querySelector(`[data-extra="${i}"]`).addEventListener('click', () => b.onClick(handle)));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errBox.hidden = true;
    if (useDepts && selected.size === 0) { showErr('担当部署を 1 つ以上選んでください。'); return; }
    const btns = form.querySelectorAll('button');
    btns.forEach((b) => { b.disabled = true; });
    const body = { ...read(), version: card.version, source, confirm: card.status !== 'confirmed' ? true : undefined };
    if (useDepts) body.deptIds = [...selected];
    try {
      const res = await api.put(`/api/cards/${encodeURIComponent(card.id)}`, body);
      const saved = res && res.id ? res : res && res.card ? res.card : await api.get(`/api/cards/${encodeURIComponent(card.id)}`);
      toast('保存しました', 'success');
      // 確認済みになったら、画像を裏で縮小する。待たない・失敗しても画面は変えない
      if (saved.status === 'confirmed' && !saved.imageOptimized) optimizeCardImages(saved);
      if (onSaved) onSaved(saved);
    } catch (ex) {
      btns.forEach((b) => { b.disabled = false; });
      if (ex instanceof ApiError && ex.status === 409) {
        // 黙って上書きしない。最新の内容を見せて、直す人に判断してもらう。
        try {
          const latest = await api.get(`/api/cards/${encodeURIComponent(card.id)}`);
          await mountCardForm(container, { ...opts, card: latest, banner: 'ほかの人が先に更新しました。最新の内容を表示しています。直す内容をもう一度入れて保存してください。' });
          return;
        } catch { /* 取り直せなければ下のエラー表示 */ }
      }
      const detail = ex.details && ex.details.length ? '\n' + ex.details.map((d) => d.message).join('\n') : '';
      showErr(ex.message + detail);
    }
  });
  return handle;
}

// 編集できない人向けの表示。
export function cardViewHtml(card) {
  const list = (a) => (a && a.length ? a.map(esc).join('<br>') : '<span class="muted">-</span>');
  const row = (k, v) => `<div class="kv"><dt>${esc(k)}</dt><dd>${v}</dd></div>`;
  return `<div class="card-view"><div class="photos">${photoHtml(card)}</div>
    <dl>
      ${row('会社名', esc(card.company) || '-')}
      ${row('部署名', esc(card.department) || '-')}
      ${row('役職', esc(card.title) || '-')}
      ${row('氏名', `${esc(card.name)}${card.nameReading ? `<small class="muted"> （${esc(card.nameReading)}）</small>` : ''}`)}
      ${row('電話番号', list(card.phones))}
      ${row('携帯電話', list(card.mobiles))}
      ${row('メールアドレス', list((card.emails || []).map(String)))}
      ${row('備考', `<span class="pre">${esc(card.note) || '-'}</span>`)}
      ${state.config.features.departments ? row('担当部署', (card.departments || []).map((d) => esc(d.name)).join('、') || '-') : ''}
    </dl></div>`;
}
export { el };
