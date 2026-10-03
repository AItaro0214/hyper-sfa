// 画像のアップロード、名刺の読み取り・検索・編集・削除（docs/api-contract.md §4）。
// 全員がすべての名刺を見られる（部署の仕組みは持たない）。
import { companyKey, groupByCompany, matchKeys, normalizeText, parseQuery, searchKeys, ulid } from '../core.js';
import {
  diffCards,
  failureFor,
  keyColumns,
  rowToCard,
  sanitizeCard,
} from '../lib/cards.js';
import { ApiError, conflict, notFound, rateLimited } from '../lib/errors.js';
import {
  GUARD_SQL,
  buildMatchQuery,
  contactStatements,
  isGuardError,
  matchesFromRows,
  personCardsOf,
  planCurrent,
  rowMatchKeys,
} from '../lib/person.js';
import { envNumber } from '../lib/http.js';
import { buildCardSearch, clampLimit, escapeLike } from '../lib/search.js';
import { signedPath, verifySignedPath } from '../lib/sign.js';
import { jstDay, jstDayStart, jstNextDayStart, nowIso, safeJson } from '../lib/time.js';
import { audit } from '../lib/usage.js';
import { Check, readJson, readJsonOptional } from '../lib/validate.js';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const UPLOAD_TTL_SEC = 15 * 60;
const KINDS = ['front', 'back', 'thumb'];
export const KEY_PATTERN = /^cards\/([0-9A-Z]{26})\/(front|back|thumb)\.jpg$/;
const SELECT_CARD = `SELECT c.*, cu.display_name AS created_by_name, uu.display_name AS updated_by_name
  FROM cards c LEFT JOIN users cu ON cu.id = c.created_by LEFT JOIN users uu ON uu.id = c.updated_by`;

async function loadCard(env, id) {
  const row = await env.DB.prepare(`${SELECT_CARD} WHERE c.id = ? AND c.deleted_at IS NULL`).bind(id).first();
  if (!row) throw notFound('名刺が見つかりません');
  return row;
}

// 同じ名刺・同じ人・同じ名前の候補（design §5.5b）。索引の効く = / IN だけで引き、全件は走査しない
async function findMatches(env, mine, selfId) {
  const q = buildMatchQuery(mine, { selfId });
  if (!q) return [];
  const { results } = await env.DB.prepare(q.sql).bind(...q.params).all();
  return matchesFromRows(results ?? [], mine);
}

// 人の名刺（自分を含む。古い順）。idx_cards_person で引く
async function loadPerson(env, row) {
  const { results } = await env.DB.prepare(
    `SELECT id, company, department, title, name, created_at, is_current FROM cards
     WHERE person_id = ? AND deleted_at IS NULL AND status IN ('review', 'confirmed')`,
  )
    .bind(row.person_id ?? row.id)
    .all();
  const rows = results ?? [];
  if (!rows.some((r) => r.id === row.id)) rows.push(row);
  return { cards: personCardsOf(rows) };
}

async function detailCard(env, row) {
  const card = rowToCard(row, { detail: true });
  card.person = await loadPerson(env, row);
  return card;
}

// 人に残る確認済みの名刺（自分を除く）。「現在」を付け直す材料
async function personPeers(env, personId, exceptId) {
  const { results } = await env.DB.prepare(
    `SELECT id, created_at, is_current, version, status FROM cards
     WHERE person_id = ? AND id != ? AND deleted_at IS NULL AND status = 'confirmed'`,
  )
    .bind(personId, exceptId)
    .all();
  return results ?? [];
}

// 「現在」のフラグを付け替える文。version を条件にし、0 行なら GUARD で batch ごと巻き戻す
function flipStatements(db, flips) {
  return flips.flatMap((f) => [
    db
      .prepare('UPDATE cards SET is_current = ?, version = version + 1 WHERE id = ? AND version = ? AND deleted_at IS NULL')
      .bind(f.current ? 1 : 0, f.id, f.version),
    db.prepare(GUARD_SQL),
  ]);
}

