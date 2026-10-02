// 音の取り方。ウェブ会議（パソコンの音 + マイク）と、その場の音声（マイクだけ）。
// 混ぜるのはブラウザの中。映像は取得するが録音しない（止めると共有が終わるので、止めずに持っておく）。

export class NoSystemAudioError extends Error {
  constructor(message = '共有に音が含まれていません') {
    super(message);
    this.name = 'NoSystemAudioError';
  }
}

function ua() {
  return typeof navigator === 'undefined' ? '' : navigator.userAgent || '';
}
function isMobile() {
  if (navigator.userAgentData && typeof navigator.userAgentData.mobile === 'boolean') return navigator.userAgentData.mobile;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua()) || (/Macintosh/.test(ua()) && navigator.maxTouchPoints > 1);
}
function isChromium() {
  return /Chrome\/|Edg\//.test(ua()) && !/OPR\/|Firefox\//.test(ua());
}

// 使えない理由（§3.2 の表）。使えるなら null。
export function webMeetingUnavailableReason() {
  if (typeof window !== 'undefined' && window.isSecureContext === false) return 'https でない画面では録音できません。https で開いてください。';
  if (isMobile()) return 'スマホでは、パソコンの音を録音できません。「ここの音声を録音」を使ってください。';
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) return 'このブラウザは、パソコンの音の取得に対応していません。Chrome か Edge を使ってください。';
  if (!isChromium()) return 'このブラウザは、パソコンの音の取得に対応していません。Chrome か Edge を使ってください。';
  return null;
}
export function supportsWebMeeting() {
  return webMeetingUnavailableReason() === null;
}
export function roomUnavailableReason() {
  if (typeof window !== 'undefined' && window.isSecureContext === false) return 'https でない画面では録音できません。https で開いてください。';
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return 'このブラウザは、マイクの録音に対応していません。';
  if (typeof MediaRecorder === 'undefined') return 'このブラウザは、録音に対応していません。';
  return null;
}
export function supportsRoom() {
  return roomUnavailableReason() === null;
}

// getUserMedia / getDisplayMedia のエラーを利用者向けの文言にする。
export function explainMediaError(err, kind) {
  const what = kind === 'display' ? '画面の共有' : 'マイク';
  switch (err && err.name) {
    case 'NoSystemAudioError':
      return '共有に音が含まれていません。共有の画面で「タブの音声も共有する」（画面全体の場合は「システム音声も共有する」）をオンにして、もう一度選んでください。';
    case 'NotAllowedError':
    case 'SecurityError':
      return kind === 'display'
        ? '画面の共有が許可されませんでした。もう一度やり直し、共有する画面かタブを選んでください。'
        : 'マイクが許可されていません。ブラウザのアドレス欄の鍵のマークから、マイクを許可してください。';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return kind === 'display' ? '共有できる画面が見つかりません。' : 'マイクが見つかりません。接続を確かめてください。';
    case 'NotReadableError':
    case 'AbortError':
      return `${what}を使えませんでした。ほかのアプリが使っていないか確かめてください。`;
    default:
      return `${what}を始められませんでした。もう一度試してください。`;
  }
}

function makeAnalyser(ctx, node) {
  const an = ctx.createAnalyser();
  an.fftSize = 1024;
  node.connect(an);
  return an;
}

// 0〜1 の大きさ（レベルメーター用）。
const levelBuf = new WeakMap();
export function readLevel(analyser) {
  if (!analyser) return 0;
  let buf = levelBuf.get(analyser);
  if (!buf) { buf = new Uint8Array(analyser.fftSize); levelBuf.set(analyser, buf); }
  analyser.getByteTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
  return Math.min(1, Math.sqrt(sum / buf.length) * 3);
}

const MIC_CONSTRAINTS = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
};

function newContext() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

/**
 * ウェブ会議。返り値: { mode, stream, analysers: { system, mic }, hasSystem, stop(), ... }
 * onShareEnded は共有側が止まったときに呼ぶ。マイクだけで続ける場合、録音は止めなくてよい
 * （システム音の入力が無音になるだけ）ので、ここでは何もしない。
 */
