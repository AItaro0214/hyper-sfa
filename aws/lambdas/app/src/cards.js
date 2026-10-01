// 名刺の API（docs/api-contract.md §4、docs/design.md §4、§8、§9）。
import { canEditCard, canDeleteCard, ulid, searchKeys, truncate } from '@hyper-sfa/core';
import {
  ddb, K, s3, invokeAsync, audit, isConditionFailed,
  forbidden, conflict, validation, readJson, parseLimit, encodeCursor, decodeCursor,
} from '@hyper-sfa/aws-shared';
import { loadCard } from './access.js';
import { presentCard } from './present.js';
import { departmentMap, deptRefs } from './org.js';
import { consumeScan } from './rate.js';
import { listMinutesByIds } from './minutes.js';

const KEY_RE = /^cards\/([0-9A-Za-z]{26})\/(front|back|thumb)\.jpg$/;
const EDIT_FIELDS = ['company', 'department', 'title', 'name', 'nameReading', 'phones', 'mobiles', 'emails', 'note', 'deptIds'];
const MAX = { company: 200, department: 200, title: 100, name: 100, nameReading: 100, note: 1000, listItem: 254, listCount: 10 };
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const nowIso = () => new Date().toISOString();

// ---- 入力の検査 ----

function uploadKey(value, kind, field, errors) {
  if (value == null || value === '') return null;
  const m = KEY_RE.exec(String(value));
  if (!m || m[2] !== kind) {
    errors.push({ field, message: '画像の場所が正しくありません' });
    return null;
  }
  return { key: String(value), id: m[1] };
}

function cleanString(v, max, field, errors) {
  if (v == null) return undefined;
  if (typeof v !== 'string') {
    errors.push({ field, message: '文字列で指定してください' });
    return undefined;
  }
  return truncate(v.trim(), max);
}

function cleanList(v, field, errors, { lower = false } = {}) {
  if (v == null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    errors.push({ field, message: '文字列の配列で指定してください' });
    return undefined;
  }
  return v
    .map((x) => truncate(x.trim(), MAX.listItem))
    .map((x) => (lower ? x.toLowerCase() : x))
    .filter(Boolean)
    .slice(0, MAX.listCount);
}

/**
 * 担当部署の検査（docs/design.md §9.2）。
 * 全部署から選べるのは「他の部署にも見せる」権限のある人だけ。それ以外は自分の所属と、既に付いている部署の範囲。
 */
async function checkDeptIds(user, deptIds, existing = []) {
  const ids = [...new Set(deptIds ?? [])];
  if (ids.length === 0) throw validation('担当部署を 1 つ以上選んでください', [{ field: 'deptIds', message: '1 つ以上必要です' }]);
  const map = await departmentMap();
  for (const id of ids) {
    const d = map.get(id);
    if (!d) throw validation('存在しない部署が含まれています', [{ field: 'deptIds', message: '存在しない部署です' }]);
    if (existing.includes(id)) continue;
    if (!d.active) throw validation('使用停止の部署は選べません', [{ field: 'deptIds', message: '使用停止の部署です' }]);
    if (!user.capabilities.assignOtherDepts && !user.deptIds.includes(id)) {
      throw validation('選べない部署が含まれています', [{ field: 'deptIds', message: '自分の所属部署だけ選べます' }]);
    }
  }
  return ids;
}

// ---- 履歴 ----

async function actorDeptName(user) {
  const refs = await deptRefs(user.deptIds);
  return refs.map((d) => d.name).join(';');
}

/** 履歴の項目。gsi2 に載せると、管理コンソールが月ごとに新しい順で読める。 */
async function histItem({ id, type, at, user, source, changes, card }) {
  return {
    ...K.cardHist(id, at, ulid()),
    ...K.gsi2(at.slice(0, 7), at, id),
    type,
    actorUserId: user.id,
    actorName: user.displayName,
    actorDeptName: await actorDeptName(user),
    actorDeptIds: user.deptIds,
    source: source ?? null,
    changes: changes ?? [],
    // 履歴の一覧で名刺を示すための写し。名刺を実削除するときに履歴ごと消える
    cardCompany: card?.company ?? '',
    cardName: card?.name ?? '',
    at,
  };
}

// ---- ルート ----