async function runBatch(env, stmts, message = 'ほかの人が先に更新しました。最新の内容を確かめてください') {
  try {
    await env.DB.batch(stmts);
  } catch (e) {
    if (isGuardError(e)) throw conflict(message);
    throw e;
  }
}

// 1 日の読み取り回数（再生成を含む）。超えていれば加算せずに 429
async function takeScanQuota(env, userId) {
  const limit = envNumber(env.SCAN_PER_DAY, 200);
  const res = await env.DB.prepare(
    `INSERT INTO scan_quota (user_id, day, count) VALUES (?, ?, 1)
     ON CONFLICT(user_id, day) DO UPDATE SET count = count + 1 WHERE count < ?
     RETURNING count`,
  )
    .bind(userId, jstDay(), limit)
    .first();
  if (!res) throw rateLimited(`名刺の読み取りは 1 日 ${limit} 回までです`);
}

async function startWorkflow(c, row, user, type) {
  try {
    await c.env.CARD_SCAN_WORKFLOW.create({
      id: `${row.id}-${row.scan_count}`,
      params: { cardId: row.id, userId: user.id, userName: user.displayName, type },
    });
  } catch {
    await c.env.DB.prepare('UPDATE cards SET status = ?, failure = ?, updated_at = ? WHERE id = ?')
      .bind('failed', JSON.stringify(failureFor('provider')), nowIso(), row.id)
      .run();
    throw new ApiError(502, 'provider_error', '読み取りを始められませんでした。もう一度お試しください');
  }
}

