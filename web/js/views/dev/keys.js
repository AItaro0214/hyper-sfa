// 開発コンソール: API キー。登録済みのキーは末尾 4 文字と更新日時だけ見せる。
import { api } from '../../api.js';
import { esc, toast, formatDateTime, errorMessage } from '../../ui.js';
import { settingsNav } from '../settingsNav.js';

const PROVIDERS = [['gemini', 'Gemini'], ['openai', 'OpenAI']];

export async function renderDevKeys(container) {
  const page = document.createElement('div');
  page.className = 'page narrow';
  container.appendChild(page);
  let settings;
  async function load() {
    try { settings = await api.get('/api/dev/settings'); } catch (e) { page.innerHTML = `${settingsNav('/developer/keys')}<p class="alert alert-error">${esc(e.message)}</p>`; return; }
    draw();
  }
  function draw() {
    page.innerHTML = `${settingsNav('/developer/keys')}<h1>API キー</h1>
      ${PROVIDERS.map(([p, label]) => {
        const k = (settings.keys || {})[p] || {};
        return `<section class="key" data-p="${p}"><h2>${label}</h2>
          <p>${k.configured ? `登録済み（末尾 ${esc(k.last4)}）／ 更新 ${esc(formatDateTime(k.updatedAt))}` : '<span class="muted">未登録</span>'}</p>
          <label class="field"><span>${k.configured ? '新しいキーに更新' : 'キーを入力'}</span><input type="password" autocomplete="off" data-key placeholder="キーを貼り付け"></label>
          <div class="actions"><button type="button" class="btn btn-primary" data-save>保存</button>
          <button type="button" class="btn" data-test ${k.configured ? '' : 'disabled'}>接続テスト</button></div>
          <p class="muted" data-result></p></section>`;
      }).join('')}
      <p class="muted">Gemini のキーだけで、初期値のモデルはすべて動きます。</p>`;
  }
  page.addEventListener('click', async (e) => {
    const sec = e.target.closest('[data-p]');
    if (!sec) return;
    const p = sec.dataset.p, res = sec.querySelector('[data-result]');
    if (e.target.closest('[data-save]')) {
      const inp = sec.querySelector('[data-key]');
      const key = inp.value.trim();
      if (!key) return toast('キーを入力してください', 'error');
      try { settings = await api.put(`/api/dev/keys/${p}`, { key }); toast('保存しました', 'success'); draw(); } catch (ex) { toast(errorMessage(ex), 'error'); }
    } else if (e.target.closest('[data-test]')) {
      res.textContent = '確かめています…';
      try { const r = await api.post(`/api/dev/keys/${p}/test`); res.textContent = r.ok ? `接続できました（使えるモデル ${r.models} 件）` : '接続できませんでした'; }
      catch (ex) { res.textContent = `接続できませんでした: ${ex.message}`; }
    }
  });
  await load();
}
