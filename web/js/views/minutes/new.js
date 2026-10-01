// /minutes/new 録音の種類を選ぶ → 録音 → 相手と同席者の確認。
// 録音のセッションはモジュールの中に持つ。画面を離れても録音は続き、戻ってきたら同じ状態を描き直す。
// 録音中の画面は、時間・メーター・警告の欄だけを部分更新し、入力欄は描き直さない。
import { api } from '../../api.js';
import { state } from '../../state.js';
import { navigate } from '../../router.js';
import { toast } from '../../ui.js';
import { icon } from '../../icons.js';
import {
  startWebMeeting, startRoom, webMeetingUnavailableReason, roomUnavailableReason,
  explainMediaError, readLevel,
} from '../../recorder/capture.js';
import { Segmenter } from '../../recorder/segmenter.js';
import { uploadFullAudio, sleep } from '../../recorder/upload.js';
import { esc, clock, ask, debounce, errMessage } from './util.js';
import { mountPeopleEditor, peopleToPayload } from './pickers.js';

let session = null;

export function hasActiveSession() {
  return !!session;
}

const TELL = '<div class="mn-notice">録音することを、相手に伝えてください。</div>';

export function renderNew(container) {
  const view = { container, raf: 0, gone: false };
  if (session) paintPhase(view); else paintChoose(view);
  return () => {
    view.gone = true;
    cancelAnimationFrame(view.raf);
    if (session && session.view === view) session.view = null;
  };
}

const alive = (v) => v && !v.gone && v.container.isConnected;

function paintPhase(view) {
  if (!session) return paintChoose(view);
  session.view = view;
  if (session.phase === 'recording') paintRecording(view);
  else if (session.phase === 'finishing') paintFinishing(view);
  else if (session.phase === 'confirm') paintConfirm(view);
}

// ---- 1. 種類を選ぶ ----
function paintChoose(view) {
  const web = webMeetingUnavailableReason();
  const room = roomUnavailableReason();
  const card = (kind, title, desc, reason) => `
    <button class="mn-kind" data-kind="${kind}" ${reason ? 'disabled' : ''}>
      ${icon(kind === 'web' ? 'screen' : 'mic', 40)}<strong>${title}</strong><span>${desc}</span>
      ${reason ? `<em class="mn-reason">${esc(reason)}</em>` : ''}
    </button>`;
  view.container.innerHTML = `<div class="mn-page mn-narrow">
    <div class="mn-head"><h1>議事録を作る</h1><a class="mn-btn" href="/minutes">議事録の一覧</a></div>
    ${TELL}
    <div class="mn-kinds">
      ${card('web', 'ウェブ会議を録音', 'パソコンから出る音とマイクの音を録音します', web)}
      ${card('room', 'ここの音声を録音', 'この端末のマイクで、その場の音を録音します', room)}
    </div></div>`;
  view.container.querySelector('.mn-kinds').addEventListener('click', (e) => {
    const b = e.target.closest('[data-kind]');
    if (b && !b.disabled) paintGuide(view, b.dataset.kind);
  });
}

// ---- 2. 手順の案内 ----
function paintGuide(view, kind) {
  const isWeb = kind === 'web';
  view.container.innerHTML = `<div class="mn-page mn-narrow">
    <div class="mn-head"><h1>${isWeb ? 'ウェブ会議を録音' : 'ここの音声を録音'}</h1></div>
    ${TELL}
    ${isWeb ? `<ol class="mn-steps">
      <li>下のボタンを押すと、共有の画面が開きます。</li>
      <li>会議の<strong>タブ</strong>か<strong>画面全体</strong>を選びます。</li>
      <li><strong>「音声も共有する」</strong>（タブの音声 / システム音声）を<strong>オン</strong>にします。</li>
      <li>続けて、マイクの許可を求められます。許可してください。</li>
    </ol>
    <p class="mn-muted">スピーカーで会議の音を出していると、マイクがその音も拾います。イヤホンを使ってください。映像は保存も送信もしません。</p>`
    : `<p>この端末のマイクで録音します。マイクの許可を求められたら、許可してください。</p>
    <p class="mn-mobile-note">スマホでは、画面が消えると録音が止まります。<strong>画面をつけたままにしてください。</strong></p>`}
    <div class="mn-error" data-r="err" role="alert"></div>
    <div class="mn-row"><button class="mn-btn" data-back>戻る</button>
    <button class="mn-btn mn-btn-primary mn-btn-lg" data-start>${isWeb ? '共有を選んで録音を始める' : '録音を始める'}</button></div></div>`;
  const err = view.container.querySelector('[data-r=err]');
  view.container.querySelector('[data-back]').addEventListener('click', () => paintChoose(view));
  const startBtn = view.container.querySelector('[data-start]');
  startBtn.addEventListener('click', async () => {
    startBtn.disabled = true;
    err.textContent = '';
    try {
      await startSession(kind);
      if (alive(view)) paintPhase(view);
    } catch (e) {
      err.textContent = e.userMessage || explainMediaError(e, e.mediaKind || (isWeb ? 'display' : 'mic'));
      startBtn.disabled = false;
    }
  });
}