export function cardRoutes(app) {
  // ---- 画像のアップロード ----
  app.post('/api/uploads', async (c) => {
    const user = c.get('user');
    const body = await readJson(c);
    const check = new Check();
    const kinds = Array.isArray(body.kinds) && body.kinds.length ? [...new Set(body.kinds)] : [];
    if (!kinds.length || !kinds.every((k) => KINDS.includes(k))) check.fail('kinds', 'kinds は front / back / thumb から選んでください');
    check.done();
    const dir = ulid();
    const uploads = [];
    for (const kind of kinds) {
      const key = `cards/${dir}/${kind}.jpg`;
      // 署名に利用者 ID を入れて、他の人が発行した URL では書けないようにする
      uploads.push({
        kind,
        key,
        url: await signedPath(c.env, `/api/uploads/${key}`, UPLOAD_TTL_SEC, user.id),
        method: 'PUT',
        headers: { 'Content-Type': 'image/jpeg' },
      });
    }
    return c.json({ uploads });
  });

  // 本文をそのまま R2 に流す。Worker の中で画像の中身を読まない（CPU 10ms のため）
  app.put('/api/uploads/*', async (c) => {
    const user = c.get('user');
    const url = new URL(c.req.url);
    const key = decodeURIComponent(url.pathname.slice('/api/uploads/'.length));
    if (!KEY_PATTERN.test(key) || !(await verifySignedPath(c.env, url.pathname + url.search, user.id))) {
      throw new ApiError(403, 'forbidden', 'アップロード用の URL が正しくないか、期限が切れています');
    }
    const type = c.req.header('Content-Type') ?? '';
    if (!type.startsWith('image/jpeg')) throw new ApiError(400, 'validation', 'JPEG 画像を送ってください');
    const length = Number(c.req.header('Content-Length'));
    if (!Number.isFinite(length) || length <= 0) throw new ApiError(400, 'validation', 'Content-Length が必要です');
    if (length > MAX_IMAGE_BYTES) throw new ApiError(400, 'validation', '画像は 5MB までです');
    const stored = await c.env.IMAGES.put(key, c.req.raw.body, { httpMetadata: { contentType: 'image/jpeg' } });
    if (stored.size > MAX_IMAGE_BYTES) {
      await c.env.IMAGES.delete(key);
      throw new ApiError(400, 'validation', '画像は 5MB までです');
    }
    return c.json({ ok: true });
  });

  // ---- 読み取り ----
  app.post('/api/cards/scan', async (c) => {
    const user = c.get('user');
    const body = await readJson(c);
    const check = new Check();
    const front = check.str(body.frontKey, 'frontKey', { required: true });
    const thumb = check.str(body.thumbKey, 'thumbKey', { required: true });
    const back = check.str(body.backKey, 'backKey');
    const dirs = new Set();
    for (const [field, key] of [['frontKey', front], ['thumbKey', thumb], ['backKey', back]]) {
      if (!key) continue;
      const m = KEY_PATTERN.test(key) ? KEY_PATTERN.exec(key) : null;
      if (!m) check.fail(field, '画像のキーが正しくありません');
      else dirs.add(m[1]);
    }
    if (dirs.size > 1) check.fail('frontKey', '画像のキーが一組ではありません');
    check.done();
    for (const key of [front, thumb, back].filter(Boolean)) {
      if (!(await c.env.IMAGES.head(key))) throw new ApiError(400, 'validation', '画像がアップロードされていません', { details: [{ field: 'frontKey', message: '画像がアップロードされていません' }] });
    }

    await takeScanQuota(c.env, user.id);
    const id = ulid();
    const now = nowIso();
    await c.env.DB.prepare(
      `INSERT INTO cards (id, status, image_front_key, image_back_key, thumb_key, created_by, created_at, updated_at, scan_count, person_id)
       VALUES (?, 'processing', ?, ?, ?, ?, ?, ?, 1, ?)`,
    )
      .bind(id, front, back || null, thumb, user.id, now, now, id)
      .run();
    await startWorkflow(c, { id, scan_count: 1 }, user, 'scan');
    return c.json({ id, status: 'processing' }, 202);
  });

  app.get('/api/cards/:id/status', async (c) => {
    const row = await loadCard(c.env, c.req.param('id'));
    const out = { status: row.status };
    if (row.status === 'review' || row.status === 'confirmed') {
      out.card = await detailCard(c.env, row);
      if (row.status === 'review') out.card.matches = await findMatches(c.env, rowMatchKeys(row), row.id);
    }
    if (row.status === 'failed') out.failure = safeJson(row.failure, failureFor('provider'));
    return c.json(out);
  });

  app.post('/api/cards/:id/rescan', async (c) => {
    const user = c.get('user');
    const row = await loadCard(c.env, c.req.param('id'));
    // 読み取り中は二重に始めない。ただし 3 分以上動きが無ければ、止まったものとして再開を許す
    if (row.status === 'processing' && row.updated_at > new Date(Date.now() - 3 * 60000).toISOString()) {
      throw conflict('読み取り中です');
    }
    await takeScanQuota(c.env, user.id);
    const scanCount = row.scan_count + 1;
    await c.env.DB.prepare("UPDATE cards SET status = 'processing', failure = NULL, scan_count = ?, updated_at = ? WHERE id = ?")
      .bind(scanCount, nowIso(), row.id)
      .run();
    await startWorkflow(c, { id: row.id, scan_count: scanCount }, user, 'rescan');
    return c.json({ status: 'processing' }, 202);
  });

  // ---- 検索 ----
  // 取引先（会社 → 部署 → 人）。確認済みだけを読んで core の groupByCompany にまとめさせる。
  // 名刺は数千件まで。CPU 10ms に収めるため、q があるときは D1 側で先に絞る。
  // LIKE は表記ゆれを吸収しないので、元の q・正規化した q・法人格を除いた key の 3 通りを OR にして取りこぼしを防ぎ、
  // 最終的な絞り込みは groupByCompany（companyKey）が行う
  app.get('/api/companies', async (c) => {
    const q = (c.req.query('q') ?? '').trim();
    const where = ["status = 'confirmed'", 'deleted_at IS NULL', 'is_current = 1', "company != ''"];
    const params = [];
    if (q) {
      const likes = [];
      for (const [col, v] of [['company', q], ['company', normalizeText(q)], ['company_n', companyKey(q)]]) {
        if (!v) continue;
        likes.push(`${col} LIKE ? ESCAPE '\\'`);
        params.push(`%${escapeLike(v)}%`);
      }
      if (likes.length) where.push(`(${likes.join(' OR ')})`);
    }
    const { results } = await c.env.DB.prepare(
      `SELECT id, company, department, name, title FROM cards WHERE ${where.join(' AND ')}`,
    )
      .bind(...params)
      .all();
    const items = groupByCompany(
      (results ?? []).map((r) => ({ ...r, status: 'confirmed' })),
      { q, limit: c.req.query('limit') },
    );
    return c.json({ items });
  });

  app.get('/api/cards', async (c) => {
    const user = c.get('user');
    const q = c.req.query();
    const parsed = parseQuery(q);
    const status = ['processing', 'review', 'failed', 'confirmed'].includes(q.status) ? q.status : null;
    const limit = clampLimit(q.limit);
    const built = buildCardSearch(
      {
        terms: parsed,
        ownerId: q.owner || null,
        fromIso: q.from ? jstDayStart(q.from) : null,
        toIso: q.to ? jstNextDayStart(q.to) : null,
        status,
        viewerId: user.id,
      },
      {
        cursor: q.cursor || null,
        limit,
        prefix: 'c.',
        from: 'cards c',
        select: `SELECT c.*, cu.display_name AS created_by_name, uu.display_name AS updated_by_name`,
      },
    );
    // 表示名の JOIN は一覧の SELECT にだけ付ける（件数の数え直しには要らない）
    const listSql = built.listSql.replace(
      ' FROM cards c WHERE',
      ' FROM cards c LEFT JOIN users cu ON cu.id = c.created_by LEFT JOIN users uu ON uu.id = c.updated_by WHERE',
    );
    const [list, count] = await Promise.all([
      c.env.DB.prepare(listSql).bind(...built.listParams).all(),
      c.env.DB.prepare(built.countSql).bind(...built.countParams).first(),
    ]);
    const rows = list.results;
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return c.json({
      items: page.map((r) => rowToCard(r)),
      nextCursor: hasMore ? page[page.length - 1].id : null,
      total: count.n,
    });
  });

  app.get('/api/cards/:id', async (c) => {
    const row = await loadCard(c.env, c.req.param('id'));
    const card = await detailCard(c.env, row);
    if (row.status === 'review') card.matches = await findMatches(c.env, rowMatchKeys(row), row.id);
    return c.json(card);
  });

  // 画像は R2 の本文をそのまま返す（署名付き URL は使わない）
  app.get('/api/cards/:id/images/:kind', async (c) => {
    const kind = c.req.param('kind');
    if (!KINDS.includes(kind)) throw notFound();
    const row = await loadCard(c.env, c.req.param('id'));
    const key = { front: row.image_front_key, back: row.image_back_key, thumb: row.thumb_key }[kind];
    const object = key ? await c.env.IMAGES.get(key) : null;
    if (!object) throw notFound('画像が見つかりません');
    return new Response(object.body, {
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'private, max-age=300',
        ETag: object.httpEtag,
      },
    });
  });

  // ---- 画像の縮小（ブラウザが縮小して、同じキーに上書きする） ----
  // 上書き先は既存の /api/uploads/<key> の署名付き URL。署名にキーが入っているので他の名刺には書けない
  app.post('/api/cards/:id/images/replace', async (c) => {
    const user = c.get('user');
    const row = await loadCard(c.env, c.req.param('id'));
    if (row.status === 'processing') throw conflict('読み取り中です。終わってからもう一度お試しください');
    const uploads = [];
    for (const [kind, key] of [['front', row.image_front_key], ['back', row.image_back_key]]) {
      if (!key) continue;
      uploads.push({
        kind,
        url: await signedPath(c.env, `/api/uploads/${key}`, UPLOAD_TTL_SEC, user.id),
        method: 'PUT',
        headers: { 'Content-Type': 'image/jpeg' },
      });
    }
    return c.json({ uploads });
  });

  // 縮小済みの印。画像の中身の変更であって項目の変更ではないので、version も履歴も動かさない
  app.post('/api/cards/:id/images/optimized', async (c) => {
    const row = await loadCard(c.env, c.req.param('id'));
    const at = nowIso();
    await c.env.DB.prepare('UPDATE cards SET image_optimized = 1, image_optimized_at = ? WHERE id = ? AND deleted_at IS NULL')
      .bind(at, row.id)
      .run();
    return c.json({ imageOptimized: true, imageOptimizedAt: at });
  });

  // ---- 編集 ----
  app.put('/api/cards/:id', async (c) => {
    const user = c.get('user');
    const body = await readJson(c);
    const check = new Check();
    const input = {
      company: check.str(body.company, 'company', { max: 200, label: '会社名' }),
      department: check.str(body.department, 'department', { max: 200, label: '部署名' }),
      title: check.str(body.title, 'title', { max: 100, label: '役職' }),
      name: check.str(body.name, 'name', { max: 100, label: '氏名' }),
      nameReading: check.str(body.nameReading, 'nameReading', { max: 200, label: '氏名の読み' }),
      phones: check.strList(body.phones, 'phones', { label: '電話番号' }),
      mobiles: check.strList(body.mobiles, 'mobiles', { label: '携帯電話番号' }),
      emails: check.strList(body.emails, 'emails', { label: 'メールアドレス' }),
      note: check.str(body.note, 'note', { max: 2000, label: '備考' }),
    };
    if (!Number.isInteger(body.version)) check.fail('version', 'version が必要です');
    const source = ['review', 'search', 'detail'].includes(body.source) ? body.source : '';
    check.done();

    const row = await loadCard(c.env, c.req.param('id'));
    if (row.status === 'processing') throw conflict('読み取り中のため、まだ保存できません');
    if (row.version !== body.version) {
      throw conflict('ほかの人が先に更新しました。最新の内容を確かめてください', { current: rowToCard(row, { detail: true }) });
    }

    const before = rowToCard(row);
    const after = sanitizeCard(input);
    const changes = diffCards(before, after);
    const confirming = body.confirm === true && row.status !== 'confirmed';
    if (!changes.length && !confirming) return c.json(await detailCard(c.env, row));

    // 同じ人の判定は、確認して保存するときだけ（design §5.5b）
    let prev = null;
    if (confirming) {
      const action = body.personAction;
      if (action != null && action.kind !== 'update' && action.kind !== 'separate') {
        throw new ApiError(400, 'validation', 'personAction が正しくありません', {
          details: [{ field: 'personAction', message: 'update か separate を指定してください' }],
        });
      }
      if (action?.kind === 'update') {
        if (!action.ofCardId || typeof action.ofCardId !== 'string' || action.ofCardId === row.id) {
          throw new ApiError(400, 'validation', 'ofCardId が正しくありません', {
            details: [{ field: 'personAction', message: '前の名刺を指定してください' }],
          });
        }
        prev = await loadCard(c.env, action.ofCardId);
        if (prev.status !== 'confirmed' || prev.is_current === 0) {
          throw conflict('その名刺はすでに更新されています。最新の内容を読み込み直してください');
        }
      } else if (!action) {
        const matches = await findMatches(c.env, matchKeys(after), row.id);
        if (matches.some((m) => m.kind === 'same_person')) {
          throw new ApiError(400, 'validation', '同じ人の名刺があります。更新として登録するか、別の人として登録するかを選んでください', {
            details: { code: 'person_choice_required', matches },
          });
        }
      }
    }

    const sk = searchKeys(after);
    const keys = keyColumns(sk);
    const now = nowIso();
    const isEdit = row.status === 'confirmed' && changes.length > 0;
    const db = c.env.DB;
    const stmts = [];
    // 更新: 前の名刺を過去にする。同時に 2 人が更新しても、片方は GUARD で失敗して全体が巻き戻る
    if (prev) {
      stmts.push(
        db
          .prepare('UPDATE cards SET is_current = 0, version = version + 1 WHERE id = ? AND version = ? AND is_current = 1 AND deleted_at IS NULL')
          .bind(prev.id, prev.version),
        db.prepare(GUARD_SQL),
      );
    }
    stmts.push(
      db
        .prepare(
          `UPDATE cards SET status = ?, company = ?, department = ?, title = ?, name = ?, name_reading = ?,
             phones = ?, mobiles = ?, emails = ?, note = ?,
             company_n = ?, name_n = ?, reading_n = ?, department_n = ?, phones_digits = ?, emails_n = ?, title_n = ?, note_n = ?,
             failure = CASE WHEN ? THEN NULL ELSE failure END,
             person_id = COALESCE(?, person_id), supersedes = COALESCE(?, supersedes),
             updated_by = ?, updated_at = ?, edit_count = edit_count + ?, version = version + 1
           WHERE id = ? AND version = ? AND deleted_at IS NULL`,
        )
        .bind(
          confirming ? 'confirmed' : row.status,
          after.company, after.department, after.title, after.name, after.nameReading,
          JSON.stringify(after.phones), JSON.stringify(after.mobiles), JSON.stringify(after.emails), after.note,
          keys.company_n, keys.name_n, keys.reading_n, keys.department_n, keys.phones_digits, keys.emails_n, keys.title_n, keys.note_n,
          confirming ? 1 : 0,
          prev ? (prev.person_id ?? prev.id) : null, prev ? prev.id : null,
          user.id, now, isEdit ? 1 : 0,
          row.id, body.version,
        ),
      db.prepare(GUARD_SQL),
      ...contactStatements(db, row.id, sk),
    );
    // 履歴: 確認画面で保存 = 登録、登録後の変更 = 編集、更新として登録 = 名刺の更新。読み取り結果から変わっていない確認前の保存は残さない
    if (confirming || isEdit) {
      const histChanges = prev
        ? ['company', 'department', 'title']
            .filter((f) => (prev[f] ?? '') !== after[f])
            .map((f) => ({ field: f, before: prev[f] ?? '', after: after[f] }))
        : changes;
      stmts.push(
        db
          .prepare(`INSERT INTO card_history (id, card_id, type, actor_id, actor_name, source, changes, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(ulid(), row.id, prev ? 'person_update' : confirming ? 'create' : 'edit', user.id, user.displayName, source, JSON.stringify(histChanges), now),
      );
    }
    await runBatch(c.env, stmts);
    return c.json(await detailCard(c.env, await loadCard(c.env, row.id)));
  });

  // ---- 同じ人 ----
  // 保存済みの名刺を、後から同じ人につなぐ。つなぐのは相手の人に、この名刺 1 枚だけ
  app.post('/api/cards/:id/person/link', async (c) => {
    const body = await readJson(c);
    const check = new Check();
    const ofCardId = check.str(body.ofCardId, 'ofCardId', { required: true });
    check.done();
    const row = await loadCard(c.env, c.req.param('id'));
    const target = await loadCard(c.env, ofCardId);
    if (row.id === target.id) throw new ApiError(400, 'validation', '同じ名刺は選べません', { details: [{ field: 'ofCardId', message: '別の名刺を選んでください' }] });
    if (row.status !== 'confirmed' || target.status !== 'confirmed') throw conflict('保存済みの名刺だけをつなげられます');
    const fromPid = row.person_id ?? row.id;
    const toPid = target.person_id ?? target.id;
    if (fromPid === toPid) return c.json(await detailCard(c.env, row));
    if ((await personPeers(c.env, fromPid, row.id)).length) {
      throw conflict('この名刺は別の人ともつながっています。先に「つながりを外す」を行ってください');
    }
    const peers = await personPeers(c.env, toPid, row.id);
    const me = { id: row.id, created_at: row.created_at, is_current: 1, version: row.version, status: 'confirmed' };
    const { top, flips } = planCurrent([...peers, me]);
    const current = top?.id === row.id;
    const older = peers.filter((p) => p.created_at < row.created_at).sort((a, b) => (a.created_at < b.created_at ? -1 : 1)).at(-1);
    const db = c.env.DB;
    await runBatch(c.env, [
      db
        .prepare('UPDATE cards SET person_id = ?, is_current = ?, supersedes = ?, version = version + 1 WHERE id = ? AND version = ? AND deleted_at IS NULL')
        .bind(toPid, current ? 1 : 0, older?.id ?? null, row.id, row.version),
      db.prepare(GUARD_SQL),
      ...flipStatements(db, flips.filter((f) => f.id !== row.id)),
    ]);
    return c.json(await detailCard(c.env, await loadCard(c.env, row.id)));
  });

  // 間違ってつないだものを外す。この名刺だけを新しい人にし、残った人の「現在」を一番新しい名刺に付け直す
  app.post('/api/cards/:id/person/unlink', async (c) => {
    const row = await loadCard(c.env, c.req.param('id'));
    if (row.status !== 'confirmed') throw conflict('保存済みの名刺だけが対象です');
    const peers = await personPeers(c.env, row.person_id ?? row.id, row.id);
    if (!peers.length) return c.json(await detailCard(c.env, row));
    const { flips } = planCurrent(peers);
    const db = c.env.DB;
    await runBatch(c.env, [
      db
        .prepare('UPDATE cards SET person_id = ?, is_current = 1, supersedes = NULL, version = version + 1 WHERE id = ? AND version = ? AND deleted_at IS NULL')
        .bind(ulid(), row.id, row.version),
      db.prepare(GUARD_SQL),
      ...flipStatements(db, flips),
    ]);
    return c.json(await detailCard(c.env, await loadCard(c.env, row.id)));
  });

  // 論理削除。30 日後にログイン時の掃除で画像ごと消える。管理者だけ（cloudflare-small-design §4）。
  // 例外: 登録の途中（保存前）の自分の下書きは、本人が取りやめられる
  app.delete('/api/cards/:id', async (c) => {
    const user = c.get('user');
    const row = await loadCard(c.env, c.req.param('id'));
    const ownDraft = row.created_by === user.id && row.status !== 'confirmed';
    if (!ownDraft && user.role !== 'admin') throw new ApiError(403, 'forbidden', 'この名刺を削除する権限がありません');
    const now = nowIso();
    const stmts = [
      c.env.DB.prepare('UPDATE cards SET deleted_at = ?, updated_by = ?, updated_at = ? WHERE id = ?').bind(now, user.id, now, row.id),
      c.env.DB.prepare(
        `INSERT INTO card_history (id, card_id, type, actor_id, actor_name, source, changes, at) VALUES (?, ?, 'delete', ?, ?, '', '[]', ?)`,
      ).bind(ulid(), row.id, user.id, user.displayName, now),
    ];
    // 現在の名刺を消したら、残った人の一番新しい名刺を「現在」に戻す（人の名刺が一覧から消えないように）
    if (row.status === 'confirmed' && row.is_current !== 0) {
      const { flips } = planCurrent(await personPeers(c.env, row.person_id ?? row.id, row.id));
      stmts.push(...flipStatements(c.env.DB, flips));
    }
    await runBatch(c.env, stmts, 'ほかの人が先に更新しました。もう一度お試しください');
    await audit(c.env, user.id, 'card.delete', { cardId: row.id });
    return c.json({ ok: true });
  });
}

export { SELECT_CARD };