export function registerCardRoutes(app, { index }) {
  const me = (c) => c.get('auth').user;

  // 画像のアップロード先。名刺 ID をここで決め、キーに入れる（scan はキーの ID を名刺 ID として使う）
  app.post('/api/uploads', async (c) => {
    const user = me(c);
    const body = await readJson(c);
    const kinds = Array.isArray(body.kinds) ? [...new Set(body.kinds)] : [];
    const allowed = new Set(['front', 'back', 'thumb']);
    // 開発コンソールの議事録の試し用（音声）。開発者だけ
    if (user.capabilities.dev) allowed.add('audio');
    if (kinds.length === 0 || kinds.some((k) => !allowed.has(k))) throw validation('kinds が正しくありません', [{ field: 'kinds', message: 'front / back / thumb を指定してください' }]);
    const id = ulid();
    const uploads = [];
    for (const kind of kinds) {
      const isAudio = kind === 'audio';
      const key = isAudio ? `tests/${id}/audio.webm` : `cards/${id}/${kind}.jpg`;
      const contentType = isAudio ? 'audio/webm' : 'image/jpeg';
      const url = await s3.presignPut({ bucket: isAudio ? 'audio' : 'image', key, contentType, expiresSec: 900 });
      uploads.push({ kind, key, url, method: 'PUT', headers: { 'Content-Type': contentType } });
    }
    return c.json({ uploads });
  });

  app.post('/api/cards/scan', async (c) => {
    const user = me(c);
    const body = await readJson(c);
    const errors = [];
    const front = uploadKey(body.frontKey, 'front', 'frontKey', errors);
    const back = uploadKey(body.backKey, 'back', 'backKey', errors);
    const thumb = uploadKey(body.thumbKey, 'thumb', 'thumbKey', errors);
    if (!front) errors.push({ field: 'frontKey', message: '必須です' });
    if (!thumb) errors.push({ field: 'thumbKey', message: '必須です' });
    if (front && ((thumb && thumb.id !== front.id) || (back && back.id !== front.id))) {
      errors.push({ field: 'frontKey', message: '画像の組み合わせが正しくありません' });
    }
    if (errors.length) throw validation('入力を確かめてください', errors);
    const deptIds = await checkDeptIds(user, body.deptIds ?? user.deptIds);

    await consumeScan(user.id);
    const id = front.id;
    const at = nowIso();
    const item = {
      ...K.card(id),
      ...K.gsi1(id, at),
      id,
      status: 'processing',
      company: '', department: '', title: '', name: '', nameReading: '', phones: [], mobiles: [], emails: [], note: '', rawText: '',
      keys: searchKeys({}),
      imageFrontKey: front.key,
      imageBackKey: back?.key ?? null,
      thumbKey: thumb.key,
      deptIds,
      failure: null,
      createdBy: user.id,
      createdByName: user.displayName,
      createdByPosition: user.position,
      createdByDeptIds: user.deptIds,
      createdAt: at,
      updatedBy: user.id,
      updatedByName: user.displayName,
      updatedAt: at,
      editCount: 0,
      scanCount: 0,
      version: 1,
    };
    try {
      // 同じ ID で二重に作らない（他人の名刺 ID を指定して上書きするのを防ぐ）
      await ddb.put(item, { condition: 'attribute_not_exists(pk)' });
    } catch (e) {
      if (isConditionFailed(e)) throw conflict('この画像はすでに使われています。撮り直してください');
      throw e;
    }
    try {
      await invokeAsync('SCAN_FUNCTION_NAME', { cardId: id });
    } catch (e) {
      console.error('scan invoke failed', e?.name);
      await ddb.update(item.pk, item.sk, {
        set: { status: 'failed', failure: { kind: 'provider', message: '読み取りを始められませんでした', retryable: true, at: nowIso() } },
      });
    }
    return c.json({ id, status: 'processing' }, 202);
  });

  app.get('/api/cards/:id/status', async (c) => {
    const user = me(c);
    const item = await loadCard(user, c.req.param('id'));
    const out = { status: item.status };
    if (item.status === 'review' || item.status === 'confirmed') {
      const duplicates = item.status === 'review' ? await index.findDuplicates(user, item) : undefined;
      out.card = await presentCard(item, { detail: true, duplicates });
    }
    if (item.status === 'failed' && item.failure) {
      out.failure = { kind: item.failure.kind, message: item.failure.message ?? '', retryable: item.failure.retryable !== false };
    }
    return c.json(out);
  });

  app.post('/api/cards/:id/rescan', async (c) => {
    const user = me(c);
    const item = await loadCard(user, c.req.param('id'));
    // 保存前の再生成は誰でも（自分が読み込んだもの）。保存済みの再生成は編集できる人だけ（§9.3）
    const mine = item.createdBy === user.id && (item.status === 'review' || item.status === 'failed');
    if (!mine && !canEditCard(user, item)) throw forbidden();
    if (item.status === 'processing') return c.json({ status: 'processing' }, 202);

    await consumeScan(user.id);
    const at = nowIso();
    const hist = await histItem({ id: item.id, type: 'rescan', at, user, source: null, changes: [], card: item });
    try {
      await ddb.transact([
        {
          update: { pk: item.pk, sk: item.sk },
          set: { status: 'processing', failure: null, updatedAt: at, ...K.gsi1(item.id, at) },
          condition: '#st <> :p',
          names: { '#st': 'status' },
          values: { ':p': 'processing' },
        },
        { put: hist },
      ]);
    } catch (e) {
      if (isConditionFailed(e)) return c.json({ status: 'processing' }, 202);
      throw e;
    }
    try {
      await invokeAsync('SCAN_FUNCTION_NAME', { cardId: item.id });
    } catch (e) {
      console.error('scan invoke failed', e?.name);
      await ddb.update(item.pk, item.sk, {
        set: { status: 'failed', failure: { kind: 'provider', message: '読み取りを始められませんでした', retryable: true, at: nowIso() } },
      });
    }
    return c.json({ status: 'processing' }, 202);
  });

  app.get('/api/cards', async (c) => {
    const user = me(c);
    const q = c.req.query();
    const limit = parseLimit(q.limit);
    const r = await index.search({ user, params: q, limit, cursor: decodeCursor(q.cursor) });
    const items = await Promise.all(r.entries.map((e) => presentCard(e.item)));
    return c.json({ items, nextCursor: r.nextCursor ? encodeCursor(r.nextCursor) : null, total: r.total });
  });

  app.get('/api/cards/:id', async (c) => {
    const user = me(c);
    const item = await loadCard(user, c.req.param('id'));
    const duplicates = item.status === 'review' ? await index.findDuplicates(user, item) : undefined;
    return c.json(await presentCard(item, { detail: true, duplicates }));
  });

  // 画像の縮小。ブラウザが縮小して、既存のキーに上書きする（サーバーは画像を触らない）
  app.post('/api/cards/:id/images/replace', async (c) => {
    const user = me(c);
    const item = await loadCard(user, c.req.param('id'));
    if (!canEditCard(user, item)) throw forbidden('この名刺を編集する権限がありません');
    if (item.status === 'processing') throw conflict('読み取り中です。終わってからもう一度お試しください');
    const uploads = [];
    for (const [kind, key] of [['front', item.imageFrontKey], ['back', item.imageBackKey]]) {
      if (!key) continue;
      const url = await s3.presignPut({ bucket: 'image', key, contentType: 'image/jpeg', expiresSec: 900 });
      uploads.push({ kind, url, method: 'PUT', headers: { 'Content-Type': 'image/jpeg' } });
    }
    return c.json({ uploads });
  });

  // 縮小済みの印。項目の変更ではないので version も履歴も動かさない
  app.post('/api/cards/:id/images/optimized', async (c) => {
    const user = me(c);
    const item = await loadCard(user, c.req.param('id'));
    if (!canEditCard(user, item)) throw forbidden('この名刺を編集する権限がありません');
    const at = nowIso();
    await ddb.update(item.pk, item.sk, { set: { imageOptimized: true, imageOptimizedAt: at } });
    return c.json({ imageOptimized: true, imageOptimizedAt: at });
  });

  app.put('/api/cards/:id', async (c) => {
    const user = me(c);
    const item = await loadCard(user, c.req.param('id'));
    const body = await readJson(c);

    if (item.status === 'processing') throw conflict('読み取り中です。終わってからもう一度お試しください');
    const draft = item.createdBy === user.id && (item.status === 'review' || item.status === 'failed');
    if (!draft && !canEditCard(user, item)) throw forbidden('この名刺を編集する権限がありません');
    if (!Number.isInteger(body.version)) throw validation('version が必要です', [{ field: 'version', message: '必須です' }]);
    if (body.version !== (item.version ?? 1)) throw conflict('ほかの人が先に更新しました。最新の内容を読み込み直してください');

    const errors = [];
    const next = {
      company: cleanString(body.company, MAX.company, 'company', errors) ?? item.company ?? '',
      department: cleanString(body.department, MAX.department, 'department', errors) ?? item.department ?? '',
      title: cleanString(body.title, MAX.title, 'title', errors) ?? item.title ?? '',
      name: cleanString(body.name, MAX.name, 'name', errors) ?? item.name ?? '',
      nameReading: cleanString(body.nameReading, MAX.nameReading, 'nameReading', errors) ?? item.nameReading ?? '',
      note: cleanString(body.note, MAX.note, 'note', errors) ?? item.note ?? '',
      phones: cleanList(body.phones, 'phones', errors) ?? item.phones ?? [],
      mobiles: cleanList(body.mobiles, 'mobiles', errors) ?? item.mobiles ?? [],
      emails: cleanList(body.emails, 'emails', errors, { lower: true }) ?? item.emails ?? [],
      deptIds: Array.isArray(body.deptIds) ? body.deptIds : item.deptIds ?? [],
    };
    const source = ['review', 'search', 'detail'].includes(body.source) ? body.source : null;
    const confirm = body.confirm === true && (item.status === 'review' || item.status === 'failed');
    if (confirm && !next.company && !next.name) {
      errors.push({ field: 'company', message: '会社名か氏名のどちらかは入力してください' });
    }
    if (errors.length) throw validation('入力を確かめてください', errors);

    const oldDeptIds = item.deptIds ?? [];
    if (!same(next.deptIds, oldDeptIds)) next.deptIds = await checkDeptIds(user, next.deptIds, oldDeptIds);

    const deptMap = await departmentMap();
    const nameOf = (ids) => (ids ?? []).map((id) => deptMap.get(id)?.name ?? id);
    const changes = [];
    for (const f of EDIT_FIELDS) {
      if (same(next[f], item[f] ?? (Array.isArray(next[f]) ? [] : ''))) continue;
      // 担当部署は部署名で残す（後で部署の名前が変わっても、当時の名前で読める）
      changes.push(f === 'deptIds' ? { field: f, before: nameOf(item[f]), after: nameOf(next[f]) } : { field: f, before: item[f] ?? '', after: next[f] });
    }
    if (changes.length === 0 && !confirm) return c.json(await presentCard(item, { detail: true }));

    const at = nowIso();
    const type = confirm ? 'create' : 'edit';
    const set = {
      ...next,
      keys: searchKeys(next),
      updatedAt: at,
      updatedBy: user.id,
      updatedByName: user.displayName,
      ...K.gsi1(item.id, at),
    };
    if (confirm) {
      set.status = 'confirmed';
      set.failure = null;
    }
    const hist = await histItem({ id: item.id, type, at, user, source, changes, card: { ...next } });
    try {
      await ddb.transact([
        {
          update: { pk: item.pk, sk: item.sk },
          set,
          add: { version: 1, editCount: type === 'edit' ? 1 : 0 },
          condition: '#ver = :ver AND attribute_not_exists(deletedAt)',
          names: { '#ver': 'version' },
          values: { ':ver': item.version ?? 1 },
        },
        { put: hist },
      ]);
    } catch (e) {
      if (isConditionFailed(e)) throw conflict('ほかの人が先に更新しました。最新の内容を読み込み直してください');
      throw e;
    }
    const updated = await ddb.get(item.pk, item.sk);
    index.put(updated);
    return c.json(await presentCard(updated, { detail: true }));
  });

  app.delete('/api/cards/:id', async (c) => {
    const user = me(c);
    const item = await loadCard(user, c.req.param('id'));
    // 保存前の名刺は、読み込んだ本人なら消せる。保存後は権限表のとおり（§9.3）
    const ownDraft = item.createdBy === user.id && item.status !== 'confirmed';
    if (!ownDraft && !canDeleteCard(user, item)) throw forbidden('この名刺を削除する権限がありません');
    const at = nowIso();
    const hist = await histItem({ id: item.id, type: 'delete', at, user, source: null, changes: [], card: item });
    await ddb.transact([
      {
        update: { pk: item.pk, sk: item.sk },
        set: { deletedAt: at, updatedAt: at, updatedBy: user.id, updatedByName: user.displayName, ...K.gsi1(item.id, at) },
        add: { version: 1 },
      },
      { put: hist },
    ]);
    index.put({ ...item, deletedAt: at, updatedAt: at });
    await audit(user, 'card.delete', { cardId: item.id });
    return c.json({ ok: true });
  });

  // その人との議事録（見える範囲だけ）。名刺が見えなければ 404
  app.get('/api/cards/:id/minutes', async (c) => {
    const user = me(c);
    const card = await loadCard(user, c.req.param('id'));
    const links = await ddb.queryAll({ pk: card.pk, skPrefix: 'MIN#', forward: false });
    const items = await listMinutesByIds(user, links.map((l) => String(l.sk).slice('MIN#'.length)));
    return c.json({ items, nextCursor: null });
  });
}