async function startSession(kind) {
  const s = { kind, phase: 'recording', view: null, flags: {}, info: null, lastSound: {}, smooth: {}, startedAt: Date.now() };
  const lim = (state.config && state.config.limits) || {};
  const onEnded = () => { s.flags.shareEnded = true; refreshAlerts(); };
  const onMicEnded = () => { s.flags.micEnded = true; refreshAlerts(); };
  s.capture = kind === 'web'
    ? await startWebMeeting({ onShareEnded: onEnded, onMicEnded })
    : await startRoom({ onMicEnded });
  let created;
  try {
    created = await api.post('/api/minutes', { mode: kind, segmentSec: lim.segmentSec });
  } catch (e) {
    s.capture.stop();
    e.userMessage = `録音を始められませんでした。${errMessage(e)}`;
    throw e;
  }
  s.minuteId = created.id;
  s.model = {
    title: '', memo: '', counterparts: [],
    attendees: state.me ? [{ id: state.me.id, name: state.me.displayName }] : [],
  };
  s.save = debounce(() => {
    // 落ちたときのために途中でも保存しておく。失敗しても録音は止めない
    api.put(`/api/minutes/${s.minuteId}`, { title: s.model.title, memo: s.model.memo, ...peopleToPayload(s.model) }).catch(() => {});
  }, 5000);
  s.segmenter = new Segmenter({
    minuteId: s.minuteId,
    capture: s.capture,
    segmentSec: created.segmentSec || lim.segmentSec || 600,
    maxSec: lim.recordingMaxSec || 7200,
    api,
    keepFullAudio: !!(state.config && state.config.edition === 'cloudflare'),
    onChange: (info) => { s.info = info; s.flags.uploadFailing = info.failing; updateLive(); },
    onWarning: () => { s.flags.nearLimit = true; refreshAlerts(); toast('あと 10 分で録音を終えます'); },
    onAutoStop: () => { toast('最長の 2 時間になったので、録音を終えました'); doFinish(); },
    onInterrupted: () => { s.flags.interrupted = true; refreshAlerts(); },
    onCaptureDone: () => s.capture.stop(),
  });
  session = s;
  try {
    await s.segmenter.start();
  } catch (e) {
    s.capture.stop();
    session = null;
    e.userMessage = errMessage(e, '録音を始められませんでした。');
    throw e;
  }
}

