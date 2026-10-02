// 音声ファイルを 1 本上げて議事録にする入口。録音とは違い、端末の中への保存は要らない。
// 状態は new.js の session（kind: 'upload'）に持つ。画面を離れても送信は続き、戻ってきたら描き直す。
import { api, ApiError } from '../../api.js';
import { state } from '../../state.js';
import { getAuthHeader } from '../../auth.js';
import { icon } from '../../icons.js';
import { esc, clock, errMessage } from './util.js';

const MB = 1024 * 1024;
const EXT_MIME = {
  m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', aac: 'audio/aac',
  ogg: 'audio/ogg', webm: 'audio/webm', mp4: 'video/mp4',
};
const DURATION_WAIT_MS = 10000;
const alive = (v) => v && !v.gone && v.container.isConnected;

// 公開版（Cloudflare）は 60 分・100MB、AWS 版は 2 時間・600MB。config に値があればそれを優先する
export function uploadLimits() {
  const c = state.config || {};
  const lim = c.limits || {};
  const small = c.edition === 'cloudflare';
  return {
    maxSec: lim.uploadMaxSec || (small ? 3600 : 7200),
    maxBytes: lim.uploadMaxBytes || (small ? 100 * MB : 600 * MB),
  };
}

export function mimeOf(file) {
  if (file.type) return file.type;
  const m = /\.([a-z0-9]+)$/i.exec(file.name || '');
  return (m && EXT_MIME[m[1].toLowerCase()]) || '';
}

export function newUploadSession(me) {
  return {
    kind: 'upload', phase: 'upload', view: null, flags: {}, info: null,
    up: { stage: 'pick', file: null, durationSec: 0, durationKnown: false, title: '', error: '', progress: 0, failedAt: null },
    minuteId: null,
    model: { title: '', memo: '', counterparts: [], attendees: me ? [{ id: me.id, name: me.displayName }] : [] },
    save: { cancel() {} },
  };
}

// 長さを読む。読めなければ 0（サーバーが大きさから概算する）
function readDuration(file) {
  return new Promise((resolve) => {
    const a = document.createElement('audio');
    const url = URL.createObjectURL(file);
    let done = false;
    const end = (sec) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      a.removeAttribute('src');
      a.load();
      URL.revokeObjectURL(url);
      resolve(sec);
    };
    const timer = setTimeout(() => end(0), DURATION_WAIT_MS);
    a.preload = 'metadata';
    a.onloadedmetadata = () => end(Number.isFinite(a.duration) && a.duration > 0 ? Math.round(a.duration) : 0);
    a.onerror = () => end(0);
    a.src = url;
  });
}

