// 議事録の API（docs/api-contract.md §7、docs/minutes-design.md §8〜§11）。
// 議事録を見られるのは作った人と共有された人だけ。役職は関係ない（§8）。範囲の外は 404。
import { ulid, normalizeText, DEFAULT_MODELS, MATERIAL_LIMITS, materialKindOf } from '@hyper-sfa/core';
import {
  ddb, K, s3, invokeAsync, audit, recordUsage, getSelection,
  notFound, forbidden, conflict, validation, readJson, parseLimit, encodeCursor, decodeCursor,
} from '@hyper-sfa/aws-shared';
import { visibleCardIds } from './access.js';
import { userMap } from './org.js';

const DAY_MS = 24 * 3600 * 1000;
const AUDIO_KEEP_DAYS = 7;
const MAX_SEGMENT_BYTES = 10 * 1024 * 1024;
const MAX_RECORDING_SEC = 7200;
const MAX_SHARE = 50;
// 音声ファイルのアップロード（mode: upload）。1 本をそのまま 1 つの区切りとして置く。
// 10 分 / 20MB を超える分割は minutes Lambda が ffmpeg で行う
const UPLOAD_MAX_BYTES = 600 * 1024 * 1024;
const UPLOAD_MIMES = {
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
  'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/aac': 'aac', 'video/mp4': 'mp4', 'video/webm': 'webm',
};
// 長さが読めないファイルの概算。8000 バイト/秒（約 64kbps）で割る
const estimateSec = (size) => Math.max(1, Math.min(MAX_RECORDING_SEC, Math.round(size / 8000)));
const SEGMENT_MIMES = { 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg' };
const nowIso = () => new Date().toISOString();

// ---- 表示 ----

function audioState(meta) {
  const expired = Boolean(meta.audioExpiresAt) && Date.parse(meta.audioExpiresAt) <= Date.now();
  const deleted = Boolean(meta.audioDeleted) || expired;
  return { deleted, available: !deleted && Boolean(meta.downloadKey) };
}

const ref = (v) => (v ? { version: v.version ?? 1, createdAt: v.createdAt ?? null, modelId: v.modelId ?? null, hasPrevious: Boolean(v.previousKey) } : null);

// 資料を踏まえた版かどうか。古い議事録には項目が無いので false 扱い
const summaryRef = (v) => (v ? { ...ref(v), withMaterials: Boolean(v.withMaterials), materialIds: v.materialIds ?? [] } : null);

const MATERIAL_MIMES = {
  pdf: 'application/pdf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
const PENDING_UPLOAD_MS = 3600 * 1000;
const matId = (seq) => `m${String(seq).padStart(3, '0')}`;

/** 送り終えた資料だけを API の形にする。送っている途中（state: pending）は見せない。 */
function presentMaterial(m) {
  return {
    id: m.id,
    seq: m.seq,
    name: m.name,
    kind: m.kind,
    size: m.size ?? 0,
    pages: m.pages ?? null,
    outlineStatus: m.outlineStatus ?? 'none',
    uploadedBy: m.uploadedBy ?? { id: '', name: '' },
    uploadedAt: m.uploadedAt ?? null,
  };
}

export async function loadMaterials(id, { all = false } = {}) {
  const items = await ddb.queryAll({ pk: K.minute(id).pk, skPrefix: 'MAT#' });
  return items.filter((m) => all || m.state === 'ready').sort((a, b) => a.seq - b.seq);
}

/**
 * @param {object} meta 議事録の META
 * @param {'owner'|'shared'} relation
 * @param {{ visibleCards?: Set<string>, shares?: Array }} [ctx]
 */
function presentMinute(meta, relation, { visibleCards = new Set(), shares, materials = [] } = {}) {
  const a = audioState(meta);
  const out = {
    id: meta.id,
    title: meta.title ?? '',
    heldAt: meta.heldAt,
    mode: meta.mode,
    durationSec: meta.durationSec ?? 0,
    memo: meta.memo ?? '',
    status: meta.status,
    progress: meta.progress ?? { segmentsDone: 0, segmentsTotal: meta.segmentCount ?? 0 },
    failure: meta.failure
      ? { step: meta.failure.step, kind: meta.failure.kind, message: meta.failure.message ?? '', retryable: meta.failure.retryable !== false }
      : null,
    owner: { id: meta.ownerEmail, name: meta.ownerName ?? '' },
    relation,
    // 相手の会社名・氏名は紐づけた時点の写し。名刺を見られない人にも見えるが、名刺そのものは開けない（§8）
    counterparts: (meta.counterparts ?? []).map((cp) => {
      const ok = Boolean(cp.cardId) && visibleCards.has(cp.cardId);
      return { cardId: ok ? cp.cardId : null, company: cp.company ?? '', department: cp.department ?? '', name: cp.name ?? '', cardVisible: ok };
    }),
    attendees: (meta.attendees ?? []).map((x) => ({ id: x.email, name: x.name ?? x.email })),
    audio: { available: a.available, expiresAt: meta.audioExpiresAt ?? null, deleted: a.deleted },
    transcript: ref(meta.transcript),
    summary: summaryRef(meta.summary),
    materials: materials.map(presentMaterial),
    createdAt: meta.createdAt ?? null,
    updatedAt: meta.updatedAt ?? null,
  };
  if (relation === 'owner') out.shares = shares ?? [];
  return out;
}

/** 「見られる議事録」に置く写し。一覧と絞り込みに使う項目だけ。 */
function copyOf(meta, relation, email) {
  return {
    ...K.userMinute(email, meta.heldAt, meta.id),
    id: meta.id,
    relation,
    title: meta.title ?? '',
    heldAt: meta.heldAt,
    mode: meta.mode,
    durationSec: meta.durationSec ?? 0,
    status: meta.status,
    ownerEmail: meta.ownerEmail,
    ownerName: meta.ownerName ?? '',
    counterparts: (meta.counterparts ?? []).map((cp) => ({ cardId: cp.cardId ?? null, company: cp.company ?? '', department: cp.department ?? '', name: cp.name ?? '' })),
    attendees: (meta.attendees ?? []).map((x) => ({ email: x.email, name: x.name ?? '' })),
    updatedAt: meta.updatedAt,
  };
}

async function shareItems(id) {
  return ddb.queryAll({ pk: K.minute(id).pk, skPrefix: 'SHARE#' });
}

/** 作った人と共有された人すべての写しを書き直す。タイトルや相手を変えたとき、状態が変わったときに呼ぶ。 */
async function refreshCopies(meta) {
  const shares = await shareItems(meta.id);
  const writes = [ddb.put(copyOf(meta, 'owner', meta.ownerEmail))];
  for (const s of shares) writes.push(ddb.put(copyOf(meta, 'shared', String(s.sk).slice('SHARE#'.length))));
  await Promise.all(writes);
}

async function presentShares(id) {
  const [items, users] = await Promise.all([shareItems(id), userMap()]);
  return items.map((s) => {
    const email = String(s.sk).slice('SHARE#'.length);
    return { id: email, name: users.get(email)?.displayName ?? email, sharedAt: s.sharedAt ?? null };
  });
}

// ---- 読み込みと権限 ----

async function loadMeta(id) {
  const k = K.minute(String(id ?? ''));
  const meta = await ddb.get(k.pk, k.sk);
  if (!meta) throw notFound('議事録が見つかりません');
  return meta;
}

/** 見られる人か。owner / shared。見られなければ 404。 */
export async function access(user, id) {
  const meta = await loadMeta(id);
  if (meta.ownerEmail === user.id) return { meta, relation: 'owner' };
  const k = K.minuteShare(meta.id, user.id);
  if (await ddb.get(k.pk, k.sk)) return { meta, relation: 'shared' };
  throw notFound('議事録が見つかりません');
}

async function ownerAccess(user, id) {
  const r = await access(user, id);
  if (r.relation !== 'owner') throw forbidden('作った人だけができる操作です');
  return r.meta;
}

async function setMeta(meta, set, opts = {}) {
  const at = nowIso();
  const k = K.minute(meta.id);
  const updated = await ddb.update(k.pk, k.sk, { set: { ...set, updatedAt: at }, ...opts });
  return updated;
}

// ---- 一覧 ----

const terms = (s) => normalizeText(s).split(' ').filter(Boolean);
const compact = (s) => normalizeText(s).replace(/ /g, '');
const allIn = (words, haystacks) => words.every((w) => haystacks.some((h) => h.includes(w)));

function dayStart(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s ?? '')) ? new Date(`${s}T00:00:00+09:00`).toISOString() : null;
}
function dayEnd(s) {
  const lo = dayStart(s);
  if (!lo) return null;
  const d = new Date(lo);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

function matchesCopy(cp, q) {
  const cps = cp.counterparts ?? [];
  if (q.relation && q.relation !== 'all' && cp.relation !== q.relation) return false;
  if (q.company && !allIn(terms(q.company).map((w) => w.replace(/ /g, '')), cps.map((x) => compact(x.company)))) return false;
  if (q.department && !allIn(terms(q.department).map((w) => w.replace(/ /g, '')), cps.map((x) => compact(x.department)))) return false;
  if (q.name && !allIn(terms(q.name).map((w) => w.replace(/ /g, '')), cps.map((x) => compact(x.name)))) return false;
  if (q.cardId && !cps.some((x) => x.cardId === q.cardId)) return false;
  if (q.attendee) {
    const key = String(q.attendee).trim().toLowerCase();
    const okId = (cp.attendees ?? []).some((x) => x.email === key);
    if (!okId && !allIn(terms(q.attendee), (cp.attendees ?? []).map((x) => compact(x.name)))) return false;
  }
  if (q.title && !allIn(terms(q.title), [compact(cp.title)])) return false;
  if (q.owner) {
    const key = String(q.owner).trim().toLowerCase();
    if (cp.ownerEmail !== key && !compact(cp.ownerName).includes(compact(q.owner))) return false;
  }
  const lo = dayStart(q.from);
  const hi = dayEnd(q.to);
  if (lo && cp.heldAt < lo) return false;
  if (hi && cp.heldAt >= hi) return false;
  return true;
}

/** 写しの配列から、最新の META を読んで API の形にする。META が無い（削除済み）ものは捨てる。 */
async function presentCopies(user, copies) {
  if (copies.length === 0) return [];
  // 状態や進み具合は minutes Lambda が META に書く。写しは古いことがあるので、ページ分だけ読み直す
  const metas = await ddb.batchGet(copies.map((cp) => K.minute(cp.id)));
  const byId = new Map(metas.map((m) => [m.id, m]));
  const visible = await visibleCardIds(user, metas.flatMap((m) => (m.counterparts ?? []).map((x) => x.cardId)));
  const mats = new Map(await Promise.all(metas.map(async (m) => [m.id, await loadMaterials(m.id)])));
  return copies
    .map((cp) => {
      const m = byId.get(cp.id);
      return m ? presentMinute(m, cp.relation, { visibleCards: visible, materials: mats.get(m.id) }) : null;
    })
    .filter(Boolean);
}

/** 名刺の詳細からの「この人との議事録」。ids は "<heldAt>#<議事録ID>" */
export async function listMinutesByIds(user, ids) {
  const keys = ids.map((s) => {
    const i = s.lastIndexOf('#');
    return K.userMinute(user.id, s.slice(0, i), s.slice(i + 1));
  });
  const copies = await ddb.batchGet(keys);
  copies.sort((a, b) => (a.sk < b.sk ? 1 : -1));
  return presentCopies(user, copies);
}

// ---- 入力の検査 ----

function cleanStr(v, max, field, errors) {
  if (v == null) return undefined;
  if (typeof v !== 'string') {
    errors.push({ field, message: '文字列で指定してください' });
    return undefined;
  }
  return v.trim().slice(0, max);
}

/** 商談の相手。名刺を選んだ相手は、見える名刺から会社名などを写す（クライアントの値は信用しない）。 */
async function resolveCounterparts(user, list, errors) {
  if (list == null) return undefined;
  if (!Array.isArray(list) || list.length > 20) {
    errors.push({ field: 'counterparts', message: '20 件までの配列で指定してください' });
    return undefined;
  }
  const ids = list.map((x) => x?.cardId).filter(Boolean);
  const visible = await visibleCardIds(user, ids);
  const cards = new Map((await ddb.batchGet(ids.map((id) => K.card(id)))).map((c) => [String(c.pk).slice('CARD#'.length), c]));
  const out = [];
  for (const x of list) {
    if (x?.cardId) {
      if (!visible.has(x.cardId)) {
        errors.push({ field: 'counterparts', message: '選べない名刺が含まれています' });
        continue;
      }
      const c = cards.get(x.cardId);
      out.push({ cardId: x.cardId, company: c.company ?? '', department: c.department ?? '', name: c.name ?? '' });
    } else {
      const company = String(x?.company ?? '').trim().slice(0, 200);
      const name = String(x?.name ?? '').trim().slice(0, 100);
      if (!company && !name) continue;
      out.push({ cardId: null, company, department: String(x?.department ?? '').trim().slice(0, 200), name });
    }
  }
  return out;
}

async function resolveAttendees(ownerId, ids, errors) {
  if (ids == null) return undefined;
  if (!Array.isArray(ids) || ids.length > 50) {
    errors.push({ field: 'attendeeIds', message: '50 人までの配列で指定してください' });
    return undefined;
  }
  const users = await userMap();
  const want = [...new Set([ownerId, ...ids.map((x) => String(x).trim().toLowerCase())])];
  const out = [];
  for (const email of want) {
    const u = users.get(email);
    if (!u || u.status !== 'active') {
      errors.push({ field: 'attendeeIds', message: '選べないユーザーが含まれています' });
      continue;
    }
    out.push({ email, name: u.displayName, deptIds: u.deptIds });
  }
  return out;
}

/** 録音の区切りの長さ。文字起こしのモデルが 1 回に受けられる長さより長くしない（§5.2）。 */
async function segmentSecFor() {
  try {
    const sel = await getSelection();
    const k = K.model(sel.transcribe);
    const stored = await ddb.get(k.pk, k.sk);
    const model = { ...(DEFAULT_MODELS.find((m) => m.id === sel.transcribe) ?? {}), ...(stored ?? {}) };
    if (model.maxAudioMinutes) return Math.min(600, model.maxAudioMinutes * 60);
  } catch {
    // 設定が読めなくても録音は始められる
  }
  return 600;
}

// ---- ルート ----

export function registerMinutesRoutes(app) {
  const me = (c) => c.get('auth').user;

  app.post('/api/minutes', async (c) => {
    const user = me(c);
    const body = await readJson(c);
    if (body.mode !== 'web' && body.mode !== 'room' && body.mode !== 'upload') throw validation('mode が正しくありません', [{ field: 'mode', message: 'web、room、upload のどれかを指定してください' }]);
    const errors = [];
    const title = cleanStr(body.title, 200, 'title', errors) ?? '';
    if (errors.length) throw validation('入力を確かめてください', errors);
    const id = ulid();
    const at = nowIso();
    const segmentSec = await segmentSecFor();
    const meta = {
      ...K.minute(id),
      id,
      title,
      heldAt: at,
      mode: body.mode,
      durationSec: 0,
      memo: '',
      ownerEmail: user.id,
      ownerName: user.displayName,
      counterparts: [],
      attendees: [{ email: user.id, name: user.displayName, deptIds: user.deptIds }],
      status: 'recording',
      progress: { segmentsDone: 0, segmentsTotal: 0 },
      failure: null,
      segmentCount: 0,
      segmentSec,
      audioDeleted: false,
      createdAt: at,
      updatedAt: at,
    };
    await ddb.put(meta, { condition: 'attribute_not_exists(pk)' });
    await ddb.put(copyOf(meta, 'owner', user.id));
    return c.json({ id, segmentSec, audioMime: body.mode === 'upload' ? null : 'audio/webm' });
  });

  app.post('/api/minutes/:id/segments', async (c) => {
    const user = me(c);
    const meta = await ownerAccess(user, c.req.param('id'));
    if (meta.status !== 'recording') throw conflict('録音は終わっています');
    const b = await readJson(c);
    const mime = String(b.mime ?? '').split(';')[0].trim().toLowerCase();
    const errors = [];
    if (!Number.isInteger(b.seq) || b.seq < 1 || b.seq > 999) errors.push({ field: 'seq', message: '1 以上の整数で指定してください' });
    if (!SEGMENT_MIMES[mime]) errors.push({ field: 'mime', message: '対応していない音声の形式です' });
    if (!(b.startSec >= 0) || !(b.durationSec > 0) || b.startSec + b.durationSec > MAX_RECORDING_SEC + 60) {
      errors.push({ field: 'durationSec', message: '録音の長さが正しくありません' });
    }
    if (!Number.isInteger(b.size) || b.size < 1 || b.size > MAX_SEGMENT_BYTES) errors.push({ field: 'size', message: '区切りは 10MB までです' });
    if (errors.length) throw validation('入力を確かめてください', errors);

    const key = `minutes/${meta.id}/seg-${String(b.seq).padStart(3, '0')}.${SEGMENT_MIMES[mime]}`;
    await ddb.put({
      ...K.minuteSeg(meta.id, b.seq),
      seq: b.seq, key, mime, startSec: b.startSec, durationSec: b.durationSec, size: b.size, state: 'pending',
    });
    const url = await s3.presignPut({ bucket: 'audio', key, contentType: mime, expiresSec: 900 });
    return c.json({ key, url, method: 'PUT', headers: { 'Content-Type': mime } });
  });

  app.post('/api/minutes/:id/upload', async (c) => {
    const user = me(c);
    const meta = await ownerAccess(user, c.req.param('id'));
    if (meta.mode !== 'upload') throw conflict('音声ファイルのアップロード用の議事録ではありません');
    if (meta.status !== 'recording') throw conflict('アップロードはすでに終わっています');
    const b = await readJson(c);
    const mime = String(b.mime ?? '').split(';')[0].trim().toLowerCase();
    const errors = [];
    if (!UPLOAD_MIMES[mime]) errors.push({ field: 'mime', message: '対応していない音声の形式です' });
    if (!Number.isInteger(b.size) || b.size < 1 || b.size > UPLOAD_MAX_BYTES) errors.push({ field: 'size', message: 'ファイルは 600MB までです' });
    const dur = b.durationSec ?? 0;
    if (typeof dur !== 'number' || !(dur >= 0) || dur > MAX_RECORDING_SEC) errors.push({ field: 'durationSec', message: '長さは 2 時間までです' });
    const filename = b.filename === undefined || b.filename === null ? '' : String(b.filename);
    if (filename.length > 200) errors.push({ field: 'filename', message: 'ファイル名は 200 字までです' });
    if (errors.length) throw validation('入力を確かめてください', errors);

    const estimated = !(dur > 0);
    const key = `minutes/${meta.id}/seg-001.${UPLOAD_MIMES[mime]}`;
    // やり直しのときは同じ seq: 1 を上書きする
    await ddb.put({
      ...K.minuteSeg(meta.id, 1),
      seq: 1, key, mime, startSec: 0, durationSec: estimated ? estimateSec(b.size) : dur, size: b.size, state: 'pending',
      filename, ...(estimated ? { durationEstimated: true } : {}),
    });
    const url = await s3.presignPut({ bucket: 'audio', key, contentType: mime, expiresSec: 3600 });
    return c.json({ key, url, method: 'PUT', headers: { 'Content-Type': mime } });
  });

  app.put('/api/minutes/:id/segments/:seq/done', async (c) => {
    const user = me(c);
    const meta = await ownerAccess(user, c.req.param('id'));
    const seq = Number.parseInt(c.req.param('seq'), 10);
    if (!Number.isInteger(seq)) throw validation('seq が正しくありません');
    const k = K.minuteSeg(meta.id, seq);
    const seg = await ddb.get(k.pk, k.sk);
    if (!seg) throw notFound('区切りが見つかりません');
    const head = await s3.headObject({ bucket: 'audio', key: seg.key });
    const maxBytes = meta.mode === 'upload' ? UPLOAD_MAX_BYTES : MAX_SEGMENT_BYTES;
    if (!head || head.size > maxBytes) throw validation('アップロードが完了していません');
    const set = { state: 'uploaded', size: head.size, uploadedAt: nowIso() };
    // 長さが分からなかったファイルは、置かれた大きさから概算し直す
    if (seg.durationEstimated) set.durationSec = estimateSec(head.size);
    await ddb.update(k.pk, k.sk, { set });
    return c.json({ ok: true });
  });

  app.post('/api/minutes/:id/finish', async (c) => {
    const user = me(c);
    const meta = await ownerAccess(user, c.req.param('id'));
    const b = await readJson(c);
    if (meta.status !== 'recording') throw conflict('録音はすでに終わっています');
    const isUpload = meta.mode === 'upload';
    // upload は長さが 0 のまま来ることがある（区切りの長さを採用するため）
    if ((!isUpload && !(b.durationSec > 0)) || !(b.durationSec >= 0) || b.durationSec > MAX_RECORDING_SEC + 60 || !Number.isInteger(b.segments) || b.segments < 1) {
      throw validation('入力を確かめてください', [{ field: 'durationSec', message: '録音の長さと区切りの数が必要です' }]);
    }
    const segs = await ddb.queryAll({ pk: meta.pk, skPrefix: 'SEG#' });
    if (segs.filter((s) => s.state === 'uploaded').length < b.segments) {
      throw validation('アップロードが終わっていない区切りがあります');
    }
    const durationSec = isUpload
      ? Math.round(segs.filter((s) => s.state === 'uploaded').reduce((a, s) => a + (s.durationSec ?? 0), 0))
      : Math.round(b.durationSec);
    const at = nowIso();
    const updated = await setMeta(meta, {
      status: 'uploaded',
      durationSec: Math.min(durationSec, MAX_RECORDING_SEC),
      segmentCount: segs.length,
      progress: { segmentsDone: 0, segmentsTotal: segs.length },
      finishedAt: at,
      // 音声は録音を終えてから 7 日で渡さなくなる。S3 の削除はその後（§6.2）
      audioExpiresAt: new Date(Date.parse(at) + AUDIO_KEEP_DAYS * DAY_MS).toISOString(),
    }, { condition: '#st = :rec', names: { '#st': 'status' }, values: { ':rec': 'recording' } });
    await refreshCopies(updated);
    await recordUsage({ kind: 'recording', userId: user.id, modelId: null, audioSeconds: updated.durationSec, ok: true, at, month: at.slice(0, 7) });
    return c.json({ status: 'uploaded' });
  });

  app.put('/api/minutes/:id', async (c) => {
    const user = me(c);
    const meta = await ownerAccess(user, c.req.param('id'));
    const b = await readJson(c);
    const errors = [];
    const title = cleanStr(b.title, 200, 'title', errors);
    const memo = cleanStr(b.memo, 5000, 'memo', errors);
    const counterparts = await resolveCounterparts(user, b.counterparts, errors);
    const attendees = await resolveAttendees(user.id, b.attendeeIds, errors);
    if (errors.length) throw validation('入力を確かめてください', errors);

    const set = {};
    if (title !== undefined) set.title = title;
    if (memo !== undefined) set.memo = memo;
    if (counterparts !== undefined) set.counterparts = counterparts;
    if (attendees !== undefined) set.attendees = attendees;
    if (Object.keys(set).length === 0) return c.json(presentMinute(meta, 'owner', { shares: await presentShares(meta.id), materials: await loadMaterials(meta.id) }));

    const updated = await setMeta(meta, set);
    if (counterparts !== undefined) {
      // 名刺側の「この人との議事録」の紐づけを、差分だけ書き換える
      const before = new Set((meta.counterparts ?? []).map((x) => x.cardId).filter(Boolean));
      const after = new Set(counterparts.map((x) => x.cardId).filter(Boolean));
      await Promise.all([
        ...[...after].filter((x) => !before.has(x)).map((cardId) => ddb.put({ ...K.cardMinute(cardId, meta.heldAt, meta.id), minuteId: meta.id })),
        ...[...before].filter((x) => !after.has(x)).map((cardId) => {
          const k = K.cardMinute(cardId, meta.heldAt, meta.id);
          return ddb.del(k.pk, k.sk);
        }),
      ]);
    }
    await refreshCopies(updated);
    const visible = await visibleCardIds(user, (updated.counterparts ?? []).map((x) => x.cardId));
    return c.json(presentMinute(updated, 'owner', { visibleCards: visible, shares: await presentShares(meta.id), materials: await loadMaterials(meta.id) }));
  });

  // 作成を始める。失敗した所からのやり直しも同じ（どこから続けるかは minutes Lambda が決める）
  app.post('/api/minutes/:id/generate', async (c) => {
    const user = me(c);
    const meta = await ownerAccess(user, c.req.param('id'));
    if (meta.status !== 'uploaded' && meta.status !== 'failed') throw conflict('いまは作成を始められません');
    if (!(meta.segmentCount > 0)) throw validation('録音がありません');
    await queue(meta, 'generate', ['uploaded', 'failed']);
    return c.json({ status: 'queued' }, 202);
  });

  app.post('/api/minutes/:id/regenerate', async (c) => {
    const user = me(c);
    const meta = await ownerAccess(user, c.req.param('id'));
    const b = await readJson(c);
    if (b.target !== 'summary' && b.target !== 'transcript') throw validation('target が正しくありません', [{ field: 'target', message: 'summary か transcript を指定してください' }]);
    if (meta.status !== 'done' && meta.status !== 'failed') throw conflict('いまは作り直せません');
    if (b.target === 'summary' && !meta.transcript?.key) throw validation('文字起こしがまだありません');
    if (b.target === 'transcript' && audioState(meta).deleted) throw validation('音声は削除されたため、文字起こしからはやり直せません');
    const withMaterials = b.target === 'summary' && b.withMaterials === true;
    if (withMaterials && (await loadMaterials(meta.id)).length === 0) {
      throw validation('資料がありません', [{ field: 'withMaterials', message: '先に資料を追加してください' }]);
    }
    await queue(meta, b.target, ['done', 'failed'], withMaterials ? { withMaterials: true } : {});
    return c.json({ status: 'queued' }, 202);
  });

  // 状態を「待ち」にして minutes Lambda を起こす。起こせなければ失敗に戻し、やり直せるようにする
  async function queue(meta, target, fromStatuses, extra = {}) {
    const updated = await setMeta(meta, { status: 'queued', failure: null }, {
      condition: '#st IN (' + fromStatuses.map((_, i) => `:f${i}`).join(', ') + ')',
      names: { '#st': 'status' },
      values: Object.fromEntries(fromStatuses.map((s, i) => [`:f${i}`, s])),
    }).catch((e) => {
      if (e?.name === 'ConditionalCheckFailedException') throw conflict('ほかの操作が先に始まっています');
      throw e;
    });
    await refreshCopies(updated);
    try {
      await invokeAsync('MINUTES_FUNCTION_NAME', { minuteId: meta.id, target, ...extra });
    } catch (e) {
      console.error('minutes invoke failed', e?.name);
      const failed = await setMeta(meta, {
        status: 'failed',
        failure: { step: target === 'summary' ? 'summarize' : 'transcribe', kind: 'provider', message: '作成を始められませんでした', retryable: true },
      });
      await refreshCopies(failed);
    }
  }

  app.post('/api/minutes/:id/revert', async (c) => {
    const user = me(c);
    const meta = await ownerAccess(user, c.req.param('id'));
    const b = await readJson(c);
    if (b.target !== 'summary' && b.target !== 'transcript') throw validation('target が正しくありません', [{ field: 'target', message: 'summary か transcript を指定してください' }]);
    if (meta.status !== 'done') throw conflict('いまは戻せません');
    const cur = meta[b.target];
    if (!cur?.previousKey) throw validation('前の内容がありません');
    // 前の版と入れ替える。もう一度戻すと元に戻る
    const next = {
      ...cur,
      key: cur.previousKey,
      version: cur.previousVersion ?? Math.max(1, (cur.version ?? 2) - 1),
      previousKey: cur.key,
      previousVersion: cur.version ?? 1,
    };
    if (b.target === 'summary') {
      // 資料を踏まえた版かどうかと対応表も、本文と一緒に入れ替える
      next.withMaterials = Boolean(cur.previousWithMaterials);
      next.materialIds = cur.previousMaterialIds ?? [];
      next.mappingKey = cur.previousMappingKey ?? null;
      next.previousWithMaterials = Boolean(cur.withMaterials);
      next.previousMaterialIds = cur.materialIds ?? [];
      next.previousMappingKey = cur.mappingKey ?? null;
    }
    const updated = await setMeta(meta, { [b.target]: next });
    const visible = await visibleCardIds(user, (updated.counterparts ?? []).map((x) => x.cardId));
    return c.json(presentMinute(updated, 'owner', { visibleCards: visible, shares: await presentShares(meta.id), materials: await loadMaterials(meta.id) }));
  });

  app.get('/api/minutes', async (c) => {
    const user = me(c);
    const q = c.req.query();
    const limit = parseLimit(q.limit);
    const cursor = decodeCursor(q.cursor);
    // 1 人が見られる議事録は多くても数百件なので、全部読んでから条件で絞る（§10.1）
    const copies = await ddb.queryAll({ pk: `USER#${user.id}`, skPrefix: 'MIN#', forward: false });
    const hits = copies.filter((cp) => matchesCopy(cp, q) && (!cursor?.sk || cp.sk < cursor.sk));
    const page = hits.slice(0, limit);
    const items = await presentCopies(user, page);
    const nextCursor = hits.length > limit ? encodeCursor({ sk: page[page.length - 1].sk }) : null;
    return c.json({ items, nextCursor });
  });

  app.get('/api/minutes/:id', async (c) => {
    const user = me(c);
    const { meta, relation } = await access(user, c.req.param('id'));
    const visible = await visibleCardIds(user, (meta.counterparts ?? []).map((x) => x.cardId));
    const shares = relation === 'owner' ? await presentShares(meta.id) : undefined;
    return c.json(presentMinute(meta, relation, { visibleCards: visible, shares, materials: await loadMaterials(meta.id) }));
  });

  async function readText(bucketKey) {
    try {
      const buf = await s3.getObjectBuffer({ bucket: 'data', key: bucketKey });
      return buf.toString('utf8');
    } catch (e) {
      if (e?.name === 'NoSuchKey') throw notFound('まだ作られていません');
      throw e;
    }
  }

  app.get('/api/minutes/:id/transcript', async (c) => {
    const { meta } = await access(me(c), c.req.param('id'));
    if (!meta.transcript?.key) throw notFound('文字起こしはまだありません');
    return c.json({ text: await readText(meta.transcript.key), version: meta.transcript.version ?? 1 });
  });

  app.get('/api/minutes/:id/summary', async (c) => {
    const { meta } = await access(me(c), c.req.param('id'));
    if (!meta.summary?.key) throw notFound('議事録はまだありません');
    const out = { markdown: await readText(meta.summary.key), version: meta.summary.version ?? 1, withMaterials: Boolean(meta.summary.withMaterials), mapping: [] };
    if (meta.summary.withMaterials && meta.summary.mappingKey) {
      // 対応表が読めなくても議事録は返す（画面は対応表なしで出せる）
      try {
        const rows = JSON.parse(await readText(meta.summary.mappingKey));
        const names = new Map((await loadMaterials(meta.id, { all: true })).map((m) => [m.seq, m.name]));
        out.mapping = (Array.isArray(rows) ? rows : []).map((r) => ({ ...r, materialName: names.get(r.material) ?? '' }));
      } catch (e) {
        console.error('mapping read failed', e?.name);
      }
    }
    return c.json(out);
  });

  registerMaterialRoutes(app);

  app.get('/api/minutes/:id/audio-url', async (c) => {
    const { meta } = await access(me(c), c.req.param('id'));
    const a = audioState(meta);
    if (a.deleted) throw notFound('音声は削除されました');
    if (!a.available) throw notFound('音声はまだ準備できていません');
    const expiresSec = 300;
    const day = new Date(meta.heldAt).toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
    const safeTitle = String(meta.title || '議事録').replace(/[\\/:*?"<>|\r\n]/g, ' ').trim().slice(0, 60);
    const filename = `${day}_${safeTitle}.m4a`;
    const url = await s3.presignGet({ bucket: 'audio', key: meta.downloadKey, expiresSec, filename });
    return c.json({ url, expiresAt: new Date(Date.now() + expiresSec * 1000).toISOString(), filename });
  });

  app.get('/api/minutes/:id/shares', async (c) => {
    const meta = await ownerAccess(me(c), c.req.param('id'));
    return c.json({ items: await presentShares(meta.id) });
  });

  app.post('/api/minutes/:id/shares', async (c) => {
    const user = me(c);
    const meta = await ownerAccess(user, c.req.param('id'));
    const b = await readJson(c);
    if (!Array.isArray(b.userIds) || b.userIds.length === 0 || b.userIds.length > MAX_SHARE) {
      throw validation(`共有は 1 回に ${MAX_SHARE} 人までです`, [{ field: 'userIds', message: `1〜${MAX_SHARE} 人で指定してください` }]);
    }
    const users = await userMap();
    const emails = [...new Set(b.userIds.map((x) => String(x).trim().toLowerCase()))].filter((e) => e !== meta.ownerEmail);
    for (const e of emails) {
      if (users.get(e)?.status !== 'active') throw validation('共有できないユーザーが含まれています', [{ field: 'userIds', message: '登録されていない、または無効の人です' }]);
    }
    const at = nowIso();
    await Promise.all(emails.flatMap((e) => [
      ddb.put({ ...K.minuteShare(meta.id, e), sharedBy: user.id, sharedAt: at }),
      ddb.put(copyOf(meta, 'shared', e)),
    ]));
    // 誰が・いつ・誰に、を残す（§8）
    await audit(user, 'minute.share', { minuteId: meta.id, targets: emails });
    return c.json({ items: await presentShares(meta.id) });
  });

  app.delete('/api/minutes/:id/shares/:userId', async (c) => {
    const user = me(c);
    const meta = await ownerAccess(user, c.req.param('id'));
    const email = decodeURIComponent(c.req.param('userId')).trim().toLowerCase();
    const s = K.minuteShare(meta.id, email);
    const c2 = K.userMinute(email, meta.heldAt, meta.id);
    // 取り消しはすぐ効かせる。共有の項目と、その人の一覧の写しの両方を消す
    await Promise.all([ddb.del(s.pk, s.sk), ddb.del(c2.pk, c2.sk)]);
    await audit(user, 'minute.unshare', { minuteId: meta.id, targets: [email] });
    return c.json({ items: await presentShares(meta.id) });
  });

  app.delete('/api/minutes/:id', async (c) => {
    const user = me(c);
    const meta = await ownerAccess(user, c.req.param('id'));
    if (['queued', 'transcribing', 'summarizing'].includes(meta.status)) throw conflict('作成中は削除できません。終わってからお試しください');
    const shares = await shareItems(meta.id);
    const segs = await ddb.queryAll({ pk: meta.pk, skPrefix: 'SEG#' });
    const mats = await loadMaterials(meta.id, { all: true });
    // 質問のスレッドは全員分を消す（minutes-design.md §16.1）
    const chats = await ddb.queryAll({ pk: meta.pk, skPrefix: 'CHAT#' });
    const keys = [
      ...chats.map((s) => ({ pk: s.pk, sk: s.sk })),
      K.minute(meta.id),
      ...segs.map((s) => ({ pk: s.pk, sk: s.sk })),
      ...mats.map((m) => ({ pk: m.pk, sk: m.sk })),
      ...shares.map((s) => ({ pk: s.pk, sk: s.sk })),
      K.userMinute(meta.ownerEmail, meta.heldAt, meta.id),
      ...shares.map((s) => K.userMinute(String(s.sk).slice('SHARE#'.length), meta.heldAt, meta.id)),
      ...(meta.counterparts ?? []).filter((x) => x.cardId).map((x) => K.cardMinute(x.cardId, meta.heldAt, meta.id)),
    ];
    for (let i = 0; i < keys.length; i += 25) {
      await Promise.all(keys.slice(i, i + 25).map((k) => ddb.del(k.pk, k.sk)));
    }
    // 音声と文章（資料の元ファイル、抜いた JSON、目次、対応表も同じ接頭辞の下）も消す（使った記録は減らさない。費用は既にかかっているため）
    const prefix = `minutes/${meta.id}/`;
    const [audio, data] = await Promise.all([s3.listPrefix({ bucket: 'audio', prefix }), s3.listPrefix({ bucket: 'data', prefix })]);
    await Promise.all([
      ...audio.map((key) => s3.deleteObject({ bucket: 'audio', key })),
      ...data.map((key) => s3.deleteObject({ bucket: 'data', key })),
    ]);
    await audit(user, 'minute.delete', { minuteId: meta.id });
    return c.json({ ok: true });
  });
}

// ---- 資料（docs/minutes-design.md §15、api-contract.md「資料」） ----

function registerMaterialRoutes(app) {
  const me = (c) => c.get('auth').user;
  const base = (id) => `minutes/${id}/materials/`;

  async function loadMaterial(meta, matIdParam) {
    const m = /^m(\d{3})$/.exec(String(matIdParam ?? ''));
    if (!m) throw notFound('資料が見つかりません');
    const k = K.minuteMaterial(meta.id, Number(m[1]));
    const item = await ddb.get(k.pk, k.sk);
    if (!item) throw notFound('資料が見つかりません');
    return item;
  }

  async function removeFiles(item) {
    await Promise.all([item.key, item.extractKey, item.outlineKey].filter(Boolean).map((key) => s3.deleteObject({ bucket: 'data', key })));
  }

  app.get('/api/minutes/:id/materials', async (c) => {
    const { meta } = await access(me(c), c.req.param('id'));
    return c.json({ items: (await loadMaterials(meta.id)).map(presentMaterial) });
  });

  app.post('/api/minutes/:id/materials', async (c) => {
    const user = me(c);
    const meta = await ownerAccess(user, c.req.param('id'));
    const b = await readJson(c);
    const errors = [];
    const name = typeof b.name === 'string' ? b.name.replace(/[\r\n]/g, ' ').trim().slice(0, 200) : '';
    if (!name) errors.push({ field: 'name', message: 'ファイル名が必要です' });
    const kind = materialKindOf(name);
    if (!MATERIAL_LIMITS.kinds.includes(b.kind) || (name && kind !== b.kind)) {
      errors.push({ field: 'kind', message: 'PDF / pptx / xlsx だけ追加できます。古い形式（.ppt / .xls）は保存し直してください' });
    }
    if (!Number.isInteger(b.size) || b.size < 1 || b.size > MATERIAL_LIMITS.maxBytes) {
      errors.push({ field: 'size', message: `1 件 ${MATERIAL_LIMITS.maxBytes / 1024 / 1024}MB までです` });
    }
    if (errors.length) throw validation('入力を確かめてください', errors);

    // 送りかけで止まったものは 1 時間たてば片付ける。数に数え続けると、5 件の枠が埋まったままになるため
    const stale = (x) => x.state !== 'ready' && Date.now() - Date.parse(x.uploadedAt ?? 0) > PENDING_UPLOAD_MS;
    const existing = await loadMaterials(meta.id, { all: true });
    for (const m of existing.filter(stale)) {
      await removeFiles(m);
      await ddb.del(m.pk, m.sk);
    }
    const all = existing.filter((x) => !stale(x));
    if (all.length >= MATERIAL_LIMITS.maxFiles) {
      throw validation(`資料は 1 つの議事録に ${MATERIAL_LIMITS.maxFiles} 件までです`, [{ field: 'name', message: '先に不要な資料を削除してください' }]);
    }

    // 番号は欠番を埋めずに増やす。消した資料の ID を再利用すると、古い対応表が別の資料を指してしまうため
    const seq = existing.reduce((mx, m) => Math.max(mx, m.seq ?? 0), 0) + 1;
    const id = matId(seq);
    const hasExtract = kind !== 'pdf' && b.hasExtract !== false;
    const key = `${base(meta.id)}${id}.${kind}`;
    const extractKey = hasExtract ? `${base(meta.id)}${id}.extract.json` : null;
    await ddb.put({
      ...K.minuteMaterial(meta.id, seq),
      id, seq, name, kind, size: b.size, pages: null, key, extractKey, outlineKey: null,
      outlineStatus: 'none', state: 'pending',
      uploadedBy: { id: user.id, name: user.displayName ?? user.id }, uploadedAt: nowIso(),
    }, { condition: 'attribute_not_exists(pk)' });
    const mime = MATERIAL_MIMES[kind];
    const file = { url: await s3.presignPut({ bucket: 'data', key, contentType: mime, expiresSec: 900 }), method: 'PUT', headers: { 'Content-Type': mime } };
    const extract = extractKey
      ? { url: await s3.presignPut({ bucket: 'data', key: extractKey, contentType: 'application/json', expiresSec: 900 }), method: 'PUT', headers: { 'Content-Type': 'application/json' } }
      : null;
    return c.json({ id, seq, file, extract });
  });

  app.put('/api/minutes/:id/materials/:matId/done', async (c) => {
    const meta = await ownerAccess(me(c), c.req.param('id'));
    const item = await loadMaterial(meta, c.req.param('matId'));
    const b = await readJson(c);
    const head = await s3.headObject({ bucket: 'data', key: item.key });
    if (!head) throw validation('アップロードが完了していません');
    if (head.size > MATERIAL_LIMITS.maxBytes) {
      await removeFiles(item);
      await ddb.del(item.pk, item.sk);
      throw validation(`1 件 ${MATERIAL_LIMITS.maxBytes / 1024 / 1024}MB までです`);
    }
    let extractKey = null;
    if (item.extractKey) {
      const eh = b.extracted === false ? null : await s3.headObject({ bucket: 'data', key: item.extractKey });
      if (eh && eh.size <= MATERIAL_LIMITS.maxExtractBytes) extractKey = item.extractKey;
      else await s3.deleteObject({ bucket: 'data', key: item.extractKey }).catch(() => {});
    }
    const pages = Number.isInteger(b.pages) && b.pages > 0 && b.pages < 10000 ? b.pages : null;
    // PDF だけモデルで目次にする。pptx / xlsx は抜いた JSON から機械的に作る（§15.4）
    const set = { state: 'ready', size: head.size, extractKey, pages, outlineStatus: item.kind === 'pdf' ? 'pending' : 'none' };
    await ddb.update(item.pk, item.sk, { set });
    return c.json(presentMaterial({ ...item, ...set }));
  });

  app.delete('/api/minutes/:id/materials/:matId', async (c) => {
    const meta = await ownerAccess(me(c), c.req.param('id'));
    if (['queued', 'transcribing', 'summarizing'].includes(meta.status)) throw conflict('作成中は削除できません。終わってからお試しください');
    const item = await loadMaterial(meta, c.req.param('matId'));
    // 目次のキーは処理側が後から書くので、DynamoDB に無くても決まった名前で消す
    await removeFiles({ ...item, outlineKey: item.outlineKey ?? `${base(meta.id)}${item.id}.outline.json` });
    await ddb.del(item.pk, item.sk);
    return c.json({ ok: true });
  });

  app.get('/api/minutes/:id/materials/:matId/url', async (c) => {
    const { meta } = await access(me(c), c.req.param('id'));
    const item = await loadMaterial(meta, c.req.param('matId'));
    if (item.state !== 'ready') throw notFound('資料が見つかりません');
    const expiresSec = 3600;
    const url = await s3.presignGet({ bucket: 'data', key: item.key, expiresSec, filename: item.name });
    return c.json({ url, expiresAt: new Date(Date.now() + expiresSec * 1000).toISOString(), filename: item.name });
  });
}