export async function startWebMeeting({ onShareEnded, onMicEnded } = {}) {
  const reason = webMeetingUnavailableReason();
  if (reason) throw Object.assign(new Error(reason), { name: 'NotSupportedError' });

  // 共有の選択画面で「画面全体」が最初に選ばれているようにする（displaySurface: 'monitor'）。
  // タブや窓を選ぶと会議アプリの音が入らないことがあり、画面全体 + システム音声が一番確実なため。
  // 自分のブラウザのタブは選択肢から外し、共有中の切り替えは許す。対応していないブラウザは無視する
  const display = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: 'monitor' },
    audio: true,
    systemAudio: 'include',
    monitorTypeSurfaces: 'include',
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    preferCurrentTab: false,
  });
  const sysTracks = display.getAudioTracks();
  if (!sysTracks.length) {
    display.getTracks().forEach((t) => t.stop());
    throw new NoSystemAudioError();
  }

  let mic;
  try {
    mic = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
  } catch (e) {
    display.getTracks().forEach((t) => t.stop());
    // 画面の共有ではなくマイクの失敗だと、画面側で案内を分けられるようにする
    try { e.mediaKind = 'mic'; } catch { /* 読み取り専用なら諦める */ }
    throw e;
  }

  const ctx = newContext();
  const dest = ctx.createMediaStreamDestination();
  dest.channelCount = 1;
  const sysSource = ctx.createMediaStreamSource(new MediaStream(sysTracks));
  const micSource = ctx.createMediaStreamSource(mic);
  sysSource.connect(dest);
  micSource.connect(dest);
  const analysers = { system: makeAnalyser(ctx, sysSource), mic: makeAnalyser(ctx, micSource) };

  let shareEnded = false;
  const handleEnded = () => {
    if (shareEnded) return;
    shareEnded = true;
    if (onShareEnded) onShareEnded();
  };
  // 映像・音のどちらの終了でも、共有が止まったと扱う
  display.getTracks().forEach((t) => { t.onended = handleEnded; });
  mic.getAudioTracks().forEach((t) => { t.onended = () => { if (onMicEnded) onMicEnded(); }; });

  let stopped = false;
  return {
    mode: 'web',
    stream: dest.stream,
    analysers,
    hasSystem: true,
    // 映像トラックはここで保持する（止めると共有が終わるため）
    _display: display,
    get shareEnded() { return shareEnded; },
    async prepare() { if (ctx.state === 'suspended') await ctx.resume().catch(() => {}); },
    stop() {
      if (stopped) return;
      stopped = true;
      display.getTracks().forEach((t) => { t.onended = null; t.stop(); });
      mic.getTracks().forEach((t) => { t.onended = null; t.stop(); });
      ctx.close().catch(() => {});
    },
  };
}

/** その場の音声。マイクだけ。録音にはマイクの生の stream をそのまま使う（スマホで AudioContext を挟むと不安定なため）。 */
export async function startRoom({ onMicEnded } = {}) {
  const reason = roomUnavailableReason();
  if (reason) throw Object.assign(new Error(reason), { name: 'NotSupportedError' });

  let mic = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
  const ctx = newContext();
  const state = { stopped: false };
  const cap = {
    mode: 'room',
    stream: mic,
    analysers: { system: null, mic: null },
    hasSystem: false,
    async prepare() {
      if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
      // 電話の着信などでマイクが切れていたら取り直す
      if (mic.getAudioTracks().every((t) => t.readyState === 'ended')) {
        mic = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
        cap.stream = mic;
        attach();
      }
    },
    stop() {
      if (state.stopped) return;
      state.stopped = true;
      mic.getTracks().forEach((t) => { t.onended = null; t.stop(); });
      ctx.close().catch(() => {});
    },
  };
  function attach() {
    const src = ctx.createMediaStreamSource(mic);
    cap.analysers.mic = makeAnalyser(ctx, src);
    mic.getAudioTracks().forEach((t) => { t.onended = () => { if (onMicEnded) onMicEnded(); }; });
  }
  attach();
  return cap;
}
