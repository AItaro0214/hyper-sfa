// 議事録の API（docs/api-contract.md §7、docs/minutes-design.md §8〜§11）。
// 議事録を見られるのは作った人と共有された人だけ。役職は関係ない（§8）。範囲の外は 404。
import { ulid, normalizeText, DEFAULT_MODELS } from '@hyper-sfa/core';
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
const SEGMENT_MIMES = { 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg' };
const nowIso = () => new Date().toISOString();

// ---- 表示 ----

function audioState(meta) {
  const expired = Boolean(meta.audioExpiresAt) && Date.parse(meta.audioExpiresAt) <= Date.now();
  const deleted = Boolean(meta.audioDeleted) || expired;
  return { deleted, available: !deleted && Boolean(meta.downloadKey) };
}

const ref = (v) => (v ? { version: v.version ?? 1, createdAt: v.createdAt ?? null, modelId: v.modelId ?? null, hasPrevious: Boolean(v.previousKey) } : null);

/**
 * @param {object} meta 議事録の META
 * @param {'owner'|'shared'} relation
 * @param {{ visibleCards?: Set<string>, shares?: Array }} [ctx]
 */
function presentMinute(meta, relation, { visibleCards = new Set(), shares } = {}) {
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
    summary: ref(meta.summary),
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
async function access(user, id) {
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
  return copies
    .map((cp) => {
      const m = byId.get(cp.id);
      return m ? presentMinute(m, cp.relation, { visibleCards: visible }) : null;
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
    if (body.mode !== 'web' && body.mode !== 'room') throw validation('mode が正しくありません', [{ field: 'mode', message: 'web か room を指定してください' }]);
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
    return c.json({ id, segmentSec, audioMime: 'audio/webm' });
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

  app.put('/api/minutes/:id/segments/:seq/done', async (c) => {
    const user = me(c);
    const meta = await ownerAccess(user, c.req.param('id'));
    const seq = Number.parseInt(c.req.param('seq'), 10);
    if (!Number.isInteger(seq)) throw validation('seq が正しくありません');
    const k = K.minuteSeg(meta.id, seq);
    const seg = await ddb.get(k.pk, k.sk);
    if (!seg) throw notFound('区切りが見つかりません');
    const head = await s3.headObject({ bucket: 'audio', key: seg.key });
    if (!head || head.size > MAX_SEGMENT_BYTES) throw validation('アップロードが完了していません');
    await ddb.update(k.pk, k.sk, { set: { state: 'uploaded', size: head.size, uploadedAt: nowIso() } });
    return c.json({ ok: true });
  });

  app.post('/api/minutes/:id/finish', async (c) => {
    const user = me(c);
    const meta = await ownerAccess(user, c.req.param('id'));
    const b = await readJson(c);
    if (meta.status !== 'recording') throw conflict('録音はすでに終わっています');
    if (!(b.durationSec > 0) || b.durationSec > MAX_RECORDING_SEC + 60 || !Number.isInteger(b.segments) || b.segments < 1) {
      throw validation('入力を確かめてください', [{ field: 'durationSec', message: '録音の長さと区切りの数が必要です' }]);
    }
    const segs = await ddb.queryAll({ pk: meta.pk, skPrefix: 'SEG#' });
    if (segs.filter((s) => s.state === 'uploaded').length < b.segments) {
      throw validation('アップロードが終わっていない区切りがあります');
    }
    const at = nowIso();
    const updated = await setMeta(meta, {
      status: 'uploaded',
      durationSec: Math.min(Math.round(b.durationSec), MAX_RECORDING_SEC),
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
    if (Object.keys(set).length === 0) return c.json(presentMinute(meta, 'owner', { shares: await presentShares(meta.id) }));

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
    return c.json(presentMinute(updated, 'owner', { visibleCards: visible, shares: await presentShares(meta.id) }));
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
    await queue(meta, b.target, ['done', 'failed']);
    return c.json({ status: 'queued' }, 202);
  });

  // 状態を「待ち」にして minutes Lambda を起こす。起こせなければ失敗に戻し、やり直せるようにする
  async function queue(meta, target, fromStatuses) {
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
      await invokeAsync('MINUTES_FUNCTION_NAME', { minuteId: meta.id, target });
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
    const updated = await setMeta(meta, { [b.target]: next });
    const visible = await visibleCardIds(user, (updated.counterparts ?? []).map((x) => x.cardId));
    return c.json(presentMinute(updated, 'owner', { visibleCards: visible, shares: await presentShares(meta.id) }));
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
    return c.json(presentMinute(meta, relation, { visibleCards: visible, shares }));
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
    return c.json({ markdown: await readText(meta.summary.key), version: meta.summary.version ?? 1 });
  });

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
    const keys = [
      K.minute(meta.id),
      ...segs.map((s) => ({ pk: s.pk, sk: s.sk })),
      ...shares.map((s) => ({ pk: s.pk, sk: s.sk })),
      K.userMinute(meta.ownerEmail, meta.heldAt, meta.id),
      ...shares.map((s) => K.userMinute(String(s.sk).slice('SHARE#'.length), meta.heldAt, meta.id)),
      ...(meta.counterparts ?? []).filter((x) => x.cardId).map((x) => K.cardMinute(x.cardId, meta.heldAt, meta.id)),
    ];
    for (let i = 0; i < keys.length; i += 25) {
      await Promise.all(keys.slice(i, i + 25).map((k) => ddb.del(k.pk, k.sk)));
    }
    // 音声と文章も消す（使った記録は減らさない。費用は既にかかっているため）
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
