// 名刺を登録する: 読み込む → 待つ → 確認・修正 → 保存。続けて何枚も登録できる。
import { api } from '../api.js';
import { state } from '../state.js';
import { esc, el, toast, confirmDialog, errorMessage } from '../ui.js';
import { prepareImages, uploadImages } from '../imageUtil.js';
import { mountCardForm } from './cardEdit.js';

// 続けて登録するときに、前の担当部署を引き継ぐ。
let lastDeptIds = null;

// §5.7 の表。retry は「もう一度読み取る」、redo は「撮り直す／手で入力する」。
const FAIL_TEXT = {
  parse: { msg: '読み取り結果を受け取れませんでした', retry: true },
  truncated: { msg: '読み取りが途中で止まりました', retry: true, partial: true },
  provider: { msg: '混み合っていて読み取れませんでした', retry: true },
  empty: { msg: '名刺の文字を読み取れませんでした', retry: true, redo: true },
  blocked: { msg: 'この写真は読み取れませんでした', redo: true },
  not_configured: { msg: '設定に問題があります。開発者に連絡してください', manual: true },
  timeout: { msg: '読み取りに時間がかかりすぎています', retry: true },
};

export function renderCardNew(container) {
  let stopped = false;
  const root = el('<div class="page narrow"></div>');
  container.appendChild(root);
  let count = 0;

  function stepPick(message) {
    let front = null, back = null;
    root.innerHTML = `<h1>名刺を登録する</h1>
      ${message ? `<p class="alert alert-ok">${message}</p>` : ''}
      <p class="alert alert-error" data-err hidden></p>
      <div class="pick">
        <div class="pick-side"><h2>表面</h2>
          <img class="preview" data-prev="front" hidden alt="表面の写真">
          <label class="btn btn-primary">撮影する<input type="file" accept="image/*" capture="environment" data-file="front" hidden></label>
          <label class="btn">写真を選ぶ<input type="file" accept="image/*" data-file="front" hidden></label>
        </div>
        <div class="pick-side"><h2>裏面（任意）</h2>
          <img class="preview" data-prev="back" hidden alt="裏面の写真">
          <label class="btn">撮影する<input type="file" accept="image/*" capture="environment" data-file="back" hidden></label>
          <label class="btn">写真を選ぶ<input type="file" accept="image/*" data-file="back" hidden></label>
          <button type="button" class="link" data-clear-back hidden>裏面を外す</button>
        </div>
      </div>
      <div class="actions"><button type="button" class="btn btn-primary" data-go disabled>読み取る</button></div>`;
    const go = root.querySelector('[data-go]');
    const errBox = root.querySelector('[data-err]');
    root.querySelector('.pick').addEventListener('change', (e) => {
      const inp = e.target.closest('input[type=file]');
      if (!inp || !inp.files[0]) return;
      const side = inp.dataset.file;
      if (side === 'front') front = inp.files[0]; else back = inp.files[0];
      const img = root.querySelector(`[data-prev="${side}"]`);
      img.src = URL.createObjectURL(inp.files[0]);
      img.hidden = false;
      root.querySelector('[data-clear-back]').hidden = !back;
      go.disabled = !front;
      inp.value = '';
    });
    root.querySelector('[data-clear-back]').addEventListener('click', (e) => {
      back = null; root.querySelector('[data-prev="back"]').hidden = true; e.target.hidden = true;
    });
    go.addEventListener('click', async () => {
      go.disabled = true;
      errBox.hidden = true;
      go.textContent = 'アップロードしています…';
      try {
        const blobs = await prepareImages(front, back);
        const keys = await uploadImages(blobs);
        const body = { frontKey: keys.front, thumbKey: keys.thumb };
        if (keys.back) body.backKey = keys.back;
        if (lastDeptIds && state.config.features.departments) body.deptIds = lastDeptIds;
        const r = await api.post('/api/cards/scan', body);
        stepWait(r.id, URL.createObjectURL(blobs.thumb));
      } catch (e) {
        errBox.textContent = errorMessage(e);
        errBox.hidden = false;
        go.disabled = false;
        go.textContent = '読み取る';
      }
    });
  }

  // 1.5 秒おきに状態を見る。60 秒で「時間がかかっています」、120 秒で失敗扱い。
  function stepWait(id, previewUrl) {
    const started = Date.now();
    root.innerHTML = `<h1>読み取っています</h1>
      <div class="wait">${previewUrl ? `<img class="preview" src="${esc(previewUrl)}" alt="">` : ''}
      <div class="spinner" aria-hidden="true"></div>
      <p data-msg>読み取っています…（ふつうは数秒です）</p></div>`;
    const msg = root.querySelector('[data-msg]');
    const tick = async () => {
      if (stopped) return;
      const elapsed = Date.now() - started;
      if (elapsed > 120_000) return stepFailed(id, { kind: 'timeout', retryable: true });
      if (elapsed > 60_000) msg.textContent = '時間がかかっています。もう少しお待ちください。';
      try {
        const r = await api.get(`/api/cards/${encodeURIComponent(id)}/status`);
        if (stopped) return;
        if (r.status === 'review' || r.status === 'confirmed') return stepReview(r.card || (await api.get(`/api/cards/${encodeURIComponent(id)}`)));
        if (r.status === 'failed') return stepFailed(id, r.failure || r.card?.failure || { kind: 'parse', retryable: true });
      } catch (e) {
        if (e.status === 401) return;
        // 通信の一時的な失敗は待ち続ける。120 秒の上限が止めてくれる。
      }
      setTimeout(tick, 1500);
    };
    setTimeout(tick, 1500);
  }

  function stepFailed(id, failure) {
    const t = FAIL_TEXT[failure.kind] || { msg: failure.message || '読み取りに失敗しました', retry: failure.retryable };
    const retry = t.retry && failure.retryable !== false;
    root.innerHTML = `<h1>読み取りに失敗しました</h1>
      <p class="alert alert-error">${esc(t.msg)}</p>
      <div class="actions">
        ${retry ? '<button type="button" class="btn btn-primary" data-retry>もう一度読み取る</button>' : ''}
        ${t.redo || (!retry && !t.manual) ? '<button type="button" class="btn" data-again>撮り直す</button>' : ''}
        <button type="button" class="btn" data-manual>手で入力する</button>
      </div>`;
    root.querySelector('[data-retry]')?.addEventListener('click', () => rescan(id));
    root.querySelector('[data-again]')?.addEventListener('click', () => stepPick());
    root.querySelector('[data-manual]').addEventListener('click', async () => {
      try { stepReview(await api.get(`/api/cards/${encodeURIComponent(id)}`)); } catch (e) { toast(errorMessage(e), 'error'); }
    });
  }

  async function rescan(id) {
    try {
      await api.post(`/api/cards/${encodeURIComponent(id)}/rescan`);
      stepWait(id);
    } catch (e) { toast(errorMessage(e), 'error'); }
  }

  async function stepReview(card) {
    root.innerHTML = '<h1>内容を確かめる</h1><div data-dup></div><div data-form></div>';
    const dups = card.duplicates || [];
    if (dups.length) {
      root.querySelector('[data-dup]').innerHTML = `<div class="alert alert-warn"><strong>似た名刺がすでにあります。</strong>
        <ul>${dups.map((d) => `<li><a href="/cards/${encodeURIComponent(d.id)}" target="_blank" rel="noopener">${esc(d.company)} ${esc(d.name)}</a>（${d.reason === 'email' ? '同じメールアドレス' : '同じ会社名と氏名'}）</li>`).join('')}</ul>
        <p class="muted">別の人なら、そのまま保存すると別の名刺として登録されます。</p></div>`;
    }
    await mountCardForm(root.querySelector('[data-form]'), {
      card, source: 'review', submitLabel: '保存', defaultDeptIds: lastDeptIds || undefined,
      extraButtons: [{
        label: '読み取り直す',
        onClick: async (form) => {
          if (form.isDirty() && !(await confirmDialog('直した内容は置き換わります。読み取り直しますか？', { okLabel: '読み取り直す' }))) return;
          rescan(card.id);
        },
      }],
      onSaved: (saved) => {
        count++;
        if (saved.deptIds && saved.deptIds.length) lastDeptIds = saved.deptIds;
        stepPick(`登録しました（${count} 枚目）。<a href="/cards/${encodeURIComponent(saved.id)}">${esc(saved.name || saved.company || '詳細')}</a> ／ 続けて登録できます。`);
      },
    });
  }

  stepPick();
  return () => { stopped = true; };
}
