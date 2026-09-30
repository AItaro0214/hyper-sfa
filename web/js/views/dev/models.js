// 開発コンソール: モデル。用途ごとに選び、1 回あたりの概算費用と提供終了日を見せる。
import { estimateCost } from '/core/index.js';
import { api } from '../../api.js';
import { esc, toast, openModal, closeModal, errorMessage } from '../../ui.js';
import { settingsNav } from '../settingsNav.js';

const YEN_PER_USD = 160;
const USES = [
  ['card', '名刺の読み取り', '1 枚', { inputTokens: 2500, outputTokens: 500 }],
  ['transcribe', '文字起こし', '音声 1 時間', { inputTokens: 0, outputTokens: 0, audioSeconds: 3600 }],
  ['summarize', '議事録の作成', '1 回', { inputTokens: 30000, outputTokens: 3000 }],
];

const yen = (usd) => (usd * YEN_PER_USD >= 10 ? Math.round(usd * YEN_PER_USD) : (usd * YEN_PER_USD).toFixed(1));

function costText(model, est) {
  try {
    const now = estimateCost({ model, ...est, date: new Date() });
    let t = `約 ${yen(now)} 円`;
    if (model.pricing && model.pricing.changesAt) t += `（${model.pricing.changesAt} から約 ${yen(estimateCost({ model, ...est, date: new Date(model.pricing.changesAt) }))} 円）`;
    return t;
  } catch { return '-'; }
}

export async function renderDevModels(container) {
  const page = document.createElement('div');
  page.className = 'page';
  container.appendChild(page);
  let models = [], selection = {};

  async function load() {
    try {
      const [m, s] = await Promise.all([api.get('/api/dev/models'), api.get('/api/dev/settings')]);
      models = m.items || [];
      selection = s.models || {};
    } catch (e) { page.innerHTML = `${settingsNav('/developer/models')}<p class="alert alert-error">${esc(e.message)}</p>`; return; }
    draw();
  }
  function draw() {
    page.innerHTML = `${settingsNav('/developer/models')}<h1>モデル</h1>
      ${USES.map(([use, label, unit, est]) => `<section data-use="${use}"><h2>${label}</h2>
        <p class="muted">${unit}あたりの概算（円は ${YEN_PER_USD} 円/ドル${use === 'card' ? '、入力 2,500 / 出力 500 トークン' : ''}）</p>
        ${models.filter((m) => (m.uses || []).includes(use)).map((m) => `<label class="model ${m.active === false ? 'inactive' : ''}">
          <input type="radio" name="m-${use}" value="${esc(m.id)}" ${selection[use] === m.id ? 'checked' : ''} ${m.active === false ? 'disabled' : ''}>
          <span class="model-name">${esc(m.label || m.id)}</span> <span>${esc(costText(m, est))}</span>
          ${m.shutdownAt ? `<span class="badge badge-warn">${esc(m.shutdownAt)} に提供終了</span>` : ''}
          ${m.builtin ? '' : `<button type="button" class="link" data-toggle="${esc(m.id)}">${m.active === false ? '有効にする' : '無効にする'}</button>`}</label>`).join('') || '<p class="muted">モデルがありません。</p>'}
      </section>`).join('')}
      <div class="actions"><button type="button" class="btn btn-primary" data-save>選んだモデルを保存</button>
        <a class="btn" href="/developer/prompts">試し読み（プロンプト画面）</a>
        <button type="button" class="btn" data-add>＋ モデルを追加</button></div>`;
  }
  page.addEventListener('click', async (e) => {
    if (e.target.closest('[data-save]')) {
      try {
        for (const [use] of USES) {
          const v = page.querySelector(`input[name="m-${use}"]:checked`);
          if (v && v.value !== selection[use]) await api.put('/api/dev/model', { use, modelId: v.value });
        }
        toast('保存しました', 'success');
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
          thinkingLevel: f.elements.thinkingLevel.value.trim() || undefined, maxAudioMinutes: num('maxAudioMinutes'), shutdownAt: f.elements.shutdownAt.value || undefined, active: true,
        });
        closeModal();
        toast('追加しました', 'success');
        await load();
      } catch (ex) { err.textContent = ex.message; err.hidden = false; }
    });
  }
  await load();
}
