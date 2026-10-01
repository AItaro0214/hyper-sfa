// 議事録のルート（docs/api-contract.md §7、§4 の GET /api/cards/{id}/minutes、§6 の minutes-test）。
// 見られるのは作った人と共有された人だけ。管理者でも見られない（minutes-design.md §8）。
import { normalizeText, ulid, usageEvent } from '@hyper-sfa/core';
import { getModel, getPrompt, getSelectedModel } from '../lib/settings.js';
import { audit, recordUsage } from '../lib/usage.js';
import { HttpError, validationError } from './errors.js';
import { hydrate, loadDetail, loadVisible, audioState, safeJson } from './store.js';
import { buildListQuery, encodeCursor, chunk } from './sql.js';
import { planStart } from './rules.js';
import { sign, verify } from './signing.js';
import { materialsRoutes } from './materials.js';

const AUDIO_KEEP_MS = 7 * 24 * 3600 * 1000;
const SEGMENT_MAX_BYTES = 10 * 1024 * 1024; // 契約 §9
const FULL_AUDIO_MAX_BYTES = 100 * 1024 * 1024;
const UPLOAD_URL_TTL_SEC = 15 * 60;
// 再生中のシーク（Range）で URL が切れないよう、契約の「5 分」より長くしている。R2 の本文は署名とセッションの両方を確かめてから返す
const AUDIO_URL_TTL_SEC = 60 * 60;
const TEST_KEEP_MS = 24 * 3600 * 1000;

const nowIso = () => new Date().toISOString();

async function readBody(c) {
  try {
    const b = await c.req.json();
    return b && typeof b === 'object' ? b : {};
  } catch {
    return {};
  }
}

function extOf(mime) {
  const m = String(mime || '').split(';')[0].trim().toLowerCase();
  if (m === 'audio/webm' || m === 'video/webm') return 'webm';
  if (m === 'audio/mp4' || m === 'audio/m4a' || m === 'audio/x-m4a' || m === 'audio/aac') return 'm4a';
  if (m === 'audio/ogg') return 'ogg';
  if (m === 'audio/mpeg') return 'mp3';
  if (m === 'audio/wav' || m === 'audio/x-wav') return 'wav';
  return 'bin';
}
const isAudioMime = (m) => /^(audio\/|video\/webm)/i.test(String(m || ''));
const int = (v, def = 0) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : def);