function sizeText(n) {
  return n >= MB ? `${(n / MB).toFixed(n >= 100 * MB ? 0 : 1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

// 画面側で止める理由。無ければ ''
function limitReason(up) {
  const { maxSec, maxBytes } = uploadLimits();
  const hint = '。ボイスメモの「ロスレス」は大きいので、圧縮（既定）で録ったものを使うか、短く分けてください';
  if (up.file.size > maxBytes) return `ファイルが大きすぎます（${sizeText(up.file.size)}。上限は ${sizeText(maxBytes)}）${hint}`;
  if (up.durationKnown && up.durationSec > maxSec) return `長すぎます（${clock(up.durationSec)}。上限は ${clock(maxSec)}）${hint}`;
  if (!mimeOf(up.file)) return 'このファイルの形式が分かりません。m4a、mp3、wav、aac、ogg、webm、mp4 のいずれかを選んでください';
  return '';
}

export function paintUpload(view, s, { onBack, onDone }) {
  const up = s.up;
  const { maxSec, maxBytes } = uploadLimits();
  const sending = up.stage === 'sending';
  view.container.innerHTML = `<div class="mn-page mn-narrow">
    <div class="mn-head"><h1>音声ファイルを上げる</h1></div>
    <p>ボイスメモ（m4a）、mp3、wav、会議ツールの録画（mp4）などを 1 本選んでください。上限は <strong>${esc(clock(maxSec))}・${esc(sizeText(maxBytes))}</strong> です。</p>
    <p class="mn-muted">音声はサーバーに送って文字起こしします。上げる前に、相手に伝えてある録音かどうか確かめてください。</p>
    <div class="mn-drop" data-drop ${sending ? 'hidden' : ''}>
      <label class="mn-btn mn-btn-lg mn-filebtn">${icon('upload', 20)}ファイルを選ぶ
        <input type="file" data-file accept="audio/*,video/mp4,video/webm,.m4a,.mp3,.wav,.aac,.ogg,.webm,.mp4"></label>
      <span class="mn-muted mn-drop-hint">パソコンでは、ここにファイルをドラッグしても選べます</span>
    </div>
    <div data-r="file"></div>
    <div class="mn-error" data-r="err" role="alert"></div>
    <div class="mn-up-prog" data-r="prog" hidden>
      <div class="mn-bar mn-bar-up"><i data-r="bar"></i></div>
      <div class="mn-up-meta"><span data-r="stage"></span><strong data-r="pct"></strong></div>
    </div>
    <div class="mn-row" data-r="btns"></div></div>`;
  const q = (sel) => view.container.querySelector(sel);

  function paintBtns(blocked) {
    const row = q('[data-r=btns]');
    if (sending) { row.innerHTML = ''; return; }
    row.innerHTML = `<button class="mn-btn mn-btn-lg" data-back>戻る</button>
      <button class="mn-btn mn-btn-primary mn-btn-lg" data-go ${!up.file || up.reading || blocked ? 'disabled' : ''}>${up.failedAt ? 'もう一度' : 'この音声で議事録を作る'}</button>`;
    row.querySelector('[data-back]').addEventListener('click', () => onBack());
    row.querySelector('[data-go]').addEventListener('click', () => start(s, onDone));
  }

  const paintFile = () => {
    const box = q('[data-r=file]');
    if (!up.file) { box.innerHTML = ''; paintBtns(); return; }
    const reason = sending ? '' : limitReason(up);
    box.innerHTML = `<div class="mn-filecard">${icon('doc', 28)}<div>
      <div class="mn-filename">${esc(up.file.name)}</div>
      <div class="mn-muted">${esc(sizeText(up.file.size))}${up.reading ? '　長さを調べています…' : up.durationKnown ? `　${esc(clock(up.durationSec))}` : '　長さは読み取れませんでした（サーバーが概算します）'}</div></div></div>
      ${sending ? '' : '<label class="mn-field"><span class="mn-label">タイトル</span><input class="mn-input" data-f="title" maxlength="200"></label>'}`;
    const t = q('[data-f=title]');
    if (t) { t.value = up.title; t.addEventListener('input', () => { up.title = t.value; }); }
    q('[data-r=err]').textContent = reason || up.error || '';
    paintBtns(!!reason);
  };

  const choose = async (file) => {
    if (!file || up.stage === 'sending') return;
    Object.assign(up, { file, durationSec: 0, durationKnown: false, error: '', failedAt: null, reading: true, progress: 0 });
    up.title = (file.name || '').replace(/\.[^.]+$/, '');
    paintFile();
    const sec = await readDuration(file);
    if (up.file !== file) return;
    up.reading = false;
    up.durationSec = sec;
    up.durationKnown = sec > 0;
    if (alive(s.view)) paintFile();
  };
  q('[data-file]').addEventListener('change', (e) => { choose(e.target.files[0]); e.target.value = ''; });
  const drop = q('[data-drop]');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); choose(e.dataTransfer.files[0]); });

  paintFile();
  if (sending) paintProgress(s);
}

const STAGE_TEXT = {
  create: '準備しています…', upload: '送り先を用意しています…', send: '音声を送っています', done: '送り終えたことを登録しています…', finish: '仕上げています…',
};
const STAGE_FAIL = {
  create: '議事録の準備', upload: '送り先の用意', send: '音声の送信', done: '送信の登録', finish: '仕上げ',
};

// 進み具合だけを部分更新する（入力欄や画面全体は描き直さない）
function paintProgress(s) {
  const up = s.up;
  const v = s.view;
  if (!alive(v)) return;
  const q = (sel) => v.container.querySelector(sel);
  const prog = q('[data-r=prog]');
  if (!prog) return;
  prog.hidden = up.stage !== 'sending';
  q('[data-r=bar]').style.transform = `scaleX(${up.progress.toFixed(3)})`;
  q('[data-r=pct]').textContent = up.step === 'send' ? `${Math.floor(up.progress * 100)}%` : '';
  q('[data-r=stage]').textContent = STAGE_TEXT[up.step] || '';
}

// 段階ごとに進める。失敗した段階から「もう一度」で続ける（議事録の ID は作り直さない）
async function start(s, onDone) {
  const up = s.up;
  const file = up.file;
  const durationSec = up.durationKnown ? up.durationSec : 0;
  const order = ['create', 'upload', 'send', 'done', 'finish'];
  const from = !s.minuteId ? 'create' : up.failedAt || 'upload';
  up.stage = 'sending';
  up.error = '';
  up.progress = 0;
  up.failedAt = null;
  s.model.title = up.title.trim();
  if (alive(s.view)) paintUpload(s.view, s, { onBack: s.onBack, onDone });
  const guard = (e) => { e.preventDefault(); e.returnValue = ''; };
  window.addEventListener('beforeunload', guard);
  let step = from;
  try {
    for (let i = order.indexOf(from); i < order.length; i++) {
      step = order[i];
      up.step = step;
      paintProgress(s);
      if (step === 'create') {
        const r = await api.post('/api/minutes', { mode: 'upload', title: s.model.title || undefined });
        s.minuteId = r.id;
      } else if (step === 'upload') {
        up.target = await api.post(`/api/minutes/${s.minuteId}/upload`, { mime: mimeOf(file), durationSec, size: file.size, filename: file.name });
      } else if (step === 'send') {
        await putFile(up.target, file, (p) => { up.progress = p; paintProgress(s); });
        up.progress = 1;
      } else if (step === 'done') {
        await api.put(`/api/minutes/${s.minuteId}/segments/1/done`);
      } else {
        await api.post(`/api/minutes/${s.minuteId}/finish`, { durationSec, segments: 1 });
      }
    }
  } catch (e) {
    window.removeEventListener('beforeunload', guard);
    up.stage = 'pick';
    // 送信の失敗は送り先の期限切れもあり得るので、送り先の取り直しからやり直す
    up.failedAt = step === 'send' ? 'upload' : step;
    up.error = `${STAGE_FAIL[step]}でうまくいきませんでした。${errMessage(e)}`;
    if (alive(s.view)) paintUpload(s.view, s, { onBack: s.onBack, onDone });
    return;
  }
  window.removeEventListener('beforeunload', guard);
  up.stage = 'done';
  onDone();
}

function putFile(target, file, onProgress) {
  return new Promise((resolve, reject) => {
    (async () => {
      const headers = { ...(target.headers || {}) };
      // 署名付き URL（AWS 版）には Authorization を付けない。付けると署名が合わなくなる
      if (target.url.startsWith('/')) Object.assign(headers, await getAuthHeader());
      const x = new XMLHttpRequest();
      x.open(target.method || 'PUT', target.url);
      for (const [k, v] of Object.entries(headers)) x.setRequestHeader(k, v);
      x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      x.onload = () => (x.status >= 200 && x.status < 300 ? resolve() : reject(new ApiError(x.status, 'upload_failed', `アップロードに失敗しました（${x.status}）`)));
      x.onerror = () => reject(new ApiError(0, 'network', 'アップロードに失敗しました。ネットワークを確かめてください。'));
      x.send(file);
    })().catch(reject);
  });
}
