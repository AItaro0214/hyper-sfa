// 開発コンソール: モデル。用途のタブで絞り、系統（Gemini / OpenAI）ごとに縦に並べる。
// 1 行 = ラジオ、名前、価格帯、プレビュー、提供終了日、単価、1 回あたりの概算、メモ。行を押すと選べる。
import { estimateCost, tierOf } from '/core/index.js';
import { api } from '../../api.js';
import { esc, toast, openModal, closeModal, errorMessage, onTextInput } from '../../ui.js';
import { icon } from '../../icons.js';
import { settingsNav } from '../settingsNav.js';

const YEN_PER_USD = 160;
const USES = [
  ['card', '名刺の読み取り', '1 枚', { inputTokens: 2500, outputTokens: 500 }, '入力 2,500 / 出力 500 トークン'],
  ['transcribe', '文字起こし', '1 時間', { inputTokens: 0, outputTokens: 0, audioSeconds: 3600 }, '音声 1 時間'],
  ['summarize', '議事録', '1 回', { inputTokens: 30000, outputTokens: 3000 }, '入力 3 万 / 出力 3 千トークン'],
];
const PROVIDERS = [['gemini', 'Gemini'], ['openai', 'OpenAI']];
const TIER_LABEL = { lite: '安い', standard: '標準', high: '高性能', top: '最上位' };

// タブと並べ替えは、画面を離れて戻っても覚えておく
const ui = { use: 'card', sort: 'cheap', q: '' };

const yen = (usd) => (usd * YEN_PER_USD >= 10 ? Math.round(usd * YEN_PER_USD).toLocaleString('ja-JP') : (usd * YEN_PER_USD).toFixed(1));
const price = (n) => (typeof n === 'number' ? `$${n % 1 ? n.toFixed(2) : n.toFixed(0)}` : null);

// 概算。トークン課金の音声（OpenAI の文字起こし）は音声の長さからトークン数が出せないので、null（「—」）にする
function cost(model, est, date) {
  try {
    const v = estimateCost({ model, ...est, date });
    return v > 0 ? v : null;
  } catch { return null; }
}
function priceLine(m) {
  const p = m.pricing || {};
  if (p.perMinute != null) return `<span>音声 $${p.perMinute}/分</span>`;
  return [p.input != null ? `<span>入力 ${price(p.input)}</span>` : '', p.output != null ? `<span>出力 ${price(p.output)}</span>` : '', '<span>/ 100 万トークン</span>'].join('');
}

