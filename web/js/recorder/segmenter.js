// 録音を区切りごとの独立したファイルにして、区切るたびに送る。
// 区切りごとに MediaRecorder を作り直すのは、1 つ目のファイルにしか初期化情報が入らず、
// 2 つ目以降が単独で再生できなくなるのを避けるため（1 つが壊れても他へ影響させない）。
import { putChunk, deleteSegment, markActive } from './store.js';
import { uploadSegment, sleep } from './upload.js';

const TIMESLICE_MS = 10000;
const WARN_BEFORE_SEC = 600; // 1 時間 50 分（最長 2 時間の 10 分前）で知らせる

export function pickMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const m of ['audio/webm;codecs=opus', 'audio/mp4']) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

/**
 * opts:
 *  minuteId, capture（capture.js の返り値）, segmentSec, maxSec,
 *  api（{ post, put, upload }）, keepFullAudio（Cloudflare 版のとき true）,
 *  onChange(info), onWarning('nearLimit'), onAutoStop(), onInterrupted(), onUploadError(err)
 */
export class Segmenter {
  constructor(opts) {
    this.o = opts;
    this.state = 'idle'; // idle | recording | paused | interrupted | stopped
    this.mime = pickMime();
    this.seq = 0;
    this.seg = null;
    this.baseMs = 0; // 一時停止を除いた録音時間（確定分）
    this.t0 = 0; // 今の録音の開始時刻
    this.queue = [];
    this.uploadedSec = 0;
    this.failing = false;
    this.gaveUp = false;
    this.waiters = [];
    this.warned = false;
    this.timer = null;
    this.wakeLock = null;
    this.full = null;
    this.fullChunks = [];
    this.pumping = false;
    this.finalizing = 0;
    this._onUnload = (e) => { e.preventDefault(); e.returnValue = ''; };
    this._onHide = () => { try { if (this.seg && this.seg.recorder.state === 'recording') this.seg.recorder.requestData(); } catch { /* 閉じる間際なので握りつぶす */ } };
    this._onVisible = () => { if (document.visibilityState === 'visible' && this.state === 'recording') this._acquireWakeLock(); };
  }

  get elapsedSec() {
    const ms = this.baseMs + (this.state === 'recording' ? performance.now() - this.t0 : 0);
    return ms / 1000;
  }

  info() {
    return {
      state: this.state,
      elapsedSec: Math.floor(this.elapsedSec),
      uploadedSec: Math.floor(this.uploadedSec),
      pending: this.queue.length,
      failing: this.failing,
      maxSec: this.o.maxSec,
    };
  }

  _emit() { if (this.o.onChange) this.o.onChange(this.info()); }

  async start() {
    if (this.mime === null || this.mime === '') throw new Error('このブラウザは録音に対応していません');
    markActive(this.o.minuteId, true);
    window.addEventListener('beforeunload', this._onUnload);
    window.addEventListener('pagehide', this._onHide);
    document.addEventListener('visibilitychange', this._onVisible);
    this._acquireWakeLock();
    this.state = 'recording';
    this.t0 = performance.now();
    this._startSegment();
    if (this.o.keepFullAudio) this._startFull();
    this.timer = setInterval(() => this._tick(), 500);
    this._emit();
  }

  _recorderOpts() {
    return { mimeType: this.mime, audioBitsPerSecond: 32000 };
  }

  _startFull() {
    try {
      this.full = new MediaRecorder(this.o.capture.stream, this._recorderOpts());
      this.full.ondataavailable = (e) => { if (e.data && e.data.size) this.fullChunks.push(e.data); };
      this.full.start(TIMESLICE_MS);
    } catch { this.full = null; }
  }