// ---- 3. 録音中 ----
function paintRecording(view) {
  const s = session;
  const isWeb = s.kind === 'web';
  view.container.innerHTML = `<div class="mn-page mn-narrow mn-rec">
    ${TELL}
    ${isWeb ? '' : '<div class="mn-mobile-note">画面をつけたままにしてください。画面が消えると録音が止まります。</div>'}
    <div class="mn-orb-wrap"><div class="mn-orb" data-r="orb"><span class="mn-dot" data-r="dot"></span><span class="mn-time" data-r="elapsed">00:00</span></div></div>
    <div class="mn-rec-status"><strong data-r="label">録音中</strong><span class="mn-muted" data-r="remain"></span></div>
    <div data-r="alerts"></div>
    <div class="mn-meters">
      ${isWeb ? '<div class="mn-meter"><span>パソコンの音</span><div class="mn-bar"><i data-r="m-system"></i></div></div>' : ''}
      <div class="mn-meter"><span>マイク</span><div class="mn-bar"><i data-r="m-mic"></i></div></div>
    </div>
    <div class="mn-muted" data-r="saved"></div>
    <div class="mn-rec-btns">
      <button class="mn-btn mn-btn-lg" data-pause>一時停止</button>
      <button class="mn-btn mn-btn-lg mn-btn-danger" data-finish>録音を終える</button>
    </div>
    <div class="mn-rec-form">
      <label class="mn-field"><span class="mn-label">タイトル</span><input class="mn-input" data-f="title"></label>
      <div data-r="people"></div>
      <label class="mn-field"><span class="mn-label">メモ</span><textarea class="mn-input" rows="3" data-f="memo"></textarea></label>
    </div></div>`;
  const q = (sel) => view.container.querySelector(sel);
  q('[data-f=title]').value = s.model.title;
  q('[data-f=memo]').value = s.model.memo;
  q('[data-f=title]').addEventListener('input', (e) => { s.model.title = e.target.value; s.save(); });
  q('[data-f=memo]').addEventListener('input', (e) => { s.model.memo = e.target.value; s.save(); });
  mountPeopleEditor(q('[data-r=people]'), s.model, { onChange: () => s.save() });

  q('[data-pause]').addEventListener('click', async () => {
    const seg = s.segmenter;
    if (seg.state === 'recording') await seg.pause();
    else await seg.resume().catch((e) => toast(explainMediaError(e, 'mic'), 'error'));
    if (seg.state === 'recording') s.flags.interrupted = false;
    updateLive(); refreshAlerts();
  });
  q('[data-finish]').addEventListener('click', async () => {
    if (await ask('録音を終えます。よろしいですか。', { okLabel: '録音を終える', danger: true })) doFinish();
  });
  q('[data-r=alerts]').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'mic-only') { s.flags.shareEnded = false; s.flags.micOnly = true; refreshAlerts(); }
    else if (b.dataset.act === 'finish') doFinish();
    else if (b.dataset.act === 'resume') {
      try { await s.segmenter.resume(); s.flags.interrupted = false; s.flags.micEnded = false; } catch (err) { toast(explainMediaError(err, 'mic'), 'error'); }
      updateLive(); refreshAlerts();
    }
  });
  view.alertSig = null;
  refreshAlerts();
  updateLive();
  meterLoop(view);
}

// 時間・保存済み・ボタンの文言だけを更新する
function updateLive() {
  const s = session;
  const v = s && s.view;
  if (!s || !alive(v) || s.phase === 'confirm') return;
  const info = s.info || s.segmenter.info();
  if (s.phase === 'finishing') { paintFinishingCount(v); return; }
  const q = (sel) => v.container.querySelector(sel);
  if (!q('[data-r=elapsed]')) return;
  const paused = info.state === 'paused' || info.state === 'interrupted';
  q('[data-r=elapsed]').textContent = clock(info.elapsedSec);
  q('[data-r=remain]').textContent = `（最長 ${clock(info.maxSec)}、残り ${clock(info.maxSec - info.elapsedSec)}）`;
  q('[data-r=label]').textContent = info.state === 'paused' ? '一時停止中' : info.state === 'interrupted' ? '中断しました' : '録音中';
  q('[data-r=dot]').classList.toggle('off', paused);
  q('[data-r=orb]').classList.toggle('off', paused);
  q('[data-pause]').textContent = info.state === 'paused' || info.state === 'interrupted' ? '再開' : '一時停止';
  const upMin = Math.floor(info.uploadedSec / 60);
  q('[data-r=saved]').textContent = info.uploadedSec > 0 ? `${upMin} 分まで保存済み${info.pending ? `（送信待ち ${info.pending}）` : ''}` : '区切りができたら順に保存します。';
}

