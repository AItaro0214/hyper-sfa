// 開発コンソール: プロンプト。保存、初期値に戻す、過去の版に戻す、試し読み。
import { PLACEHOLDERS } from '/core/index.js';
import { api } from '../../api.js';
import { esc, toast, confirmDialog, formatDateTime, errorMessage } from '../../ui.js';
import { prepareImages, uploadImages } from '../../imageUtil.js';
import { settingsNav } from '../settingsNav.js';

const KINDS = [['card', '名刺の読み取り'], ['transcribe', '文字起こし'], ['summarize', '議事録の作成'], ['qa', '質問']];

export async function renderDevPrompts(container, _p, query) {
  const page = document.createElement('div');
  page.className = 'page';
  container.appendChild(page);
  let kind = KINDS.some(([k]) => k === query.kind) ? query.kind : 'card';
  let cur = null;

  async function load() {
    page.innerHTML = `${settingsNav('/developer/prompts')}<h1>プロンプト</h1>
      <div class="pills" data-kinds>${KINDS.map(([k, l]) => `<button type="button" class="pill ${k === kind ? 'on' : ''}" data-kind="${k}">${l}</button>`).join('')}</div>
      <div data-body><p class="muted">読み込んでいます…</p></div>`;
    try { cur = await api.get(`/api/dev/prompts/${kind}`); } catch (e) { page.querySelector('[data-body]').innerHTML = `<p class="alert alert-error">${esc(e.message)}</p>`; return; }
    drawBody();
  }
  function drawBody() {
    const ph = (PLACEHOLDERS || {})[kind];
    page.querySelector('[data-body]').innerHTML = `
      <p class="muted">第 ${esc(cur.version)} 版 ${cur.isDefault ? '（初期値）' : `／ 保存: ${esc(cur.savedBy && (cur.savedBy.name || cur.savedBy))} ${esc(formatDateTime(cur.savedAt))}`}</p>
      ${ph ? `<p class="muted">差し込める値: ${ph.map((k) => `<code>{{${esc(k)}}}</code>`).join(' ')}</p>` : ''}
      <textarea class="prompt" data-text rows="18" spellcheck="false">${esc(cur.text)}</textarea>
      <div class="actions"><button type="button" class="btn btn-primary" data-save>保存</button>
        <button type="button" class="btn" data-default>初期値に戻す</button>
        <button type="button" class="btn" data-history>過去の版</button></div>
      <div data-hist></div>
      <section><h2>試し読み</h2><p class="muted">上の入力欄の内容（保存前でも可）で試します。</p><div data-test></div></section>`;
    drawTest();
  }

  function drawTest() {
    const box = page.querySelector('[data-test]');
    if (kind === 'transcribe') {
      // 契約に音声を置く API が無いため、画面からは試せない。
      box.innerHTML = '<p class="muted">文字起こしの試しは、この画面からはできません。録音した議事録で確かめてください。</p>';
      return;
    }
    box.innerHTML = kind === 'card'
      ? `<label class="field"><span>名刺の写真（表面）</span><input type="file" accept="image/*" data-img></label>
         <label class="field"><span>裏面（任意）</span><input type="file" accept="image/*" data-img-back></label>`
      : '<label class="field"><span>文字起こしの文章</span><textarea rows="6" data-tr></textarea></label>';
    box.insertAdjacentHTML('beforeend', '<div class="actions"><button type="button" class="btn" data-run>試す</button></div><div data-out></div>');
  }

  page.addEventListener('click', async (e) => {
    const kb = e.target.closest('[data-kind]');
    if (kb) { kind = kb.dataset.kind; load(); return; }
    const text = () => page.querySelector('[data-text]').value;
    try {
      if (e.target.closest('[data-save]')) { cur = await api.put(`/api/dev/prompts/${kind}`, { text: text() }); toast('保存しました', 'success'); drawBody(); }
      else if (e.target.closest('[data-default]')) {
        if (!(await confirmDialog('初期値に戻します。いまの内容は過去の版に残ります。', { okLabel: '初期値に戻す' }))) return;
        cur = await api.put(`/api/dev/prompts/${kind}`, { text: '' }); toast('初期値に戻しました', 'success'); drawBody();
      } else if (e.target.closest('[data-history]')) {
        const r = await api.get(`/api/dev/prompts/${kind}/history`);
        page.querySelector('[data-hist]').innerHTML = `<ul class="plain">${(r.items || []).map((h) => `<li><strong>第 ${esc(h.version)} 版</strong> <span class="muted">${esc(formatDateTime(h.savedAt))} ${esc(h.savedBy && (h.savedBy.name || h.savedBy))}</span>
          <button type="button" class="btn btn-small" data-revert="${esc(h.version)}">この版に戻す</button><pre class="snippet">${esc(String(h.text).slice(0, 300))}</pre></li>`).join('') || '<li class="muted">過去の版はありません。</li>'}</ul>`;
      } else if (e.target.closest('[data-revert]')) {
        cur = await api.post(`/api/dev/prompts/${kind}/revert`, { version: +e.target.closest('[data-revert]').dataset.revert });
        toast('戻しました', 'success'); await load();
      } else if (e.target.closest('[data-run]')) await runTest(text(), e.target.closest('[data-run]'));
    } catch (ex) { toast(errorMessage(ex), 'error'); }
  });

  async function runTest(promptText, btn) {
    const out = page.querySelector('[data-out]');
    btn.disabled = true;
    out.innerHTML = '<p class="muted">試しています…</p>';
    try {
      let r;
      if (kind === 'card') {
        const front = page.querySelector('[data-img]').files[0], back = page.querySelector('[data-img-back]').files[0];
        if (!front) throw new Error('写真を選んでください。');
        const keys = await uploadImages(await prepareImages(front, back));
        r = await api.post('/api/dev/scan-test', { frontKey: keys.front, backKey: keys.back, promptText });
        out.innerHTML = `<p class="muted">${esc(r.elapsedMs)} ミリ秒 ／ 入力 ${esc(r.usage?.inputTokens)} ／ 出力 ${esc(r.usage?.outputTokens)} トークン ／ 手当て: ${esc((r.repairs || []).join(', ') || 'なし')}</p>
          <h3>読み取り結果</h3><pre class="snippet">${esc(JSON.stringify(r.card, null, 2))}</pre><h3>モデルの応答</h3><pre class="snippet">${esc(r.raw)}</pre>`;
      } else {
        const transcript = page.querySelector('[data-tr]').value;
        if (!transcript.trim()) throw new Error('文字起こしの文章を貼ってください。');
        const { jobId } = await api.post('/api/dev/minutes-test', { kind: 'summarize', transcript, promptText });
        for (let i = 0; i < 120; i++) {
          await new Promise((res) => setTimeout(res, 2500));
          r = await api.get(`/api/dev/minutes-test/${encodeURIComponent(jobId)}`);
          if (r && r.text !== undefined) break;
          if (r && r.status === 'failed') throw new Error(r.message || '失敗しました');
        }
        if (!r || r.text === undefined) throw new Error('時間内に終わりませんでした。');
        out.innerHTML = `<p class="muted">${esc(r.elapsedMs)} ミリ秒 ／ 入力 ${esc(r.usage?.inputTokens)} ／ 出力 ${esc(r.usage?.outputTokens)} トークン</p><pre class="snippet">${esc(r.text)}</pre>`;
      }
    } catch (ex) { out.innerHTML = `<p class="alert alert-error">${esc(ex.message)}</p>`; }
    btn.disabled = false;
  }
  await load();
}
