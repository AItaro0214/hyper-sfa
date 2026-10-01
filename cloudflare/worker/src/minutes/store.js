// 議事録の D1 読み出しと、API 契約（api-contract.md §7）の形への変換。
import { HttpError } from './errors.js';
import { chunk } from './sql.js';

export function safeJson(s, fallback = null) {
  if (!s) return fallback;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

/** 行を契約の形にする */
export function materialItem(r) {
  return {
    id: r.id,
    seq: r.seq,
    name: r.name,
    kind: r.kind,
    size: r.size,
    pages: r.pages ?? null,
    outlineStatus: r.outline_status,
    uploadedBy: { id: r.uploaded_by, name: r.uploader_name ?? '' },
    uploadedAt: r.uploaded_at,
  };
}

/** 音声が見せられる状態か。期限は audio_expires_at（含む）まで */
export function audioState(row, now = new Date()) {
  const expired = row.audio_expires_at ? now.getTime() > new Date(row.audio_expires_at).getTime() : false;
  const deleted = Boolean(row.audio_deleted) || expired;
  const available = Boolean(row.audio_expires_at) && !expired && !row.audio_deleted;
  return { available, expiresAt: row.audio_expires_at ?? null, deleted };
}

/** 見られる人（作った人か共有された人）だけ行を返す。見える範囲の外は 404 */
export async function loadVisible(env, id, userId, { ownerOnly = false } = {}) {
  const row = await env.DB.prepare('SELECT * FROM minutes WHERE id = ? AND deleted_at IS NULL')
    .bind(id)
    .first();
  if (!row) throw new HttpError(404, 'not_found', '議事録が見つかりません');
  if (row.owner_id === userId) return { row, relation: 'owner' };
  const s = await env.DB.prepare('SELECT 1 AS x FROM minute_shares WHERE minute_id = ? AND user_id = ?')
    .bind(id, userId)
    .first();
  if (!s) throw new HttpError(404, 'not_found', '議事録が見つかりません');
  if (ownerOnly) throw new HttpError(403, 'forbidden', 'この操作は作った人だけができます');
  return { row, relation: 'shared' };
}

async function selectIn(env, sqlBefore, sqlAfter, ids) {
  const out = [];
  // D1 は bind が 100 個まで
  for (const part of chunk(ids, 90)) {
    const ph = part.map(() => '?').join(',');
    const r = await env.DB.prepare(`${sqlBefore} (${ph}) ${sqlAfter}`).bind(...part).all();
    out.push(...(r.results ?? []));
  }
  return out;
}

/** 行の配列を契約の形にする。相手・同席者（と、作った人の行には共有）をまとめて読む */
export async function hydrate(env, rows, userId, { withShares = false } = {}) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const cps = await selectIn(
    env,
    'SELECT minute_id, seq, card_id, company, department, name FROM minute_counterparts WHERE minute_id IN',
    'ORDER BY seq',
    ids,
  );
  const ats = await selectIn(
    env,
    'SELECT a.minute_id, a.user_id, u.display_name FROM minute_attendees a JOIN users u ON u.id = a.user_id WHERE a.minute_id IN',
    '',
    ids,
  );
  const ownedIds = rows.filter((r) => r.owner_id === userId).map((r) => r.id);
  const shs =
    withShares && ownedIds.length
      ? await selectIn(
          env,
          'SELECT s.minute_id, s.user_id, s.shared_at, u.display_name FROM minute_shares s JOIN users u ON u.id = s.user_id WHERE s.minute_id IN',
          'ORDER BY s.shared_at',
          ownedIds,
        )
      : [];
  // 資料（アップロードの途中のものは出さない）
  const mats = await selectIn(
    env,
    "SELECT m.*, u.display_name AS uploader_name FROM minute_materials m LEFT JOIN users u ON u.id = m.uploaded_by WHERE m.outline_status != 'uploading' AND m.minute_id IN",
    'ORDER BY m.seq',
    ids,
  );
  const by = (list) => {
    const m = new Map();
    for (const x of list) {
      if (!m.has(x.minute_id)) m.set(x.minute_id, []);
      m.get(x.minute_id).push(x);
    }
    return m;
  };
  const cpBy = by(cps);
  const atBy = by(ats);
  const shBy = by(shs);
  const matBy = by(mats);
  const now = new Date();
  return rows.map((r) => {
    const relation = r.owner_id === userId ? 'owner' : 'shared';
    const item = {
      id: r.id,
      title: r.title,
      heldAt: r.held_at,
      mode: r.mode,
      durationSec: r.duration_sec,
      memo: r.memo,
      status: r.status,
      progress: safeJson(r.progress),
      failure: safeJson(r.failure),
      owner: { id: r.owner_id, name: r.owner_name ?? '' },
      relation,
      counterparts: (cpBy.get(r.id) ?? []).map((c) => ({
        cardId: c.card_id ?? null,
        company: c.company,
        department: c.department,
        name: c.name,
        // Cloudflare 版は全員がすべての名刺を見られる
        cardVisible: true,
      })),
      attendees: (atBy.get(r.id) ?? []).map((a) => ({ id: a.user_id, name: a.display_name })),
      audio: audioState(r, now),
      transcript: r.transcript_key
        ? {
            version: r.transcript_version,
            createdAt: r.transcript_at,
            modelId: r.transcript_model,
            hasPrevious: Boolean(r.transcript_prev_key),
          }
        : null,
      summary: r.summary_key
        ? {
            version: r.summary_version,
            createdAt: r.summary_at,
            modelId: r.summary_model,
            hasPrevious: Boolean(r.summary_prev_key),
            withMaterials: Boolean(r.summary_with_materials),
            materialIds: r.summary_with_materials ? safeJson(r.summary_material_ids, []) : [],
          }
        : null,
      materials: (matBy.get(r.id) ?? []).map(materialItem),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
    if (relation === 'owner' && withShares) {
      item.shares = (shBy.get(r.id) ?? []).map((s) => ({
        id: s.user_id,
        name: s.display_name,
        sharedAt: s.shared_at,
      }));
    }
    return item;
  });
}

export async function loadDetail(env, id, userId) {
  const row = await env.DB.prepare(
    'SELECT m.*, u.display_name AS owner_name FROM minutes m JOIN users u ON u.id = m.owner_id WHERE m.id = ? AND m.deleted_at IS NULL',
  )
    .bind(id)
    .first();
  if (!row) throw new HttpError(404, 'not_found', '議事録が見つかりません');
  const [item] = await hydrate(env, [row], userId, { withShares: true });
  return item;
}
