// /minutes/:id 議事録の画面（minutes-design §3.4）。
// 処理中は 3 秒おきに状態を読む。読むたびに全体を描き直さず、進み具合の欄だけを更新し、
// 状態が変わったとき（完了・失敗など）にだけ全体を描き直す。
import { api } from '../../api.js';
import { navigate } from '../../router.js';
import { toast, formatDateTime } from '../../ui.js';
import {
  esc, statusChipHtml, modeBadgeHtml, statusText, isProcessing, clock, durationJa, counterpartLabel, renderMarkdown,
  ask, copyText, errMessage,
} from './util.js';
import { openShareDialog } from './share.js';
import { mountPeopleEditor, peopleToPayload } from './pickers.js';
import { renderMaterials } from './materials.js';
import { renderQa, loadChat } from './qa.js';

const POLL_MS = 3000;
const GIVE_UP_MS = 20 * 60 * 1000; // api-contract §8: 20 分で失敗扱い

export function renderDetail(container, params) {
  const id = params.id;
  let m = null;
  let tab = 'summary';
  let timer = null;
  let gone = false;
  let pollStart = 0;
  let sig = '';
  const cache = {}; // タブごとの本文
  let qa = null; // 質問タブ用に読んだ自分のスレッド。null = 未確認、{ available: false } = タブを出さない
  let qaStop = null;

  container.innerHTML = '<div class="mn-page"><p class="mn-muted">読み込んでいます…</p></div>';

  const stop = () => { clearTimeout(timer); timer = null; };
  const alive = () => !gone && container.isConnected;

  async function load({ quiet = false } = {}) {
    try {
      const next = await api.get(`/api/minutes/${id}`);
      if (!alive()) return;
      const changed = !m || signature(next) !== sig || next.status !== m.status;
      const prevStatus = m && m.status;
      m = next;
      // 処理が終わったら、本文を読み直す
      if (prevStatus && prevStatus !== m.status) { delete cache.summary; delete cache.transcript; qa = null; }
      sig = signature(m);
      if (changed) paint(); else paintProgress();
      probeQa();
      schedule();
    } catch (e) {
      if (!alive()) return;
      if (!m) {
        container.innerHTML = `<div class="mn-page"><p class="mn-error">${esc(e.status === 404 ? 'この議事録は見つかりません。削除されたか、見られる範囲の外です。' : errMessage(e))}</p><a class="mn-btn" href="/minutes">議事録の一覧へ</a></div>`;
      } else if (!quiet) toast(errMessage(e), 'error');
      else schedule();
    }
  }
  function signature(x) {
    return JSON.stringify([x.status, x.title, x.durationSec, x.memo, x.counterparts, x.attendees, x.shares, x.audio, x.materials, x.summary && x.summary.version, x.summary && x.summary.withMaterials, x.transcript && x.transcript.version, x.failure]);
  }
  function schedule() {
    stop();
    if (m && isProcessing(m.status)) {
      if (!pollStart) pollStart = Date.now();
      if (Date.now() - pollStart > GIVE_UP_MS) return; // 描画側で失敗扱いにする
      timer = setTimeout(() => load({ quiet: true }), POLL_MS);
    } else pollStart = 0;
  }

  const isOwner = () => m.relation === 'owner';

  function paint() {
    const own = isOwner();
    const failedByTimeout = isProcessing(m.status) && pollStart && Date.now() - pollStart > GIVE_UP_MS;
    const cps = (m.counterparts || []).map((c) => {
      const open = c.cardId && c.cardVisible ? ` <a href="/cards/${esc(c.cardId)}">名刺を開く</a>` : '';
      return `<span>${esc(counterpartLabel(c))}${c.department ? `（${esc(c.department)}）` : ''}${open}</span>`;
    }).join('、 ');
    container.innerHTML = `<div class="mn-page mn-detail">
      <p><a href="/minutes">← 議事録の一覧</a></p>
      <div class="mn-head"><div><h1>${esc(m.title || '（無題）')}</h1>${statusChipHtml(m)}${modeBadgeHtml(m)}${m.relation === 'shared' ? '<span class="mn-badge">共有された</span>' : ''}</div>
        <div class="mn-muted">${esc(formatDateTime(m.heldAt))}　${esc(durationJa(m.durationSec))}</div></div>
      <dl class="mn-meta">
        <dt>相手</dt><dd>${cps || '<span class="mn-muted">（なし）</span>'}</dd>
        <dt>同席</dt><dd>${(m.attendees || []).map((a) => esc(a.name)).join('、') || '<span class="mn-muted">（なし）</span>'}</dd>
        <dt>作った人</dt><dd>${esc(m.owner && m.owner.name)}</dd>
        ${own ? `<dt>共有</dt><dd>${(m.shares || []).map((s) => esc(s.name)).join('、') || '<span class="mn-muted">（なし）</span>'} <button class="mn-btn mn-btn-sm" data-share>共有する</button></dd>` : ''}
        ${m.memo ? `<dt>メモ</dt><dd class="mn-pre">${esc(m.memo)}</dd>` : ''}
      </dl>
      ${own ? '<div><button class="mn-btn mn-btn-sm" data-edit>相手・同席者・メモを直す</button></div>' : ''}
      <div data-r="progress"></div>
      ${failedByTimeout ? `<div class="mn-alert mn-alert-error">20 分たっても進まないため、失敗として扱います。${own ? '<button class="mn-btn" data-retry>もう一度試す</button>' : ''}</div>` : ''}
      ${m.status === 'recording' ? '' : '<div data-r="materials"></div>'}
      <div class="mn-tabs" role="tablist">${tabsHtml()}</div>
      <div data-r="body" class="mn-body"></div>
      <div data-r="actions" class="mn-actions"></div>
    </div>`;
    paintProgress();
    const matBox = container.querySelector('[data-r=materials]');
    if (matBox) renderMaterials(matBox, m, { onChanged: () => { pollStart = 0; return load({ quiet: true }); } });
    paintBody();
    paintActions();
  }

  // 質問のタブは、文字起こしがあって質問が使えるときだけ出す（minutes-design §16.2）
  const qaOn = () => Boolean(m.transcript && qa && qa.available && !qa.pending);
  function tabsHtml() {
    const list = [['summary', '議事録'], ['transcript', '文字起こし'], ['audio', '音声']];
    if (qaOn()) list.push(['qa', '質問']);
    return list.map(([k, l]) => `<button role="tab" class="mn-tab${tab === k ? ' on' : ''}" data-tab="${k}">${l}</button>`).join('');
  }
  async function probeQa() {
    if (qa !== null || !m.transcript || isProcessing(m.status)) return;
    qa = { pending: true };
    const r = await loadChat(id);
    if (!alive()) return;
    qa = r;
    const tabs = container.querySelector('.mn-tabs');
    if (tabs) tabs.innerHTML = tabsHtml();
  }

  // 状態の欄だけ更新（処理中の 3 秒おきの更新で使う）
  function paintProgress() {
    const box = container.querySelector('[data-r=progress]');
    if (!box) return;
    if (isProcessing(m.status)) {
      const p = m.progress;
      const pct = p && p.segmentsTotal ? Math.round((p.segmentsDone / p.segmentsTotal) * 100) : null;
      box.innerHTML = `<div class="mn-alert"><strong>${esc(statusText(m))}</strong><div class="mn-muted">画面を閉じても続きます。一覧に状態が出ます。</div>
        ${pct === null ? '' : `<div class="mn-bar"><i style="width:${pct}%"></i></div>`}</div>`;
    } else if (m.status === 'failed') {
      const f = m.failure || {};
      const text = f.kind === 'not_configured' ? '設定に問題があります。開発者に連絡してください。' : (f.message || 'うまくいきませんでした。');
      box.innerHTML = `<div class="mn-alert mn-alert-error"><strong>${f.step === 'outline' ? '資料の目次作成' : f.step === 'summarize' ? '議事録の作成' : '文字起こし'}に失敗しました。</strong><div>${esc(text)}</div>
        <div class="mn-muted">録音は保存されています。</div>
        ${isOwner() && f.retryable !== false && f.kind !== 'not_configured' ? '<button class="mn-btn mn-btn-primary" data-retry>もう一度試す</button>' : ''}</div>`;
    } else if (m.status === 'uploaded') {
      box.innerHTML = `<div class="mn-alert">録音は保存済みです。まだ議事録は作っていません。${isOwner() ? '<button class="mn-btn mn-btn-primary" data-retry>議事録を作る</button>' : ''}</div>`;
    } else if (m.status === 'recording') {
      box.innerHTML = '<div class="mn-alert">録音中、または途中で止まっています。端末に残った録音があれば、議事録の一覧を開くと送れます。</div>';
    } else box.innerHTML = '';
  }

  async function paintBody() {
    const body = container.querySelector('[data-r=body]');
    if (!body) return;
    if (qaStop) { qaStop(); qaStop = null; }
    if (tab === 'qa' && !qaOn() && !(qa && qa.pending)) tab = 'summary';
    const mine = tab;
    if (mine === 'audio') return paintAudio(body);
    if (mine === 'qa') {
      if (!qaOn()) { body.innerHTML = '<p class="mn-muted">読み込んでいます…</p>'; return; }
      qaStop = renderQa(body, { id, data: qa, onSeek: seekTranscript });
      return;
    }
    const has = mine === 'summary' ? m.summary : m.transcript;
    if (!has) {
      body.innerHTML = `<p class="mn-muted">${isProcessing(m.status) ? 'できあがるまでお待ちください。' : mine === 'summary' ? '議事録はまだありません。' : '文字起こしはまだありません。'}</p>`;
      return;
    }
    const render = () => {
      if (tab !== mine || !body.isConnected) return;
      body.innerHTML = mine === 'summary' ? summaryHtml(cache.summary) : transcriptHtml(cache.transcript.text);
    };
    if (cache[mine] && cache[mine].version === has.version) return render();
    body.innerHTML = '<p class="mn-muted">読み込んでいます…</p>';
    try {
      cache[mine] = await api.get(`/api/minutes/${id}/${mine}`);
      render();
    } catch (e) {
      if (tab === mine && body.isConnected) body.innerHTML = `<p class="mn-error">${esc(errMessage(e))}</p>`;
    }
  }

  // 資料を踏まえた版は印を付け、対応表（資料のページ → 時刻）を議事録の下に出す
  function summaryHtml(sum) {
    const withMat = sum.withMaterials ?? (m.summary && m.summary.withMaterials);
    const mapping = Array.isArray(sum.mapping) ? sum.mapping : [];
    const kindOf = (mid) => { const x = (m.materials || []).find((y) => y.id === mid || y.seq === mid); return x && x.kind; };
    const pageLabel = (r) => (kindOf(r.material) === 'pptx' ? `スライド ${r.page}` : `${r.page} ページ`);
    const table = mapping.length ? `<div class="mn-map"><h3>資料と話の対応</h3><div class="mn-map-scroll"><table class="mn-table">
      <thead><tr><th>資料</th><th>ページ</th><th>時刻</th><th>確信度</th></tr></thead><tbody>
      ${mapping.map((r) => `<tr><td>${esc(r.materialName || '')}</td><td>${esc(pageLabel(r))}</td>
        <td><button type="button" class="mn-link" data-seek="${esc(r.start)}">${esc(r.start)}</button>〜${esc(r.end || '')}</td>
        <td>${r.confidence === 'low' ? '<span class="mn-faint">推定</span>' : ''}</td></tr>`).join('')}
      </tbody></table></div></div>` : '';
    return `${withMat ? '<p><span class="mn-badge mn-badge-mat">資料を踏まえた版</span></p>' : ''}<div class="mn-md">${renderMarkdown(sum.markdown)}</div>${table}`;
  }

  // 各行の [HH:MM:SS] を秒に直して data-sec に持たせる。対応表から飛ぶとき、一番近い行を探すため
  function transcriptHtml(text) {
    const lines = String(text || '').split('\n').map((line, i) => {
      const t = /\[(\d{1,2}):(\d{2}):(\d{2})\]/.exec(line);
      const sec = t ? Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]) : null;
      return `<span class="mn-tl" id="tl-${i}"${sec === null ? '' : ` data-sec="${sec}"`}>${esc(line)}\n</span>`;
    });
    return `<pre class="mn-transcript">${lines.join('')}</pre>`;
  }

  async function seekTranscript(clockText) {
    const t = /(\d{1,2}):(\d{2}):(\d{2})/.exec(clockText || '');
    if (!t) return;
    const target = Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]);
    tab = 'transcript';
    container.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === 'transcript'));
    paintActions();
    await paintBody();
    let best = null; let diff = Infinity;
    container.querySelectorAll('.mn-tl[data-sec]').forEach((e) => {
      const d = Math.abs(Number(e.dataset.sec) - target);
      if (d < diff) { diff = d; best = e; }
    });
    if (!best) { toast('文字起こしに時刻の付いた行がありません', 'error'); return; }
    best.scrollIntoView({ block: 'center', behavior: 'smooth' });
    best.classList.add('mn-flash');
    setTimeout(() => best.classList.remove('mn-flash'), 2500);
  }

  async function paintAudio(body) {
    const a = m.audio || {};
    if (!a.available || a.deleted) {
      body.innerHTML = '<p class="mn-muted">音声は削除されました。文字起こしと議事録は残っています。</p>';
      return;
    }
    const days = a.expiresAt ? Math.max(0, Math.ceil((new Date(a.expiresAt) - Date.now()) / 86400000)) : null;
    body.innerHTML = `<p class="mn-muted" data-r="a-load">音声を準備しています…</p>
      <audio controls preload="none" data-r="player" hidden></audio>
      <div class="mn-row"><button class="mn-btn" data-download>ダウンロード</button>
      ${days === null ? '' : `<span class="${days <= 2 ? 'mn-warn' : 'mn-muted'}">あと ${days} 日で削除されます${days <= 2 ? '。文字起こしのやり直しもそれまでです' : ''}</span>`}</div>`;
    try {
      const r = await api.get(`/api/minutes/${id}/audio-url`);
      if (tab !== 'audio' || !body.isConnected) return;
      const p = body.querySelector('[data-r=player]');
      p.src = r.url; p.hidden = false;
      body.querySelector('[data-r=a-load]').remove();
    } catch (e) {
      const l = body.querySelector('[data-r=a-load]');
      if (l) l.innerHTML = esc(e.status === 404 ? '音声は削除されました。' : errMessage(e));
    }
  }

  function paintActions() {
    const box = container.querySelector('[data-r=actions]');
    if (!box) return;
    const own = isOwner();
    const busy = isProcessing(m.status);
    const canText = tab === 'summary' ? m.summary : tab === 'transcript' ? m.transcript : null;
    const btns = [];
    if (tab === 'summary' && m.summary) btns.push('<button class="mn-btn" data-copy>コピー</button>');
    if (tab === 'transcript' && m.transcript) btns.push('<button class="mn-btn" data-copy>コピー</button>');
    if (own && !busy) {
      if (m.transcript) btns.push('<button class="mn-btn" data-regen="summary">議事録を作り直す</button>');
      if (m.audio && m.audio.available && !m.audio.deleted && m.status !== 'uploaded' && m.status !== 'recording') btns.push('<button class="mn-btn" data-regen="transcript">文字起こしからやり直す</button>');
      if (canText && canText.hasPrevious) btns.push('<button class="mn-btn" data-revert>前の内容に戻す</button>');
    }
    if (own) btns.push('<button class="mn-btn mn-btn-danger" data-delete>削除</button>');
    box.innerHTML = btns.join('');
  }

  async function act(btn, fn) {
    if (btn) btn.disabled = true;
    try { await fn(); } catch (e) { toast(errMessage(e), 'error'); } finally { if (btn && btn.isConnected) btn.disabled = false; }
  }

  container.addEventListener('click', async (e) => {
    const t = e.target.closest('button, a');
    if (!t) return;
    if (t.dataset.seek) { seekTranscript(t.dataset.seek); return; }
    if (t.dataset.tab) { tab = t.dataset.tab; container.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b === t)); paintBody(); paintActions();
      // 質問はページの下の方にあるので、タブごと画面の上に寄せて、履歴と入力欄が見えるようにする
      if (tab === 'qa') container.querySelector('.mn-tabs').scrollIntoView({ block: 'start', behavior: 'smooth' });
      return; }
    if (t.hasAttribute('data-share')) { openShareDialog(m, () => load({ quiet: true })); return; }
    if (t.hasAttribute('data-edit')) { openEdit(); return; }
    if (t.hasAttribute('data-retry')) {
      act(t, async () => { await api.post(`/api/minutes/${id}/generate`); pollStart = 0; toast('作成を始めました'); await load(); });
      return;
    }
    if (t.hasAttribute('data-copy')) {
      const text = tab === 'summary' ? cache.summary && cache.summary.markdown : cache.transcript && cache.transcript.text;
      if (!text) return;
      try { await copyText(text); toast('コピーしました'); } catch { toast('コピーできませんでした', 'error'); }
      return;
    }
    if (t.dataset.regen) {
      const target = t.dataset.regen;
      const msg = target === 'summary'
        ? 'いまの文字起こしから、議事録だけを作り直します。前の内容は「前の内容に戻す」で戻せます。'
        : '音声から文字起こしをやり直し、続けて議事録も作り直します。\n手で直した相手や同席者の名前は、新しい内容に反映されます。数分かかります。';
      if (!(await ask(msg, { okLabel: '作り直す' }))) return;
      act(t, async () => { await api.post(`/api/minutes/${id}/regenerate`, { target }); pollStart = 0; toast('作り直しを始めました'); await load(); });
      return;
    }
    if (t.hasAttribute('data-revert')) {
      const target = tab === 'transcript' ? 'transcript' : 'summary';
      if (!(await ask('ひとつ前の内容に戻します。いまの内容は前の内容と入れ替わります。', { okLabel: '戻す' }))) return;
      act(t, async () => { await api.post(`/api/minutes/${id}/revert`, { target }); delete cache[target]; await load(); });
      return;
    }
    if (t.hasAttribute('data-download')) {
      act(t, async () => {
        const r = await api.get(`/api/minutes/${id}/audio-url`); // 5 分で切れるので、押すたびに取り直す
        const a = document.createElement('a');
        a.href = r.url; a.download = r.filename || 'minutes.m4a'; a.rel = 'noopener';
        document.body.appendChild(a); a.click(); a.remove();
      });
      return;
    }
    if (t.hasAttribute('data-delete')) {
      if (!(await ask('この議事録を削除します。音声、文字起こし、議事録、共有がすべて消え、元に戻せません。', { okLabel: '削除する', danger: true }))) return;
      act(t, async () => { await api.del(`/api/minutes/${id}`); toast('削除しました'); navigate('/minutes'); });
    }
  });

  // 相手・同席者・メモの修正（作った人だけ）
  function openEdit() {
    const model = {
      counterparts: (m.counterparts || []).map((c) => ({ cardId: c.cardId, company: c.company, department: c.department, name: c.name })),
      attendees: (m.attendees || []).map((a) => ({ id: a.id, name: a.name })),
    };
    const box = container.querySelector('.mn-meta');
    const host = document.createElement('div');
    host.className = 'mn-edit';
    host.innerHTML = `<label class="mn-field"><span class="mn-label">タイトル</span><input class="mn-input" data-f="title"></label>
      <div data-r="people"></div>
      <label class="mn-field"><span class="mn-label">メモ</span><textarea class="mn-input" rows="3" data-f="memo"></textarea></label>
      <div class="mn-muted">直した名前を文字起こしや議事録に反映するには、作り直してください。</div>
      <div class="mn-row"><button class="mn-btn" data-cancel>やめる</button><button class="mn-btn mn-btn-primary" data-save>保存する</button></div>`;
    host.querySelector('[data-f=title]').value = m.title || '';
    host.querySelector('[data-f=memo]').value = m.memo || '';
    box.replaceWith(host);
    mountPeopleEditor(host.querySelector('[data-r=people]'), model, {});
    host.querySelector('[data-cancel]').addEventListener('click', paint);
    host.querySelector('[data-save]').addEventListener('click', (ev) => act(ev.currentTarget, async () => {
      await api.put(`/api/minutes/${id}`, { title: host.querySelector('[data-f=title]').value.trim(), memo: host.querySelector('[data-f=memo]').value, ...peopleToPayload(model) });
      toast('保存しました');
      await load();
    }));
  }

  load();
  return () => { gone = true; stop(); if (qaStop) qaStop(); };
}