export async function renderDevModels(container) {
  const page = document.createElement('div');
  page.className = 'page';
  container.appendChild(page);
  let models = [], selection = {};
  const picked = {}; // 保存前の選択（用途 → モデル ID）。タブを替えても失わない

  async function load() {
    try {
      const [m, s] = await Promise.all([api.get('/api/dev/models'), api.get('/api/dev/settings')]);
      models = m.items || [];
      selection = s.models || {};
      for (const k of Object.keys(picked)) delete picked[k];
    } catch (e) { page.innerHTML = `${settingsNav('/developer/models')}<p class="alert alert-error">${esc(e.message)}</p>`; return; }
    draw();
  }

  // 枠（タブ・並べ替え・検索・保存）は 1 回だけ描き、一覧の中だけを描き直す。検索欄を壊さないため。
  function draw() {
    page.innerHTML = `${settingsNav('/developer/models')}
      <div class="page-head"><h1>モデル</h1><button type="button" class="btn btn-primary" data-add>${icon('plus', 18)}モデルを追加</button></div>
      <div class="use-tabs" role="tablist">${USES.map(([u, l]) => `<button type="button" role="tab" data-use="${u}" class="${ui.use === u ? 'on' : ''}" aria-selected="${ui.use === u}">${l}</button>`).join('')}</div>
      <div class="model-tools">
        <div class="seg" role="group" aria-label="並べ替え"><button type="button" data-sort="cheap" class="${ui.sort === 'cheap' ? 'on' : ''}">安い順</button><button type="button" data-sort="power" class="${ui.sort === 'power' ? 'on' : ''}">高性能順</button></div>
        <input type="search" name="q" placeholder="モデルを探す" value="${esc(ui.q)}" autocomplete="off" aria-label="モデルを探す">
      </div>
      <p class="muted" data-unit style="font-size:.82rem;margin:0 0 4px"></p>
      <div data-list></div>
      <div class="model-save"><a class="btn" href="/developer/prompts">試し読み</a><button type="button" class="btn btn-primary" data-save>選んだモデルを保存</button></div>`;
    onTextInput(page.querySelector('input[name=q]'), (v) => { ui.q = v.trim(); drawList(); }, 150);
    drawList();
  }

  function drawList() {
    const [use, , unit, est, estNote] = USES.find((u) => u[0] === ui.use);
    page.querySelector('[data-unit]').textContent = `概算は${unit}あたり（${estNote}、${YEN_PER_USD} 円/ドル）`;
    const q = ui.q.toLowerCase();
    const key = (m) => cost(m, est, new Date()) ?? (m.pricing && m.pricing.output) ?? 0;
    const sign = ui.sort === 'cheap' ? 1 : -1;
    const sel = picked[use] ?? selection[use];
    let i = 0;
    const html = PROVIDERS.map(([prov, name]) => {
      const rows = models
        .filter((m) => m.provider === prov && (m.uses || []).includes(use) && (!q || `${m.label || ''} ${m.id} ${m.note || ''}`.toLowerCase().includes(q)))
        .sort((a, b) => sign * (key(a) - key(b)));
      if (!rows.length) return '';
      return `<section class="model-group"><h2>${name}</h2>${rows.map((m) => modelRow(m, use, est, sel, i++)).join('')}</section>`;
    }).join('');
    page.querySelector('[data-list]').innerHTML = html || '<p class="empty">該当するモデルがありません</p>';
  }

  function modelRow(m, use, est, sel, i) {
    const tier = m.tier || tierOf(m);
    const now = cost(m, est, new Date());
    const ch = m.pricing && m.pricing.changesAt;
    const later = ch ? cost(m, est, new Date(ch)) : null;
    const per = use === 'card' ? '1 枚あたり' : use === 'transcribe' ? '1 時間あたり' : '1 回あたり';
    return `<label class="model ${m.active === false ? 'inactive' : ''}" style="--i:${Math.min(i, 12)}">
      <input type="radio" name="m-${use}" value="${esc(m.id)}" ${sel === m.id ? 'checked' : ''} ${m.active === false ? 'disabled' : ''}>
      <span class="model-top"><span class="model-name">${esc(m.label || m.id)}</span>
        ${tier && TIER_LABEL[tier] ? `<span class="tier tier-${tier}">${TIER_LABEL[tier]}</span>` : ''}
        ${m.status === 'preview' ? '<span class="badge badge-preview">プレビュー</span>' : ''}
        ${m.shutdownAt ? `<span class="badge badge-end">${esc(m.shutdownAt)} 終了</span>` : ''}</span>
      <span class="model-est">${now == null ? '—' : `約 ${yen(now)} 円`}<small>${later != null ? `${esc(ch)} から 約 ${yen(later)} 円` : per}</small></span>
      <span class="model-price">${priceLine(m)}</span>
      ${m.note ? `<span class="model-note">${esc(m.note)}</span>` : ''}
      ${m.builtin ? '' : `<span class="model-act"><button type="button" class="link" data-toggle="${esc(m.id)}">${m.active === false ? '有効にする' : '無効にする'}</button></span>`}</label>`;
  }

  page.addEventListener('change', (e) => {
    const r = e.target.closest('input[type=radio]');
    if (r) picked[r.name.slice(2)] = r.value;
  });
  page.addEventListener('click', async (e) => {
    const tab = e.target.closest('[data-use]');
    const sort = e.target.closest('[data-sort]');
    if (tab) {
      ui.use = tab.dataset.use;
      page.querySelectorAll('[data-use]').forEach((b) => { const on = b === tab; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
      drawList();
    } else if (sort) {
      ui.sort = sort.dataset.sort;
      page.querySelectorAll('[data-sort]').forEach((b) => b.classList.toggle('on', b === sort));
      drawList();
    } else if (e.target.closest('[data-save]')) {
      try {
        let n = 0;
        for (const [use] of USES) {
          const v = picked[use];
          if (v && v !== selection[use]) { await api.put('/api/dev/model', { use, modelId: v }); n++; }
        }
        toast(n ? '保存しました' : '変更はありません', 'success');
        await load();
      } catch (ex) { toast(errorMessage(ex), 'error'); }
    } else if (e.target.closest('[data-toggle]')) {
      e.preventDefault();
      const m = models.find((x) => x.id === e.target.dataset.toggle);
      try { await api.patch(`/api/dev/models/${encodeURIComponent(m.id)}`, { active: m.active === false }); await load(); } catch (ex) { toast(errorMessage(ex), 'error'); }
    } else if (e.target.closest('[data-add]')) addModal();
  });

  function addModal() {
    const body = openModal(`<form class="stack">
      <label class="field"><span>系統</span><select name="provider"><option value="gemini">Gemini</option><option value="openai">OpenAI</option></select></label>
      <label class="field"><span>モデル ID</span><input name="id" list="avail" required autocomplete="off"><datalist id="avail"></datalist></label>
      <label class="field"><span>表示名</span><input name="label"></label>
      <div class="field"><span>用途</span><div class="radios">${USES.map(([u, l]) => `<label><input type="checkbox" name="uses" value="${u}"> ${l}</label>`).join('')}</div></div>
      <label class="field"><span>入力単価（USD / 100 万トークン）</span><input name="input" type="number" step="any" min="0" required></label>
      <label class="field"><span>出力単価（USD / 100 万トークン）</span><input name="output" type="number" step="any" min="0" required></label>
      <label class="field"><span>音声入力単価（任意）</span><input name="audioInput" type="number" step="any" min="0"></label>
      <label class="field"><span>1 分あたりの料金（USD、任意）</span><input name="perMinute" type="number" step="any" min="0"></label>
      <label class="field"><span>考える量（任意）</span><input name="thinkingLevel"></label>
      <label class="field"><span>1 回に渡せる音声の長さ（分、任意）</span><input name="maxAudioMinutes" type="number" min="1"></label>
      <label class="field"><span>提供終了日（任意）</span><input name="shutdownAt" type="date"></label>
      <label class="field"><span>公開の状態</span><select name="status"><option value="stable">安定版</option><option value="preview">プレビュー</option></select></label>
      <label class="field"><span>メモ（任意）</span><input name="note" maxlength="120" autocomplete="off"></label>
      <p class="alert alert-error" data-err hidden></p>
      <div class="actions"><button type="button" class="btn" data-close>キャンセル</button><button class="btn btn-primary" type="submit">追加</button></div></form>`, { title: 'モデルを追加' });
    const f = body.querySelector('form');
    const loadAvail = async () => {
      try {
        const r = await api.get('/api/dev/models/available', { provider: f.elements.provider.value });
        body.querySelector('#avail').innerHTML = (r.items || []).map((id) => `<option value="${esc(id)}"></option>`).join('');
      } catch { body.querySelector('#avail').innerHTML = ''; }
    };
    f.elements.provider.addEventListener('change', loadAvail);
    loadAvail();
    body.querySelector('[data-close]').addEventListener('click', closeModal);
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const num = (n) => (f.elements[n].value === '' ? undefined : Number(f.elements[n].value));
      const uses = [...f.querySelectorAll('input[name=uses]:checked')].map((x) => x.value);
      const err = body.querySelector('[data-err]');
      if (!uses.length) { err.textContent = '用途を 1 つ以上選んでください。'; err.hidden = false; return; }
      try {
        await api.post('/api/dev/models', {
          id: f.elements.id.value.trim(), provider: f.elements.provider.value, label: f.elements.label.value.trim() || f.elements.id.value.trim(), uses,
          pricing: { input: num('input'), output: num('output'), audioInput: num('audioInput'), perMinute: num('perMinute') },
          thinkingLevel: f.elements.thinkingLevel.value.trim() || undefined, maxAudioMinutes: num('maxAudioMinutes'), shutdownAt: f.elements.shutdownAt.value || undefined, status: f.elements.status.value, note: f.elements.note.value.trim() || undefined, active: true,
        });
        closeModal();
        toast('追加しました', 'success');
        await load();
      } catch (ex) { err.textContent = ex.message; err.hidden = false; }
    });
  }
  await load();
}
