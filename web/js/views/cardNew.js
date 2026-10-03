// 名刺を登録する: 読み込む → 待つ → 確認・修正 → 保存。続けて何枚も登録できる。
import { api } from '../api.js';
import { state } from '../state.js';
import { esc, el, toast, confirmDialog, errorMessage, formatDate } from '../ui.js';
import { icon } from '../icons.js';
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

// 上に出す 4 つの段階。now は 0 始まり。
function stepsHtml(now) {
  const L = ['読み込む', '待つ', '確かめる', '保存'];
  const items = L.map((t, i) => `<li class="${i < now ? 'done' : i === now ? 'now' : ''}"${i === now ? ' aria-current="step"' : ''}><span class="n">${i < now ? icon('check', 13) : i + 1}</span><span class="t">${t}</span></li>`);
  return `<ol class="steps" aria-label="進み具合">${items.map((h, i) => (i ? `<li class="line${i <= now ? ' done' : ''}" aria-hidden="true"></li>` : '') + h).join('')}</ol>`;
}

export function renderCardNew(container) {
  let stopped = false;
  const root = el('<div class="page narrow"></div>');
  container.appendChild(root);
  let count = 0;

  function stepPick(message) {
    let front = null, back = null;
    root.innerHTML = `<h1>名刺を登録する</h1>${stepsHtml(0)}
      ${message ? `<p class="alert alert-ok">${message}</p>` : ''}
      <p class="alert alert-error" data-err hidden></p>
      <div class="pick step-in">
        <div class="pick-side"><h2>表面</h2>
          <img class="preview" data-prev="front" hidden alt="表面の写真">
          <label class="btn btn-primary">${icon('camera')}撮影する<input type="file" accept="image/*" capture="environment" data-file="front" hidden></label>
          <label class="btn">写真を選ぶ<input type="file" accept="image/*" data-file="front" hidden></label>
        </div>
        <div class="pick-side"><h2>裏面（任意）</h2>
          <img class="preview" data-prev="back" hidden alt="裏面の写真">
          <label class="btn">${icon('camera')}撮影する<input type="file" accept="image/*" capture="environment" data-file="back" hidden></label>
          <label class="btn">写真を選ぶ<input type="file" accept="image/*" data-file="back" hidden></label>
          <button type="button" class="link" data-clear-back hidden>裏面を外す</button>
        </div>
      </div>
      <div class="actions"><button type="button" class="btn btn-primary btn-lg" data-go disabled>${icon('search')}読み取る</button></div>`;
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
      go.insertAdjacentHTML('afterbegin', '<span class="spinner" style="width:18px;height:18px;border-width:2px;margin:0"></span>');
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
        go.innerHTML = `${icon('search')}読み取る`;
      }
    });
  }

  // 1.5 秒おきに状態を見る。60 秒で「時間がかかっています」、120 秒で失敗扱い。
  function stepWait(id, previewUrl) {
    const started = Date.now();
    root.innerHTML = `<h1>読み取っています</h1>${stepsHtml(1)}
      <div class="wait step-in"><div class="scan${previewUrl ? '' : ' noimg'}">${previewUrl ? `<img src="${esc(previewUrl)}" alt="">` : ''}</div>
      <p data-msg style="margin-top:16px">読み取っています…（ふつうは数秒です）</p></div>`;
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
    root.innerHTML = `<h1>読み取りに失敗しました</h1>${stepsHtml(1)}
      <div class="fail step-in"><p class="alert alert-warn alert-ic">${icon('warn')}<span>${esc(t.msg)}</span></p>
      <div class="actions">
        ${retry ? '<button type="button" class="btn btn-primary btn-lg" data-retry>もう一度読み取る</button>' : ''}
        ${t.redo || (!retry && !t.manual) ? '<button type="button" class="btn" data-again>撮り直す</button>' : ''}
        <button type="button" class="btn" data-manual>手で入力する</button>
      </div></div>`;
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
    root.innerHTML = `<h1>内容を確かめる</h1>${stepsHtml(2)}<div data-dup></div><div class="step-in" data-form></div>`;
    const caps = state.me.capabilities || {};
    const dupBox = root.querySelector('[data-dup]');
    let matches = card.matches || [];
    // 更新か別の人かの選択。同じ人の候補があるあいだは、選ぶまで保存できない
    let choice = null; // { kind: 'update', ofCardId } | { kind: 'separate' }
    let handle = null;
    const sameCard = () => matches.filter((m) => m.kind === 'same_card');
    const samePerson = () => matches.filter((m) => m.kind === 'same_person');
    const sameName = () => matches.filter((m) => m.kind === 'same_name');
    const cardLink = (m) => `<a href="/cards/${encodeURIComponent(m.id)}" target="_blank" rel="noopener">${esc(m.company)} ${esc(m.name)}</a>`;
    const line = (m) => [m.company, m.department, m.title].filter(Boolean).map(esc).join(' / ') || '-';

    function paintMatches() {
      const sc = sameCard(), sp = samePerson(), sn = sameName();
      if (!choice && sp.length === 0) choice = null;
      if (choice && choice.kind === 'update' && !sp.some((m) => m.id === choice.ofCardId)) choice = null;
      let html = '';
      if (sc.length) {
        html += `<div class="alert alert-error match-same-card" role="alert"><strong>この名刺はすでに登録されています</strong>
          <ul>${sc.map((m) => `<li>${cardLink(m)} <span class="muted">${line(m)}（${esc(formatDate(m.createdAt))} 登録）</span></li>`).join('')}</ul>
          <button type="button" class="btn btn-small" data-force>それでも登録する</button></div>`;
      }
      if (sp.length) {
        const canUpdate = !!caps.editCards;
        const pick = choice && choice.kind === 'update' ? choice.ofCardId : sp[0].id;
        html += `<section class="match-person" aria-label="同じ人の名刺">
          <h2>この人の名刺があります</h2>
          <ul class="match-cards">${sp.map((m) => `<li>
            ${canUpdate && sp.length > 1 ? `<label class="match-pick"><input type="radio" name="ofcard" value="${esc(m.id)}" ${m.id === pick ? 'checked' : ''}> この人</label>` : ''}
            <div>${cardLink(m)}</div>
            <div class="match-meta"><span>会社 ${esc(m.company) || '-'}</span><span>部署 ${esc(m.department) || '-'}</span><span>役職 ${esc(m.title) || '-'}</span><span>登録日 ${esc(formatDate(m.createdAt))}</span></div></li>`).join('')}</ul>
          <div class="match-choice">
            ${canUpdate ? `<button type="button" class="btn btn-lg match-btn${choice && choice.kind === 'update' ? ' on' : ''}" data-choose="update" aria-pressed="${!!(choice && choice.kind === 'update')}">更新として登録<small>前の名刺は記録に残ります</small></button>` : ''}
            <button type="button" class="btn btn-lg match-btn${choice && choice.kind === 'separate' ? ' on' : ''}" data-choose="separate" aria-pressed="${!!(choice && choice.kind === 'separate')}">別の人として登録</button>
          </div>
          ${choice ? '' : '<p class="match-need">どちらで登録するか選ぶと、保存できます。</p>'}
        </section>`;
      }
      if (sn.length) {
        html += `<p class="match-name muted">同じ名前の人がいます: ${sn.map((m) => `${cardLink(m)}（${esc(m.company) || '会社名なし'}）`).join('、')}。別の人として登録されます。</p>`;
      }
      dupBox.innerHTML = html;
      handle && handle.refreshGate();
    }
    dupBox.addEventListener('click', (e) => {
      if (e.target.closest('[data-force]')) { handle && handle.submit(); return; }
      const b = e.target.closest('[data-choose]');
      if (!b) return;
      if (b.dataset.choose === 'separate') choice = { kind: 'separate' };
      else {
        const r = dupBox.querySelector('input[name=ofcard]:checked');
        choice = { kind: 'update', ofCardId: r ? r.value : samePerson()[0].id };
      }
      paintMatches();
    });
    dupBox.addEventListener('change', (e) => {
      if (e.target.name !== 'ofcard') return;
      if (choice && choice.kind === 'update') { choice = { kind: 'update', ofCardId: e.target.value }; paintMatches(); }
    });
    paintMatches();

    handle = await mountCardForm(root.querySelector('[data-form]'), {
      card, source: 'review',
      personGate: { blocked: () => samePerson().length > 0 && !choice, action: () => (samePerson().length ? choice : null) },
      onPersonChoiceRequired: (ms) => { if (ms.length) matches = ms; else if (!samePerson().length) return; choice = null; paintMatches(); dupBox.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, submitLabel: '保存', defaultDeptIds: lastDeptIds || undefined,
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