function refreshAlerts() {
  const s = session;
  const v = s && s.view;
  if (!s || !alive(v) || s.phase !== 'recording') return;
  const f = s.flags;
  const sig = JSON.stringify([f.shareEnded, f.micOnly, f.interrupted, f.micEnded, f.nearLimit, f.uploadFailing, f.silentSystem, f.silentMic]);
  if (sig === v.alertSig) return; // 変わっていなければ触らない
  v.alertSig = sig;
  const box = v.container.querySelector('[data-r=alerts]');
  if (!box) return;
  const items = [];
  if (f.shareEnded) items.push(`<div class="mn-alert mn-alert-warn"><p><strong>画面の共有が止まりました。</strong>パソコンの音は録音されません。</p><div class="mn-row"><button class="mn-btn" data-act="mic-only">マイクだけで続ける</button><button class="mn-btn mn-btn-danger" data-act="finish">録音を終える</button></div></div>`);
  if (f.micOnly) items.push('<div class="mn-alert">いまはマイクだけを録音しています。</div>');
  if (f.interrupted) items.push('<div class="mn-alert mn-alert-warn"><p>録音が止まりました（電話の着信などの可能性があります）。ここまでは保存してあります。</p><button class="mn-btn mn-btn-primary" data-act="resume">再開する</button></div>');
  if (f.nearLimit) items.push('<div class="mn-alert mn-alert-warn">あと 10 分で録音を終えます。</div>');
  if (f.uploadFailing) items.push('<div class="mn-alert">保存の送信がうまくいっていません。録音は続けています。つながったら自動でまとめて送ります。</div>');
  if (f.silentSystem && !f.shareEnded && !f.micOnly) items.push('<div class="mn-alert mn-alert-warn">パソコンの音が入っていません。共有したタブで音が出ているか確かめてください。</div>');
  if (f.silentMic) items.push('<div class="mn-alert mn-alert-warn">マイクの音が入っていません。ミュートになっていないか確かめてください。</div>');
  box.innerHTML = items.join('');
}

// メーターは requestAnimationFrame で幅だけ更新する
function meterLoop(view) {
  const s = session;
  const step = () => {
    if (!alive(view) || !session || session !== s || s.phase !== 'recording') return;
    const rec = s.segmenter.state === 'recording';
    const now = performance.now();
    for (const ch of ['system', 'mic']) {
      const an = s.capture.analysers[ch];
      const bar = view.container.querySelector(`[data-r=m-${ch}]`);
      if (!an || !bar) continue;
      const lv = rec ? readLevel(an) : 0;
      // 上がるのは速く、下がるのはゆっくり。幅ではなく scaleX を動かすので再レイアウトが起きない
      const prev = s.smooth[ch] || 0;
      const sm = lv > prev ? prev + (lv - prev) * 0.5 : prev + (lv - prev) * 0.12;
      s.smooth[ch] = sm;
      bar.style.transform = `scaleX(${Math.min(1, sm).toFixed(3)})`;
      if (lv > 0.02 || !(ch in s.lastSound)) s.lastSound[ch] = now;
      // 30 秒ずっと無音なら知らせる。一時停止中は数えない
      if (!rec) s.lastSound[ch] = now;
      const silent = now - s.lastSound[ch] > 30000;
      const key = ch === 'system' ? 'silentSystem' : 'silentMic';
      if (!!s.flags[key] !== silent) { s.flags[key] = silent; refreshAlerts(); }
    }
    view.raf = requestAnimationFrame(step);
  };
  view.raf = requestAnimationFrame(step);
}

// ---- 4. 終える ----
async function doFinish() {
  const s = session;
  if (!s || s.phase !== 'recording') return;
  s.phase = 'finishing';
  s.finishError = null;
  if (alive(s.view)) { cancelAnimationFrame(s.view.raf); paintFinishing(s.view); }
  try {
    const r = await s.segmenter.finish();
    if (!r.allUploaded) {
      // 送れなかった分は端末に残してあり、次に開いたときに送れる
      toast('送れていない録音は端末に残しました。次に開いたときに送れます', 'error');
      session = null;
      navigate('/minutes');
      return;
    }
    await postFinish(s, r);
  } catch (e) {
    s.finishError = errMessage(e);
    s.finishResult = s.finishResult || null;
    if (alive(s.view)) paintFinishing(s.view);
  }
}

async function postFinish(s, r) {
  s.finishResult = r;
  await api.post(`/api/minutes/${s.minuteId}/finish`, { durationSec: r.durationSec, segments: r.segments });
  s.capture.stop();
  const full = s.segmenter.fullAudio();
  if (full) {
    // 通しの 1 本は、確認の画面を見ている間に送る
    s.fullAudioPromise = (async () => {
      for (let i = 0; i < 4; i++) {
        try { await uploadFullAudio(api, s.minuteId, full.blob, full.mime, r.durationSec); return true; } catch { await sleep(2000 * (i + 1)); }
      }
      return false;
    })();
  }
  s.phase = 'confirm';
  if (alive(s.view)) paintConfirm(s.view);
}