  _startSegment() {
    const { minuteId, capture } = this.o;
    const seq = ++this.seq;
    const startSec = Math.round(this.elapsedSec);
    const rec = new MediaRecorder(capture.stream, this._recorderOpts());
    const seg = { seq, startSec, recorder: rec, chunks: [], index: 0, writes: [], stopRequested: false, durationSec: 0, startedAtSec: this.elapsedSec, t0: performance.now() };
    rec.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      seg.chunks.push(e.data);
      const index = seg.index++;
      // 保存に失敗しても録音は止めない（メモリには残っている）
      seg.writes.push(putChunk({ minuteId, seq, index, blob: e.data, mime: rec.mimeType || this.mime, startSec, ms: performance.now() - seg.t0 }).catch(() => {}));
    };
    rec.onstop = () => this._finishSegment(seg);
    rec.onerror = () => { /* stop が続いて来るのでそこで扱う */ };
    rec.start(TIMESLICE_MS);
    this.seg = seg;
  }

  // 区切りが閉じた。Blob を結合して送る列に入れる。
  async _finishSegment(seg) {
    this.finalizing += 1;
    const unexpected = !seg.stopRequested;
    if (unexpected && this.seg === seg && this.state === 'recording') {
      // 電話の着信などで録音が止まった。そこまでを 1 つの区切りにして、再開を待つ
      seg.durationSec = Math.round((performance.now() - seg.t0) / 1000);
      this.baseMs += performance.now() - this.t0;
      this.state = 'interrupted';
      this._pauseFull();
      this.seg = null;
      if (this.o.onInterrupted) this.o.onInterrupted();
      this._emit();
    }
    await Promise.all(seg.writes);
    const blob = new Blob(seg.chunks, { type: (seg.recorder.mimeType || this.mime) });
    if (blob.size === 0 || seg.durationSec < 1) {
      deleteSegment(this.o.minuteId, seg.seq).catch(() => {});
    } else {
      this.queue.push({ seq: seg.seq, blob, mime: blob.type, startSec: seg.startSec, durationSec: seg.durationSec });
      this._pump();
    }
    seg.closed = true;
    this.finalizing -= 1;
    this._notify();
  }

  // 今の区切りを閉じる（durationSec を確定してから stop）
  _closeCurrent() {
    const seg = this.seg;
    if (!seg) return Promise.resolve();
    seg.stopRequested = true;
    seg.durationSec = Math.max(0, Math.round(this.elapsedSec - seg.startedAtSec));
    this.seg = null;
    return new Promise((resolve) => {
      const prev = seg.recorder.onstop;
      seg.recorder.onstop = async () => { await prev(); resolve(); };
      try { if (seg.recorder.state !== 'inactive') seg.recorder.stop(); else resolve(); } catch { resolve(); }
    });
  }

  _tick() {
    if (this.state === 'recording') {
      const el = this.elapsedSec;
      const { maxSec, segmentSec } = this.o;
      if (el >= maxSec) { this._autoStop(); return; }
      if (!this.warned && el >= maxSec - WARN_BEFORE_SEC) {
        this.warned = true;
        if (this.o.onWarning) this.o.onWarning('nearLimit');
      }
      if (this.seg && el - this.seg.startedAtSec >= segmentSec) this._rotate();
    }
    this._emit();
  }

  // 新しい区切りを先に始めてから古い方を止める。境目の途切れを短くするため。
  _rotate() {
    const old = this.seg;
    old.stopRequested = true;
    old.durationSec = Math.max(0, Math.round(this.elapsedSec - old.startedAtSec));
    this._startSegment();
    try { old.recorder.stop(); } catch { /* すでに止まっている */ }
  }

  async _autoStop() {
    if (this.state !== 'recording') return;
    await this._stopAll();
    if (this.o.onAutoStop) this.o.onAutoStop();
  }

  async _stopAll() {
    if (this.state === 'recording') this.baseMs += performance.now() - this.t0;
    const closing = this._closeCurrent();
    this.state = 'stopped';
    await closing;
    if (this.full && this.full.state !== 'inactive') {
      await new Promise((r) => { this.full.onstop = r; try { this.full.stop(); } catch { r(); } });
    }
    clearInterval(this.timer);
    this._releaseWakeLock();
    // 送信が終わるのを待たずに、マイクや共有を手放せるようにする
    if (this.o.onCaptureDone) this.o.onCaptureDone();
    this._emit();
  }

  _pauseFull() { try { if (this.full && this.full.state === 'recording') this.full.pause(); } catch { /* 無視 */ } }
  _resumeFull() { try { if (this.full && this.full.state === 'paused') this.full.resume(); } catch { /* 無視 */ } }

  async pause() {
    if (this.state !== 'recording') return;
    this.baseMs += performance.now() - this.t0;
    // 経過時間を先に確定してから閉じる
    this.state = 'paused';
    const seg = this.seg;
    if (seg) { seg.stopRequested = true; seg.durationSec = Math.max(0, Math.round(this.baseMs / 1000 - seg.startedAtSec)); this.seg = null; try { seg.recorder.stop(); } catch { /* 無視 */ } }
    this._pauseFull();
    this._releaseWakeLock();
    this._emit();
  }

  async resume() {
    if (this.state !== 'paused' && this.state !== 'interrupted') return;
    if (this.o.capture.prepare) await this.o.capture.prepare();
    this.state = 'recording';
    this.t0 = performance.now();
    this._startSegment();
    this._resumeFull();
    this._acquireWakeLock();
    this._emit();
  }

  /** 録音を終える。送信が終わるまで待つ（giveUp() で待ちをやめられる）。 */
  async finish() {
    if (this.state !== 'stopped') await this._stopAll();
    const segments = this.seq;
    const durationSec = Math.round(this.baseMs / 1000);
    const ok = await this.waitDrained();
    this._cleanup();
    return { durationSec, segments, allUploaded: ok };
  }

  fullAudio() {
    if (!this.fullChunks.length) return null;
    const mime = (this.full && this.full.mimeType) || this.mime;
    return { blob: new Blob(this.fullChunks, { type: mime }), mime };
  }

  // 送信待ちが空になるまで待つ。giveUp() されたら false。
  waitDrained() {
    if (!this.queue.length && !this.pumping && !this.finalizing) return Promise.resolve(!this.gaveUp);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  _notify() {
    if (this.queue.length || this.pumping || this.finalizing) return;
    const w = this.waiters.splice(0);
    w.forEach((f) => f(!this.gaveUp));
  }
  giveUp() {
    this.gaveUp = true;
    this.waiters.splice(0).forEach((f) => f(false));
  }

  async _pump() {
    if (this.pumping) return;
    this.pumping = true;
    let attempt = 0;
    while (this.queue.length && !this.gaveUp) {
      const item = this.queue[0];
      try {
        await uploadSegment(this.o.api, this.o.minuteId, item);
        this.queue.shift();
        this.uploadedSec += item.durationSec;
        this.failing = false;
        attempt = 0;
        deleteSegment(this.o.minuteId, item.seq).catch(() => {});
        this._emit();
      } catch (err) {
        this.failing = true;
        attempt += 1;
        if (this.o.onUploadError) this.o.onUploadError(err);
        this._emit();
        // 録音は止めずに、間隔を空けて試し直す
        await sleep(Math.min(60000, 2000 * 2 ** Math.min(attempt, 5)));
      }
    }
    this.pumping = false;
    this._notify();
  }

  _cleanup() {
    clearInterval(this.timer);
    this._releaseWakeLock();
    window.removeEventListener('beforeunload', this._onUnload);
    window.removeEventListener('pagehide', this._onHide);
    document.removeEventListener('visibilitychange', this._onVisible);
    // 送り切れていない分は IndexedDB に残っているので、復旧の対象にするため active を外す
    markActive(this.o.minuteId, false);
  }

  /** 画面を離れるなどで、送信を続けずに片付ける（chunk は残す）。 */
  abandon() {
    this.gaveUp = true;
    try { this.seg && this.seg.recorder.state !== 'inactive' && (this.seg.stopRequested = true, this.seg.recorder.stop()); } catch { /* 無視 */ }
    try { this.full && this.full.state !== 'inactive' && this.full.stop(); } catch { /* 無視 */ }
    this.state = 'stopped';
    this._cleanup();
  }

  async _acquireWakeLock() {
    try {
      if (!('wakeLock' in navigator)) return;
      if (this.wakeLock && !this.wakeLock.released) return;
      this.wakeLock = await navigator.wakeLock.request('screen');
    } catch { /* 省電力モードなどで拒否されても録音は続ける */ }
  }
  _releaseWakeLock() {
    try { if (this.wakeLock) this.wakeLock.release(); } catch { /* 無視 */ }
    this.wakeLock = null;
  }
}