function safeFilenamePart(s) {
  return String(s || '').replace(/[\\/:*?"<>|\r\n\t]/g, '').replace(/\s+/g, '').slice(0, 60);
}

/** 一覧（GET /api/minutes と GET /api/cards/:id/minutes）の共通部分 */
async function listMinutes(c, extra = {}) {
  const user = c.get('user');
  const q = c.req.query();
  for (const k of ['from', 'to']) {
    if (q[k] && !/^\d{4}-\d{2}-\d{2}$/.test(q[k])) {
      throw validationError(`${k} は YYYY-MM-DD で指定してください`, [{ field: k, message: 'YYYY-MM-DD で指定してください' }]);
    }
  }
  const { sql, params, limit } = buildListQuery({
    userId: user.id,
    relation: q.relation,
    company: q.company,
    name: q.name,
    cardId: q.cardId,
    attendee: q.attendee,
    from: q.from,
    to: q.to,
    title: q.title,
    owner: q.owner,
    cursor: q.cursor,
    limit: q.limit,
    normalize: normalizeText,
    ...extra,
  });
  const rows = (await c.env.DB.prepare(sql).bind(...params).all()).results ?? [];
  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? encodeCursor(page[page.length - 1]) : null;
  const items = await hydrate(c.env, page, user.id);
  return c.json({ items, nextCursor });
}

/** generate / regenerate の共通。状態を queued にして Workflow を起こす */
async function startWorkflow(c, row, req) {
  const { target, takeover } = planStart(row, req);
  const withMaterials = Boolean(req.withMaterials);
  if (withMaterials) {
    if (target !== 'summary') throw validationError('資料を踏まえて作り直せるのは議事録だけです', [{ field: 'withMaterials', message: 'target が summary のときだけ' }]);
    const n = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM minute_materials WHERE minute_id = ? AND outline_status != 'uploading'").bind(row.id).first();
    if (!n?.n) throw validationError('資料がありません。先に資料を追加してください', [{ field: 'withMaterials', message: '資料が 0 件です' }]);
  }
  const segs = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM minute_segments WHERE minute_id = ? AND uploaded = 1')
    .bind(row.id)
    .first();
  if (target !== 'summary' && !segs?.n) throw validationError('送信済みの音声がありません');
  if (takeover && row.workflow_id) {
    // 止まったまま残っている前の実行があれば、終わらせてから起こし直す（失敗しても続ける）
    try {
      const inst = await c.env.MINUTES_WORKFLOW.get(row.workflow_id);
      await inst.terminate();
    } catch {
      // 無視
    }
  }
  const stmts = [];
  if (req.mode === 'regenerate' && target === 'transcript') {
    // 文字起こしの作り直しは全区切りをやり直す。generate（続きから）では触らない
    stmts.push(c.env.DB.prepare("UPDATE minute_segments SET transcript_status = 'pending' WHERE minute_id = ?").bind(row.id));
  }
  const workflowId = `${row.id}-${Date.now().toString(36)}`;
  stmts.push(
    c.env.DB.prepare(
      "UPDATE minutes SET status = 'queued', step = NULL, failure = NULL, workflow_id = ?, updated_at = ? WHERE id = ?",
    ).bind(workflowId, nowIso(), row.id),
  );
  await c.env.DB.batch(stmts);
  try {
    await c.env.MINUTES_WORKFLOW.create({ id: workflowId, params: { minuteId: row.id, target, ...(withMaterials ? { withMaterials: true } : {}) } });
  } catch {
    await c.env.DB.prepare("UPDATE minutes SET status = 'failed', failure = ?, updated_at = ? WHERE id = ?")
      .bind(
        JSON.stringify({ step: target === 'summary' ? 'summarize' : 'transcribe', kind: 'internal', message: '作成を開始できませんでした', retryable: true }),
        nowIso(),
        row.id,
      )
      .run();
    throw new HttpError(503, 'not_configured', '作成を開始できませんでした。もう一度試してください');
  }
  return c.json({ status: 'queued' }, 202);
}

async function upsertSegmentRow(env, id, seq, key, mime, startSec, durationSec, size) {
  await env.DB.prepare(
    `INSERT INTO minute_segments (minute_id, seq, key, mime, start_sec, duration_sec, size, uploaded, transcript_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'pending')
     ON CONFLICT(minute_id, seq) DO UPDATE SET key = excluded.key, mime = excluded.mime, start_sec = excluded.start_sec,
       duration_sec = excluded.duration_sec, size = excluded.size, uploaded = 0, transcript_status = 'pending', transcript_key = NULL`,
  )
    .bind(id, seq, key, mime, startSec, durationSec, size)
    .run();
}

async function deleteByPrefix(bucket, prefix) {
  let cursor;
  do {
    const r = await bucket.list({ prefix, cursor });
    const keys = r.objects.map((o) => o.key);
    if (keys.length) await bucket.delete(keys);
    cursor = r.truncated ? r.cursor : undefined;
  } while (cursor);
}

export function minutesRoutes(app) {
  materialsRoutes(app);
  // ---- 作る・録音 ----
  app.post('/api/minutes', async (c) => {
    const user = c.get('user');
    const body = await readBody(c);
    const mode = body.mode === 'room' ? 'room' : body.mode === 'web' ? 'web' : null;
    if (!mode) throw validationError('mode は web か room です', [{ field: 'mode', message: 'web か room を指定してください' }]);
    const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 200) : '無題の議事録';
    // 選択中の文字起こしモデルが 1 回に渡せる長さに合わせる（Cloudflare 版は ffmpeg が無く、後から分け直せないため）
    let segmentSec = int(c.env.SEGMENT_SEC, 600) || 600;
    try {
      const model = await getModel(c.env, await getSelectedModel(c.env, 'transcribe'));
      const max = Number(model?.maxAudioMinutes ?? model?.max_audio_minutes);
      if (max > 0) segmentSec = Math.min(segmentSec, Math.floor(max * 60));
    } catch {
      // モデルが未設定でも録音は始められる（作成の段階で「設定に問題があります」になる）
    }
    const id = ulid();
    const now = nowIso();
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO minutes (id, title, held_at, mode, owner_id, status, segment_sec, audio_mime, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'recording', ?, 'audio/webm', ?, ?)`,
      ).bind(id, title, now, mode, user.id, segmentSec, now, now),
      c.env.DB.prepare('INSERT INTO minute_attendees (minute_id, user_id) VALUES (?, ?)').bind(id, user.id),
    ]);
    return c.json({ id, segmentSec, audioMime: 'audio/webm' });
  });

  app.post('/api/minutes/:id/segments', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const { row } = await loadVisible(c.env, id, user.id, { ownerOnly: true });
    if (!['recording', 'uploaded'].includes(row.status)) throw new HttpError(409, 'conflict', 'この議事録には音声を追加できません');
    const b = await readBody(c);
    const seq = int(b.seq, -1);
    if (seq < 0 || seq > 999) throw validationError('seq が不正です', [{ field: 'seq', message: '0〜999 の整数' }]);
    if (!isAudioMime(b.mime)) throw validationError('mime が不正です', [{ field: 'mime', message: '音声の形式を指定してください' }]);
    const size = int(b.size, 0);
    if (size > SEGMENT_MAX_BYTES) throw validationError('区切りが大きすぎます（10MB まで）', [{ field: 'size', message: '10MB まで' }]);
    const key = `minutes/${id}/seg-${seq}.${extOf(b.mime)}`;
    await upsertSegmentRow(c.env, id, seq, key, String(b.mime), Math.max(0, int(b.startSec)), Math.max(0, int(b.durationSec)), size);
    const url = await sign(c.env, `/api/minutes/${id}/segments/${seq}/upload`, UPLOAD_URL_TTL_SEC);
    return c.json({ key, url, method: 'PUT', headers: { 'Content-Type': String(b.mime) } });
  });

  // 本文は読まずに R2 へそのまま流す（CPU 10 ミリ秒のため）
  app.put('/api/minutes/:id/segments/:seq/upload', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const seq = int(c.req.param('seq'), -1);
    if (!(await verify(c.env, c.req.url))) throw new HttpError(403, 'forbidden', 'アップロードの期限が切れました。もう一度試してください');
    await loadVisible(c.env, id, user.id, { ownerOnly: true });
    const seg = await c.env.DB.prepare('SELECT key, mime FROM minute_segments WHERE minute_id = ? AND seq = ?').bind(id, seq).first();
    if (!seg) throw new HttpError(404, 'not_found', '区切りが登録されていません');
    const len = int(c.req.header('content-length'), 0);
    if (len <= 0) throw validationError('Content-Length が必要です');
    if (len > SEGMENT_MAX_BYTES) throw validationError('区切りが大きすぎます（10MB まで）');
    await c.env.AUDIO.put(seg.key, c.req.raw.body, { httpMetadata: { contentType: baseMimeOf(seg.mime) } });
    return c.json({ ok: true });
  });

  app.put('/api/minutes/:id/segments/:seq/done', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const seq = int(c.req.param('seq'), -1);
    await loadVisible(c.env, id, user.id, { ownerOnly: true });
    const seg = await c.env.DB.prepare('SELECT key FROM minute_segments WHERE minute_id = ? AND seq = ?').bind(id, seq).first();
    if (!seg) throw new HttpError(404, 'not_found', '区切りが登録されていません');
    const head = await c.env.AUDIO.head(seg.key);
    if (!head) throw new HttpError(409, 'conflict', '音声がまだ届いていません');
    await c.env.DB.prepare('UPDATE minute_segments SET uploaded = 1, size = ? WHERE minute_id = ? AND seq = ?').bind(head.size, id, seq).run();
    return c.json({ ok: true });
  });

  // Cloudflare 版だけ: 録音したままの形式の通しの 1 本（ffmpeg が無いので、ダウンロード用に別に送る）
  app.post('/api/minutes/:id/full-audio', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const { row } = await loadVisible(c.env, id, user.id, { ownerOnly: true });
    const b = await readBody(c);
    if (!isAudioMime(b.mime)) throw validationError('mime が不正です', [{ field: 'mime', message: '音声の形式を指定してください' }]);
    if (int(b.size, 0) > FULL_AUDIO_MAX_BYTES) throw validationError('音声が大きすぎます');
    const key = `minutes/${id}/audio.${extOf(b.mime)}`;
    await c.env.DB.prepare('UPDATE minutes SET audio_mime = ?, updated_at = ? WHERE id = ?').bind(String(b.mime), nowIso(), row.id).run();
    const url = await sign(c.env, `/api/minutes/${id}/full-audio/upload`, UPLOAD_URL_TTL_SEC);
    return c.json({ key, url, method: 'PUT', headers: { 'Content-Type': String(b.mime) } });
  });

  app.put('/api/minutes/:id/full-audio/upload', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    if (!(await verify(c.env, c.req.url))) throw new HttpError(403, 'forbidden', 'アップロードの期限が切れました。もう一度試してください');
    const { row } = await loadVisible(c.env, id, user.id, { ownerOnly: true });
    const len = int(c.req.header('content-length'), 0);
    if (len <= 0) throw validationError('Content-Length が必要です');
    if (len > FULL_AUDIO_MAX_BYTES) throw validationError('音声が大きすぎます');
    const key = `minutes/${id}/audio.${extOf(row.audio_mime)}`;
    await c.env.AUDIO.put(key, c.req.raw.body, { httpMetadata: { contentType: baseMimeOf(row.audio_mime) } });
    await c.env.DB.prepare('UPDATE minutes SET full_audio_key = ?, updated_at = ? WHERE id = ?').bind(key, nowIso(), id).run();
    return c.json({ ok: true });
  });

  app.post('/api/minutes/:id/finish', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const { row } = await loadVisible(c.env, id, user.id, { ownerOnly: true });
    if (!['recording', 'uploaded'].includes(row.status)) throw new HttpError(409, 'conflict', 'すでに録音は終わっています');
    const b = await readBody(c);
    const durationSec = Math.min(Math.max(int(b.durationSec, 0), 0), 7200 + 60);
    const want = int(b.segments, 0);
    const got = (await c.env.DB.prepare('SELECT COUNT(*) AS n FROM minute_segments WHERE minute_id = ? AND uploaded = 1').bind(id).first())?.n ?? 0;
    if (got === 0 || (want > 0 && got < want)) {
      throw validationError('送信が終わっていない区切りがあります。通信が戻ってからもう一度試してください');
    }
    // 設計書 §6.2: 録音を終えてから 7 日。R2 の削除（ライフサイクル）は日単位なので、渡すのを止めるのはアプリ側
    const expires = new Date(Date.now() + AUDIO_KEEP_MS).toISOString();
    await c.env.DB.prepare(
      "UPDATE minutes SET status = 'uploaded', duration_sec = ?, audio_expires_at = ?, updated_at = ? WHERE id = ?",
    )
      .bind(durationSec, expires, nowIso(), id)
      .run();
    if (row.status === 'recording') {
      try {
        await recordUsage(c.env, usageEvent({ kind: 'record', userId: user.id, audioSeconds: durationSec, ok: true }));
      } catch {
        // 記録に失敗しても録音は終わらせる
      }
    }
    return c.json({ id, status: 'uploaded' });
  });

  // ---- 相手・同席者・タイトル・メモ ----
  app.put('/api/minutes/:id', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const { row } = await loadVisible(c.env, id, user.id, { ownerOnly: true });
    const b = await readBody(c);
    const stmts = [];
    const sets = [];
    const vals = [];
    if (b.title !== undefined) {
      if (typeof b.title !== 'string' || b.title.length > 200) throw validationError('タイトルは 200 文字までです', [{ field: 'title', message: '200 文字まで' }]);
      sets.push('title = ?');
      vals.push(b.title.trim() || '無題の議事録');
    }
    if (b.memo !== undefined) {
      if (typeof b.memo !== 'string' || b.memo.length > 5000) throw validationError('メモは 5,000 文字までです', [{ field: 'memo', message: '5,000 文字まで' }]);
      sets.push('memo = ?');
      vals.push(b.memo);
    }
    sets.push('updated_at = ?');
    vals.push(nowIso());
    stmts.push(c.env.DB.prepare(`UPDATE minutes SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, id));

    if (b.counterparts !== undefined) {
      if (!Array.isArray(b.counterparts) || b.counterparts.length > 20) throw validationError('相手は 20 人までです', [{ field: 'counterparts', message: '20 人まで' }]);
      const cardIds = [...new Set(b.counterparts.map((x) => x?.cardId).filter(Boolean))];
      const cards = new Map();
      for (const part of chunk(cardIds, 90)) {
        const r = await c.env.DB.prepare(
          `SELECT id, company, department, name FROM cards WHERE deleted_at IS NULL AND id IN (${part.map(() => '?').join(',')})`,
        )
          .bind(...part)
          .all();
        for (const card of r.results ?? []) cards.set(card.id, card);
      }
      const list = [];
      for (const x of b.counterparts) {
        if (x?.cardId) {
          const card = cards.get(x.cardId);
          if (!card) throw validationError('名刺が見つかりません', [{ field: 'counterparts', message: `名刺 ${x.cardId} が見つかりません` }]);
          // 紐づけた時点の内容を写す（後で名刺が直されても議事録の表示は変わらない）
          list.push({ cardId: card.id, company: card.company, department: card.department, name: card.name });
        } else {
          const t = (v) => (typeof v === 'string' ? v.trim().slice(0, 200) : '');
          const item = { cardId: null, company: t(x?.company), department: t(x?.department), name: t(x?.name) };
          if (item.company || item.name) list.push(item);
        }
      }
      stmts.push(c.env.DB.prepare('DELETE FROM minute_counterparts WHERE minute_id = ?').bind(id));
      list.forEach((x, i) => {
        stmts.push(
          c.env.DB.prepare(
            'INSERT INTO minute_counterparts (minute_id, seq, card_id, company, department, name, company_n, name_n) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          ).bind(id, i, x.cardId, x.company, x.department, x.name, normalizeText(x.company), normalizeText(x.name)),
        );
      });
    }

    if (b.attendeeIds !== undefined) {
      if (!Array.isArray(b.attendeeIds) || b.attendeeIds.length > 50) throw validationError('同席者は 50 人までです', [{ field: 'attendeeIds', message: '50 人まで' }]);
      const wanted = [...new Set(b.attendeeIds.filter((x) => typeof x === 'string'))];
      const valid = new Set();
      for (const part of chunk(wanted, 90)) {
        const r = await c.env.DB.prepare(`SELECT id FROM users WHERE status = 'active' AND id IN (${part.map(() => '?').join(',')})`)
          .bind(...part)
          .all();
        for (const u of r.results ?? []) valid.add(u.id);
      }
      valid.add(row.owner_id); // 作った人は必ず含める
      stmts.push(c.env.DB.prepare('DELETE FROM minute_attendees WHERE minute_id = ?').bind(id));
      for (const uid of valid) {
        stmts.push(c.env.DB.prepare('INSERT INTO minute_attendees (minute_id, user_id) VALUES (?, ?)').bind(id, uid));
      }
    }
    await c.env.DB.batch(stmts);
    return c.json(await loadDetail(c.env, id, user.id));
  });

  // ---- 作成・再生成・戻す ----
  app.post('/api/minutes/:id/generate', async (c) => {
    const { row } = await loadVisible(c.env, c.req.param('id'), c.get('user').id, { ownerOnly: true });
    return await startWorkflow(c, row, { mode: 'generate' });
  });

  app.post('/api/minutes/:id/regenerate', async (c) => {
    const { row } = await loadVisible(c.env, c.req.param('id'), c.get('user').id, { ownerOnly: true });
    const b = await readBody(c);
    return await startWorkflow(c, row, { mode: 'regenerate', target: b.target, withMaterials: b.withMaterials === true });
  });

  app.post('/api/minutes/:id/revert', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const { row } = await loadVisible(c.env, id, user.id, { ownerOnly: true });
    const b = await readBody(c);
    if (b.target !== 'summary' && b.target !== 'transcript') {
      throw validationError('target は summary か transcript です', [{ field: 'target', message: 'summary か transcript を指定してください' }]);
    }
    if (['queued', 'transcribing', 'summarizing'].includes(row.status)) throw new HttpError(409, 'conflict', '処理中は戻せません');
    const col = b.target === 'summary' ? 'summary' : 'transcript';
    if (!row[`${col}_prev_key`]) throw validationError('戻せる前の内容がありません');
    // 議事録は、資料を踏まえた版かどうかと対応表も一緒に入れ替える
    const extra =
      col === 'summary'
        ? ', summary_with_materials = summary_prev_with_materials, summary_prev_with_materials = summary_with_materials, summary_mapping_key = summary_prev_mapping_key, summary_prev_mapping_key = summary_mapping_key'
        : '';
    // 版の番号は戻さない（増える一方にして、新しい版のファイル名が古いものと重ならないようにする）。SET の右辺は更新前の値で評価される
    await c.env.DB.prepare(
      `UPDATE minutes SET ${col}_key = ${col}_prev_key, ${col}_prev_key = ${col}_key${extra}, updated_at = ? WHERE id = ?`,
    )
      .bind(nowIso(), id)
      .run();
    return c.json(await loadDetail(c.env, id, user.id));
  });

  // ---- 読む ----
  app.get('/api/minutes', (c) => listMinutes(c));

  app.get('/api/cards/:id/minutes', (c) => listMinutes(c, { cardId: c.req.param('id'), relation: 'all' }));

  app.get('/api/minutes/:id', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    await loadVisible(c.env, id, user.id);
    return c.json(await loadDetail(c.env, id, user.id));
  });

  app.get('/api/minutes/:id/transcript', async (c) => {
    const { row } = await loadVisible(c.env, c.req.param('id'), c.get('user').id);
    if (!row.transcript_key) throw new HttpError(404, 'not_found', '文字起こしはまだありません');
    const o = await c.env.DATA.get(row.transcript_key);
    if (!o) throw new HttpError(404, 'not_found', '文字起こしが見つかりません');
    return c.json({ text: await o.text(), version: row.transcript_version });
  });

  app.get('/api/minutes/:id/summary', async (c) => {
    const { row } = await loadVisible(c.env, c.req.param('id'), c.get('user').id);
    if (!row.summary_key) throw new HttpError(404, 'not_found', '議事録はまだありません');
    const o = await c.env.DATA.get(row.summary_key);
    if (!o) throw new HttpError(404, 'not_found', '議事録が見つかりません');
    const out = { markdown: await o.text(), version: row.summary_version, withMaterials: Boolean(row.summary_with_materials) };
    if (out.withMaterials) {
      // 対応表は資料を踏まえた版だけ。文章の JSON なので読んでよい
      let mapping = [];
      const mo = row.summary_mapping_key ? await c.env.DATA.get(row.summary_mapping_key) : null;
      if (mo) {
        const v = safeJson(await mo.text(), []);
        mapping = Array.isArray(v) ? v : Array.isArray(v?.mapping) ? v.mapping : [];
      }
      out.mapping = mapping;
    }
    return c.json(out);
  });

  // ---- 音声 ----
  app.get('/api/minutes/:id/audio-url', async (c) => {
    const { row } = await loadVisible(c.env, c.req.param('id'), c.get('user').id);
    const st = audioState(row);
    if (st.deleted) throw new HttpError(404, 'not_found', '音声は削除されました');
    if (!row.full_audio_key) throw new HttpError(404, 'not_found', '音声がありません');
    const url = await sign(c.env, `/api/minutes/${row.id}/audio`, AUDIO_URL_TTL_SEC);
    const date = jstDate(row.held_at);
    const filename = `${date}_${safeFilenamePart(row.title) || '議事録'}.${extOf(row.audio_mime)}`;
    return c.json({ url, expiresAt: new Date(Date.now() + AUDIO_URL_TTL_SEC * 1000).toISOString(), filename });
  });

  app.get('/api/minutes/:id/audio', async (c) => {
    if (!(await verify(c.env, c.req.url))) throw new HttpError(403, 'forbidden', 'URL の期限が切れました。もう一度開いてください');
    const { row } = await loadVisible(c.env, c.req.param('id'), c.get('user').id);
    if (audioState(row).deleted) throw new HttpError(404, 'not_found', '音声は削除されました');
    if (!row.full_audio_key) throw new HttpError(404, 'not_found', '音声がありません');
    const rangeHeader = c.req.header('range');
    const obj = await c.env.AUDIO.get(row.full_audio_key, rangeHeader ? { range: c.req.raw.headers } : undefined);
    if (!obj) throw new HttpError(404, 'not_found', '音声がありません');
    const headers = new Headers({
      'Content-Type': baseMimeOf(row.audio_mime),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-store',
    });
    let status = 200;
    if (rangeHeader && obj.range && obj.range.offset !== undefined) {
      const { offset, length } = obj.range;
      status = 206;
      headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${obj.size}`);
      headers.set('Content-Length', String(length));
    } else {
      headers.set('Content-Length', String(obj.size));
    }
    if (c.req.query('download') === '1') {
      const name = `${jstDate(row.held_at)}_${safeFilenamePart(row.title) || '議事録'}.${extOf(row.audio_mime)}`;
      headers.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    }
    return new Response(obj.body, { status, headers });
  });

  // ---- 共有 ----
  app.get('/api/minutes/:id/shares', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    await loadVisible(c.env, id, user.id, { ownerOnly: true });
    return c.json({ items: await listShares(c.env, id) });
  });

  app.post('/api/minutes/:id/shares', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const { row } = await loadVisible(c.env, id, user.id, { ownerOnly: true });
    const b = await readBody(c);
    if (!Array.isArray(b.userIds) || b.userIds.length === 0) throw validationError('userIds が必要です', [{ field: 'userIds', message: '1 人以上' }]);
    if (b.userIds.length > 50) throw validationError('一度に共有できるのは 50 人までです', [{ field: 'userIds', message: '50 人まで' }]);
    const wanted = [...new Set(b.userIds.filter((x) => typeof x === 'string' && x !== row.owner_id))];
    const valid = [];
    for (const part of chunk(wanted, 90)) {
      const r = await c.env.DB.prepare(`SELECT id FROM users WHERE status = 'active' AND id IN (${part.map(() => '?').join(',')})`)
        .bind(...part)
        .all();
      valid.push(...(r.results ?? []).map((u) => u.id));
    }
    const at = nowIso();
    if (valid.length) {
      await c.env.DB.batch(
        valid.map((uid) =>
          c.env.DB.prepare('INSERT OR IGNORE INTO minute_shares (minute_id, user_id, shared_by, shared_at) VALUES (?, ?, ?, ?)').bind(id, uid, user.id, at),
        ),
      );
      // 誰が・いつ・誰に。タイトルは記録に入れない
      await audit(c.env, user.id, 'minutes.share', { minuteId: id, userIds: valid });
    }
    return c.json({ items: await listShares(c.env, id) });
  });

  app.delete('/api/minutes/:id/shares/:userId', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const target = c.req.param('userId');
    await loadVisible(c.env, id, user.id, { ownerOnly: true });
    await c.env.DB.prepare('DELETE FROM minute_shares WHERE minute_id = ? AND user_id = ?').bind(id, target).run();
    await audit(c.env, user.id, 'minutes.unshare', { minuteId: id, userId: target });
    return c.json({ items: await listShares(c.env, id) });
  });

  // ---- 削除（論理削除 + 音声と文章を消す） ----
  app.delete('/api/minutes/:id', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const { row } = await loadVisible(c.env, id, user.id, { ownerOnly: true });
    if (row.workflow_id && ['queued', 'transcribing', 'summarizing'].includes(row.status)) {
      try {
        await (await c.env.MINUTES_WORKFLOW.get(row.workflow_id)).terminate();
      } catch {
        // 無視
      }
    }
    await c.env.DB.prepare(
      'UPDATE minutes SET deleted_at = ?, audio_deleted = 1, transcript_key = NULL, transcript_prev_key = NULL, summary_key = NULL, summary_prev_key = NULL, summary_mapping_key = NULL, summary_prev_mapping_key = NULL, summary_with_materials = 0, summary_prev_with_materials = 0, summary_material_ids = "[]", full_audio_key = NULL, updated_at = ? WHERE id = ?',
    )
      .bind(nowIso(), nowIso(), id)
      .run();
    await c.env.DB.prepare('DELETE FROM minute_materials WHERE minute_id = ?').bind(id).run();
    await deleteByPrefix(c.env.AUDIO, `minutes/${id}/`);
    await deleteByPrefix(c.env.DATA, `minutes/${id}/`);
    await audit(c.env, user.id, 'minutes.delete', { minuteId: id });
    return c.body(null, 204);
  });

  // ---- 開発コンソールの「試し」（capabilities.dev の人だけ） ----
  app.post('/api/dev/minutes-test', async (c) => {
    const user = requireDev(c);
    const b = await readBody(c);
    const kind = b.kind;
    if (kind !== 'transcribe' && kind !== 'summarize') throw validationError('kind は transcribe か summarize です', [{ field: 'kind', message: 'transcribe か summarize' }]);
    if (kind === 'transcribe' && typeof b.audioKey !== 'string') throw validationError('audioKey が必要です', [{ field: 'audioKey', message: '必須' }]);
    if (kind === 'summarize' && (typeof b.transcript !== 'string' || !b.transcript.trim())) {
      throw validationError('transcript が必要です', [{ field: 'transcript', message: '必須' }]);
    }
    const use = kind === 'summarize' ? 'summarize' : 'transcribe';
    const modelId = b.modelId || (await getSelectedModel(c.env, use));
    const promptText = typeof b.promptText === 'string' && b.promptText.trim() ? b.promptText : (await getPrompt(c.env, use)).text;
    const jobId = ulid();
    const now = nowIso();
    // 1 日たった試しの結果は、次の試しのついでに消す（Cron を使わない）
    await c.env.DB.prepare("DELETE FROM settings WHERE key LIKE 'test:%' AND updated_at < ?").bind(new Date(Date.now() - TEST_KEEP_MS).toISOString()).run();
    await c.env.DB.prepare('INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)')
      .bind(`test:${jobId}`, JSON.stringify({ status: 'pending', userId: user.id }), user.id, now)
      .run();
    await c.env.MINUTES_WORKFLOW.create({
      id: `test-${jobId}`,
      params: { test: true, jobId, kind, audioKey: b.audioKey ?? null, transcript: b.transcript ?? null, promptText, modelId, userId: user.id },
    });
    return c.json({ jobId }, 202);
  });

  app.get('/api/dev/minutes-test/:jobId', async (c) => {
    const user = requireDev(c);
    const row = await c.env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(`test:${c.req.param('jobId')}`).first();
    let v = null;
    try {
      v = row ? JSON.parse(row.value) : null;
    } catch {
      v = null;
    }
    if (!v || v.userId !== user.id) throw new HttpError(404, 'not_found', '試しの結果が見つかりません（1 日で消えます）');
    const { userId: _omit, ...out } = v;
    return c.json(out);
  });
}

function requireDev(c) {
  const user = c.get('user');
  if (!user?.capabilities?.dev) throw new HttpError(403, 'forbidden', 'この操作をする権限がありません');
  return user;
}

const baseMimeOf = (m) => String(m || 'audio/webm').split(';')[0].trim();

function jstDate(iso) {
  return new Date(new Date(iso).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

async function listShares(env, id) {
  const r = await env.DB.prepare(
    'SELECT s.user_id, s.shared_at, u.display_name FROM minute_shares s JOIN users u ON u.id = s.user_id WHERE s.minute_id = ? ORDER BY s.shared_at',
  )
    .bind(id)
    .all();
  return (r.results ?? []).map((x) => ({ id: x.user_id, name: x.display_name, sharedAt: x.shared_at }));
}