function paintFinishing(view) {
  const s = session;
  view.container.innerHTML = `<div class="mn-page mn-narrow">
    <h1>録音を終えました</h1>
    <p data-r="msg">録音を送っています。このまま画面を開いたままにしてください。</p>
    <p class="mn-muted" data-r="count"></p>
    ${s.finishError ? `<div class="mn-error" role="alert">${esc(s.finishError)}</div>` : ''}
    <div class="mn-row">
      ${s.finishError ? '<button class="mn-btn mn-btn-primary" data-retry>もう一度試す</button>' : ''}
      <button class="mn-btn" data-later>あとで送る（端末に残す）</button></div></div>`;
  paintFinishingCount(view);
  view.container.querySelector('[data-later]').addEventListener('click', () => {
    s.segmenter.giveUp();
    if (s.finishError) { session = null; navigate('/minutes'); }
  });
  const retry = view.container.querySelector('[data-retry]');
  if (retry) retry.addEventListener('click', async () => {
    retry.disabled = true;
    s.finishError = null;
    try { await postFinish(s, s.finishResult || await s.segmenter.finish()); } catch (e) { s.finishError = errMessage(e); if (alive(s.view)) paintFinishing(s.view); }
  });
}
function paintFinishingCount(view) {
  const el = view.container.querySelector('[data-r=count]');
  const info = session && (session.info || session.segmenter.info());
  if (el && info) el.textContent = info.pending ? `送信待ち ${info.pending} 個${info.failing ? '（つながらないため、間隔を空けて試し直しています）' : ''}` : '';
}

// ---- 5. 相手と同席者の確認 → 議事録を作る ----
function paintConfirm(view) {
  const s = session;
  view.container.innerHTML = `<div class="mn-page mn-narrow">
    <h1>相手と同席者を確かめる</h1>
    <p class="mn-muted">ここに入れた名前は、文字起こしで話している人の名前や会社名の表記に使います。</p>
    <label class="mn-field"><span class="mn-label">タイトル</span><input class="mn-input" data-f="title"></label>
    <div data-r="people"></div>
    <label class="mn-field"><span class="mn-label">メモ</span><textarea class="mn-input" rows="3" data-f="memo"></textarea></label>
    <div class="mn-error" data-r="err" role="alert"></div>
    <p class="mn-muted" data-r="full"></p>
    <div class="mn-row"><button class="mn-btn mn-btn-lg" data-later>あとで作る</button>
    <button class="mn-btn mn-btn-primary mn-btn-lg" data-make>議事録を作る</button></div></div>`;
  const q = (sel) => view.container.querySelector(sel);
  q('[data-f=title]').value = s.model.title;
  q('[data-f=memo]').value = s.model.memo;
  q('[data-f=title]').addEventListener('input', (e) => { s.model.title = e.target.value; });
  q('[data-f=memo]').addEventListener('input', (e) => { s.model.memo = e.target.value; });
  mountPeopleEditor(q('[data-r=people]'), s.model, {});

  const submit = async (generate) => {
    const btns = view.container.querySelectorAll('button');
    btns.forEach((b) => { b.disabled = true; });
    q('[data-r=err]').textContent = '';
    try {
      s.save.cancel();
      await api.put(`/api/minutes/${s.minuteId}`, { title: s.model.title, memo: s.model.memo, ...peopleToPayload(s.model) });
      if (generate) {
        if (s.fullAudioPromise) {
          q('[data-r=full]').textContent = '音声を送っています…';
          const ok = await s.fullAudioPromise;
          if (!ok) toast('ダウンロード用の音声を送れませんでした。議事録は作れます', 'error');
        }
        await api.post(`/api/minutes/${s.minuteId}/generate`);
      }
      const id = s.minuteId;
      session = null;
      navigate(`/minutes/${id}`);
    } catch (e) {
      if (alive(view)) {
        q('[data-r=err]').textContent = errMessage(e);
        q('[data-r=full]').textContent = '';
        btns.forEach((b) => { b.disabled = false; });
      }
    }
  };
  q('[data-make]').addEventListener('click', () => submit(true));
  q('[data-later]').addEventListener('click', () => submit(false));
}
