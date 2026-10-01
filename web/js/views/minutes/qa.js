// 議事録の「質問」タブ（minutes-design §16.2）。文字起こしと資料をもとに LLM が答える。スレッドは利用者ごと。
import { api } from '../../api.js';
import { toast } from '../../ui.js';
import { esc, renderMarkdown, ask, errMessage } from './util.js';

const MAX_LEN = 2000;
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
const SEND_KEY = isMac ? '⌘' : 'Ctrl';

// 答えの [HH:MM:SS] を押せる印にする。esc 済みの HTML に対して置き換えるので、外から来た文字は混ざらない
function answerHtml(text) {
  return renderMarkdown(text).replace(/\[(\d{1,2}:\d{2}:\d{2})\]/g, (_, t) => `<button type="button" class="mn-link mn-qa-time" data-seek="${t}">[${t}]</button>`);
}

function failText(e) {
  if (e && e.code === 'rate_limited') return '今日の質問の上限（1 日 200 回）に達しました。明日また試してください。';
  if (e && e.code === 'provider_error') return '答えを作れませんでした。時間をおいて、もう一度送ってください。';
  if (e && e.code === 'validation') return e.message || '質問を送れませんでした。内容を確かめてください。';
  return errMessage(e, '答えを作れませんでした。もう一度送ってください。');
}

/**
 * @param {HTMLElement} box 描く先
 * @param {{ id: string, data: { items: object[], modelLabel?: string }, onSeek: (clock: string) => void }} o
 */
export function renderQa(box, { id, data, onSeek }) {
  // タブを往復しても残るよう、data.items をそのまま使う
  if (!Array.isArray(data.items)) data.items = [];
  let items = data.items;
  const modelLabel = data.modelLabel || '';
  let pending = null; // 送信中の質問の文字
  let alive = true;

  box.innerHTML = `<div class="mn-qa">
    <p class="mn-muted mn-qa-note">文字起こしと資料をもとに答えます（議事録は渡しません）</p>
    <div class="mn-qa-log" data-r="log" aria-live="polite"></div>
    <div class="mn-qa-bar">
      <div class="mn-qa-form">
        <textarea class="mn-input mn-qa-input" data-r="input" rows="2" maxlength="${MAX_LEN}" placeholder="質問を入力…" aria-label="質問"></textarea>
        <button type="button" class="mn-btn mn-btn-primary" data-r="send">送る</button>
      </div>
      <div class="mn-qa-foot"><button type="button" class="mn-link" data-r="clear">履歴を消す</button><span class="mn-faint" data-r="count"></span><span class="mn-faint mn-qa-hint">Enter で改行、${SEND_KEY}+Enter で送信</span><span class="mn-muted">${modelLabel ? `モデル: ${esc(modelLabel)}` : ''}</span></div>
    </div></div>`;
  const log = box.querySelector('[data-r=log]');
  const input = box.querySelector('[data-r=input]');
  const sendBtn = box.querySelector('[data-r=send]');
  const clearBtn = box.querySelector('[data-r=clear]');
  const count = box.querySelector('[data-r=count]');

  function paintLog({ scroll = true } = {}) {
    const rows = items.map((x) => (x.role === 'user'
      ? `<div class="mn-qa-q"><div class="mn-qa-bubble mn-pre">${esc(x.text)}</div></div>`
      : `<div class="mn-qa-a"><div class="mn-qa-bubble mn-md">${answerHtml(x.text)}</div></div>`));
    if (pending !== null) {
      rows.push(`<div class="mn-qa-q"><div class="mn-qa-bubble mn-pre">${esc(pending)}</div></div>`);
      rows.push('<div class="mn-qa-a"><div class="mn-qa-bubble mn-qa-wait" role="status" aria-label="答えを作っています"><i></i><i></i><i></i></div></div>');
    }
    log.innerHTML = rows.length ? rows.join('') : '<p class="mn-muted mn-qa-empty">たとえば「値引きの話は出ましたか？」「次回までの宿題は？」のように聞いてみてください。</p>';
    clearBtn.hidden = !items.length || pending !== null;
    if (scroll) log.scrollTop = log.scrollHeight;
  }

  function paintCount() {
    const n = input.value.length;
    count.textContent = n > MAX_LEN - 200 ? `${n} / ${MAX_LEN}` : '';
  }

  function setBusy(on) {
    input.disabled = on;
    sendBtn.disabled = on;
    sendBtn.textContent = on ? '送信中…' : '送る';
  }

  async function send() {
    const text = input.value.trim();
    if (!text || pending !== null) return;
    if (text.length > MAX_LEN) { toast(`質問は ${MAX_LEN} 字までです`, 'error'); return; }
    pending = text;
    input.value = '';
    paintCount();
    setBusy(true);
    paintLog();
    try {
      const r = await api.post(`/api/minutes/${id}/chat`, { text });
      if (!alive) return;
      items.push(r.question, r.answer);
    } catch (e) {
      if (!alive) return;
      input.value = text; // 失敗したら質問を戻し、そのまま送り直せるようにする
      toast(failText(e), 'error');
    } finally {
      if (alive) {
        pending = null;
        setBusy(false);
        paintLog();
        paintCount();
        input.focus({ preventScroll: true });
      }
    }
  }

  sendBtn.addEventListener('click', send);
  input.addEventListener('input', paintCount);
  // Enter は改行。送信は Ctrl+Enter（Mac は ⌘+Enter）。日本語入力の確定の Enter では送らない
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); send(); }
  });
  log.addEventListener('click', (e) => {
    const b = e.target.closest('[data-seek]');
    if (b) onSeek(b.dataset.seek);
  });
  clearBtn.addEventListener('click', async () => {
    if (!(await ask('この議事録での、あなたの質問と答えをすべて消します。ほかの人の履歴には影響しません。元に戻せません。', { okLabel: '消す', danger: true }))) return;
    try {
      await api.del(`/api/minutes/${id}/chat`);
      items = data.items = [];
      paintLog();
      toast('履歴を消しました');
    } catch (e) { toast(errMessage(e), 'error'); }
  });

  paintLog();
  return () => { alive = false; };
}

/** 自分のスレッドを読む。読めない（文字起こしが無いなど）ときは available: false にそろえる。 */
export async function loadChat(id) {
  try {
    const r = await api.get(`/api/minutes/${id}/chat`);
    return { items: [], modelLabel: '', ...r, available: r.available !== false };
  } catch {
    return { items: [], modelLabel: '', available: false };
  }
}
