// 開発コンソール: 役職と権限。役職ごとに権限の段階を決める。AWS 版だけ（features.positions）。
// 変更は画面に溜めて「保存」で全体置き換え（PUT）。部分更新にすると並びと重複の検証が割れるため。
import { DEFAULT_POSITIONS } from '/core/index.js';
import { api } from '../../api.js';
import { state } from '../../state.js';
import { esc, toast, errorMessage } from '../../ui.js';
import { icon } from '../../icons.js';
import { settingsNav } from '../settingsNav.js';

// 段階の表示名と、できることの短い説明（docs/design.md §9.1）
const LEVELS = [
  ['dev', '開発', 'すべての名刺を見て編集できる。管理コンソールと開発コンソールに入れる'],
  ['org_admin', '全社管理', 'すべての名刺を見て編集できる。管理コンソールに入れる（開発コンソールは不可）'],
  ['org_edit', '全社編集', 'すべての名刺を見て編集できる。他の部署にも見せられる'],
  ['dept_edit', '部署編集', '担当部署が自分の所属と重なる名刺だけ見て編集できる'],
  ['dept_view', '部署閲覧', '担当部署が自分の所属と重なる名刺を見るだけ。編集はできない'],
];

const clone = (items) => items.map((p) => ({ name: p.name, level: p.level }));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export async function renderDevPositions(container) {
  const page = document.createElement('div');
  page.className = 'page';
  container.appendChild(page);

  // Cloudflare 版には役職が無い。メニューには出さないが、URL を直接開かれたときのために止める
  if (!(state.config.features || {}).positions) {
    page.innerHTML = `${settingsNav('/developer/positions')}<h1>役職と権限</h1><p class="alert">この版には役職がありません。</p>`;
    return;
  }

  let saved = [];   // サーバーの内容
  let rows = [];    // 画面で編集中の内容
  let conflict = '';
  let fieldErrors = {}; // 'items[3].name' → メッセージ

  async function load() {
    try {
      const r = await api.get('/api/dev/positions');
      saved = clone((r.items || []).slice().sort((a, b) => a.order - b.order));
    } catch (e) { page.innerHTML = `${settingsNav('/developer/positions')}<p class="alert alert-error">${esc(e.message)}</p>`; return; }
    rows = clone(saved);
    conflict = '';
    fieldErrors = {};
    draw();
  }

  const dirty = () => !same(rows, saved);

  function rowHtml(p, i) {
    const nameErr = fieldErrors[`items[${i}].name`];
    const levelErr = fieldErrors[`items[${i}].level`];
    return `<li class="pos-row" data-i="${i}">
      <span class="pos-order"><button type="button" class="btn btn-small" data-up aria-label="上へ" ${i === 0 ? 'disabled' : ''}>↑</button><button type="button" class="btn btn-small" data-down aria-label="下へ" ${i === rows.length - 1 ? 'disabled' : ''}>↓</button></span>
      <label class="pos-name"><span class="pos-lab">役職名</span><input name="name" value="${esc(p.name)}" maxlength="30" autocomplete="off" class="${nameErr ? 'invalid' : ''}" aria-label="役職名">${nameErr ? `<small class="field-warn">${esc(nameErr)}</small>` : ''}</label>
      <label class="pos-level"><span class="pos-lab">権限の段階</span><select name="level" aria-label="権限の段階" title="${esc((LEVELS.find((l) => l[0] === p.level) || [])[2] || '')}">${LEVELS.map(([v, l]) => `<option value="${v}" ${p.level === v ? 'selected' : ''}>${l}</option>`).join('')}</select>${levelErr ? `<small class="field-warn">${esc(levelErr)}</small>` : ''}</label>
      <button type="button" class="btn btn-small btn-danger pos-del" data-del aria-label="${esc(p.name)} を削除">${icon('trash', 16)}<span>削除</span></button>
    </li>`;
  }

  // 枠は 1 回だけ描き、行の中身だけ描き直す手もあるが、行数が最大 50 なので全体を描き直して単純にする。
  // 入力中の欄を壊さないよう、名前の入力では描き直さない（change / click のときだけ）。
  function draw() {
    const listErr = fieldErrors.items;
    page.innerHTML = `${settingsNav('/developer/positions')}
      <div class="page-head"><h1>役職と権限</h1><span class="badge badge-warn" data-dirty ${dirty() ? '' : 'hidden'}>変更あり（未保存）</span></div>
      <p class="muted pos-note">役職名は、ユーザーの登録（管理コンソール、CSV 一括登録）で使う名前と一致させる。変更は 1 分以内に全員の操作に効く。</p>
      ${conflict ? `<p class="alert alert-error" role="alert">${esc(conflict)}</p>` : ''}
      ${listErr ? `<p class="alert alert-error" role="alert">${esc(listErr)}</p>` : ''}
      <ul class="pos-list">${rows.map(rowHtml).join('')}</ul>
      <div class="actions">
        <button type="button" class="btn" data-add ${rows.length >= 50 ? 'disabled' : ''}>${icon('plus', 18)}役職を足す</button>
        <button type="button" class="btn" data-reset>初期値に戻す</button>
        <button type="button" class="btn btn-primary" data-save ${dirty() ? '' : 'disabled'}>保存</button>
      </div>
      <section class="pos-legend"><h2>権限の段階でできること</h2>
        <dl>${LEVELS.map(([, l, d]) => `<dt>${l}</dt><dd>${esc(d)}</dd>`).join('')}</dl></section>`;
  }

  function markDirty() {
    const d = dirty();
    page.querySelector('[data-dirty]').hidden = !d;
    page.querySelector('[data-save]').disabled = !d;
  }

  // 並べ替えや行の追加で、エラーの行番号がずれるので消す
  const resetErrors = () => { fieldErrors = {}; conflict = ''; };

  page.addEventListener('input', (e) => {
    const li = e.target.closest('.pos-row');
    if (!li || e.target.name !== 'name') return;
    rows[Number(li.dataset.i)].name = e.target.value;
    markDirty();
  });
  page.addEventListener('change', (e) => {
    const li = e.target.closest('.pos-row');
    if (!li || e.target.name !== 'level') return;
    rows[Number(li.dataset.i)].level = e.target.value;
    e.target.title = (LEVELS.find((l) => l[0] === e.target.value) || [])[2] || '';
    markDirty();
  });
  page.addEventListener('click', async (e) => {
    const li = e.target.closest('.pos-row');
    const i = li ? Number(li.dataset.i) : -1;
    if (e.target.closest('[data-up]') && i > 0) { [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]]; resetErrors(); draw(); }
    else if (e.target.closest('[data-down]') && i < rows.length - 1) { [rows[i + 1], rows[i]] = [rows[i], rows[i + 1]]; resetErrors(); draw(); }
    else if (e.target.closest('[data-del]')) { rows.splice(i, 1); resetErrors(); draw(); }
    else if (e.target.closest('[data-add]')) {
      resetErrors(); rows.push({ name: '', level: 'dept_view' }); draw();
      const inputs = page.querySelectorAll('.pos-row input[name=name]');
      inputs[inputs.length - 1].focus();
    } else if (e.target.closest('[data-reset]')) {
      // 保存はしない。確かめてから「保存」を押してもらう
      rows = clone(DEFAULT_POSITIONS); resetErrors(); draw();
      toast('初期値を表に入れました。保存を押すまで反映されません', 'success');
    } else if (e.target.closest('[data-save]')) await save();
  });

  async function save() {
    const btn = page.querySelector('[data-save]');
    btn.disabled = true;
    try {
      await api.put('/api/dev/positions', { items: rows.map((p, i) => ({ name: p.name.trim(), level: p.level, order: i + 1 })) });
      toast('保存しました', 'success');
      await load();
    } catch (ex) {
      resetErrors();
      if (ex.code === 'validation') {
        for (const d of ex.details || []) if (d && d.field && !fieldErrors[d.field]) fieldErrors[d.field] = d.message;
        if (!Object.keys(fieldErrors).length) conflict = errorMessage(ex);
      } else conflict = errorMessage(ex); // conflict ほか。上部に赤い帯で出す
      draw();
      window.scrollTo(0, 0);
    }
  }

  await load();
}
