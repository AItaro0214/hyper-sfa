// 議事録に添付する資料の API（docs/api-contract.md §7「資料」、minutes-design.md §15）。
// 決まり: Worker は資料の中身を読まない。ファイルも、ブラウザが抜いた JSON も、署名付きの PUT で R2 へそのまま流す。
// 目次化と対応付けは Workflow（pipeline.js）の仕事。ここは置き場所と一覧だけ。
import { MATERIAL_LIMITS, ulid } from '@hyper-sfa/core';
import { HttpError, validationError } from './errors.js';
import { loadVisible, materialItem } from './store.js';
import { sign, verify } from './signing.js';

const UPLOAD_URL_TTL_SEC = 15 * 60;
const FILE_URL_TTL_SEC = 60 * 60;
// done が来ないまま 1 時間たったアップロードは、次の追加のときに捨てる
const UPLOADING_STALE_MS = 60 * 60 * 1000;

const MIME = {
  pdf: 'application/pdf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const nowIso = () => new Date().toISOString();
const int = (v, def = 0) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : def);

async function readBody(c) {
  try {
    const b = await c.req.json();
    return b && typeof b === 'object' ? b : {};
  } catch {
    return {};
  }
}

export const materialKeys = (minuteId, matId, kind) => ({
  key: `minutes/${minuteId}/materials/${matId}.${kind}`,
  extractKey: `minutes/${minuteId}/materials/${matId}.extract.json`,
  outlineKey: `minutes/${minuteId}/materials/${matId}.outline.json`,
});

const SELECT_ITEMS =
  "SELECT m.*, u.display_name AS uploader_name FROM minute_materials m LEFT JOIN users u ON u.id = m.uploaded_by WHERE m.minute_id = ? AND m.outline_status != 'uploading'";

export async function listMaterials(env, minuteId) {
  const r = await env.DB.prepare(`${SELECT_ITEMS} ORDER BY m.seq`).bind(minuteId).all();
  return (r.results ?? []).map(materialItem);
}

async function loadMaterial(env, minuteId, matId) {
  const m = await env.DB.prepare('SELECT * FROM minute_materials WHERE id = ? AND minute_id = ?').bind(matId, minuteId).first();
  if (!m) throw new HttpError(404, 'not_found', '資料が見つかりません');
  return m;
}

/** 資料の R2（元のファイル、抜いた JSON、目次）を消す。無い鍵を消してもエラーにならない */
export async function deleteMaterialObjects(env, minuteId, m) {
  const k = materialKeys(minuteId, m.id, m.kind);
  await env.DATA.delete([m.key || k.key, m.extract_key || k.extractKey, m.outline_key || k.outlineKey]);
}

function safeFilename(s) {
  return String(s || '資料').replace(/[\\/:*?"<>|\r\n\t]/g, '').slice(0, 120) || '資料';
}

export function materialsRoutes(app) {
  app.get('/api/minutes/:id/materials', async (c) => {
    const id = c.req.param('id');
    await loadVisible(c.env, id, c.get('user').id);
    return c.json({ items: await listMaterials(c.env, id) });
  });

  app.post('/api/minutes/:id/materials', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    await loadVisible(c.env, id, user.id, { ownerOnly: true });
    const b = await readBody(c);
    const name = typeof b.name === 'string' ? b.name.trim().slice(0, 200) : '';
    if (!name) throw validationError('name が必要です', [{ field: 'name', message: 'ファイル名を指定してください' }]);
    if (!MATERIAL_LIMITS.kinds.includes(b.kind)) {
      throw validationError('対応していない形式です（PDF / pptx / xlsx）。古い形式は保存し直してください', [
        { field: 'kind', message: 'pdf / pptx / xlsx のどれか' },
      ]);
    }
    const size = int(b.size, 0);
    if (size <= 0) throw validationError('size が必要です', [{ field: 'size', message: '1 バイト以上' }]);
    if (size > MATERIAL_LIMITS.maxBytes) {
      throw validationError(`資料が大きすぎます（${MATERIAL_LIMITS.maxBytes / 1024 / 1024}MB まで）`, [{ field: 'size', message: '20MB まで' }]);
    }
    // done が来なかった古いアップロードを片付けてから数える
    const stale =
      (
        await c.env.DB.prepare("SELECT * FROM minute_materials WHERE minute_id = ? AND outline_status = 'uploading' AND uploaded_at < ?")
          .bind(id, new Date(Date.now() - UPLOADING_STALE_MS).toISOString())
          .all()
      ).results ?? [];
    for (const m of stale) {
      await deleteMaterialObjects(c.env, id, m);
      await c.env.DB.prepare('DELETE FROM minute_materials WHERE id = ?').bind(m.id).run();
    }
    const agg = await c.env.DB.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(seq), 0) AS maxSeq FROM minute_materials WHERE minute_id = ?').bind(id).first();
    if ((agg?.n ?? 0) >= MATERIAL_LIMITS.maxFiles) {
      throw validationError(`資料は 1 つの議事録に ${MATERIAL_LIMITS.maxFiles} 件までです`, [{ field: 'name', message: `${MATERIAL_LIMITS.maxFiles} 件まで` }]);
    }
    const matId = ulid();
    const seq = (agg?.maxSeq ?? 0) + 1; // 削除しても番号は詰めない（対応表の「資料 N」が変わらないように）
    const k = materialKeys(id, matId, b.kind);
    const hasExtract = Boolean(b.hasExtract) && b.kind !== 'pdf';
    await c.env.DB.prepare(
      `INSERT INTO minute_materials (id, minute_id, seq, name, kind, size, pages, key, extract_key, outline_key, outline_status, uploaded_by, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, 'uploading', ?, ?)`,
    )
      .bind(matId, id, seq, name, b.kind, size, k.key, hasExtract ? k.extractKey : null, user.id, nowIso())
      .run();
    const base = await sign(c.env, `/api/minutes/${id}/materials/${matId}/upload`, UPLOAD_URL_TTL_SEC);
    return c.json({
      id: matId,
      seq,
      file: { url: `${base}&kind=file`, method: 'PUT', headers: { 'Content-Type': MIME[b.kind] } },
      extract: hasExtract ? { url: `${base}&kind=extract`, method: 'PUT', headers: { 'Content-Type': 'application/json' } } : null,
    });
  });

  // 本文は読まずに R2 へそのまま流す（CPU 10 ミリ秒のため）
  app.put('/api/minutes/:id/materials/:matId/upload', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    if (!(await verify(c.env, c.req.url))) throw new HttpError(403, 'forbidden', 'アップロードの期限が切れました。もう一度試してください');
    await loadVisible(c.env, id, user.id, { ownerOnly: true });
    const m = await loadMaterial(c.env, id, c.req.param('matId'));
    const which = c.req.query('kind');
    if (which !== 'file' && which !== 'extract') throw validationError('kind は file か extract です');
    if (which === 'extract' && !m.extract_key) throw validationError('この資料は抜いた JSON を受け付けていません');
    const len = int(c.req.header('content-length'), 0);
    if (len <= 0) throw validationError('Content-Length が必要です');
    const max = which === 'file' ? MATERIAL_LIMITS.maxBytes : MATERIAL_LIMITS.maxExtractBytes;
    if (len > max) throw validationError(`大きすぎます（${max / 1024 / 1024}MB まで）`);
    await c.env.DATA.put(which === 'file' ? m.key : m.extract_key, c.req.raw.body, {
      httpMetadata: { contentType: which === 'file' ? MIME[m.kind] : 'application/json' },
    });
    return c.json({ ok: true });
  });

  app.put('/api/minutes/:id/materials/:matId/done', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    await loadVisible(c.env, id, user.id, { ownerOnly: true });
    const m = await loadMaterial(c.env, id, c.req.param('matId'));
    const b = await readBody(c);
    const head = await c.env.DATA.head(m.key);
    if (!head) throw new HttpError(409, 'conflict', '資料がまだ届いていません');
    if (m.extract_key && b.extracted !== false && !(await c.env.DATA.head(m.extract_key))) {
      throw new HttpError(409, 'conflict', '抜いた内容がまだ届いていません');
    }
    const pages = Number.isFinite(Number(b.pages)) && Number(b.pages) > 0 ? Math.trunc(Number(b.pages)) : null;
    // PDF だけモデルで目次を作る。pptx / xlsx は抜いた JSON から機械的に作るので none のまま
    const status = m.kind === 'pdf' ? 'pending' : 'none';
    await c.env.DB.prepare('UPDATE minute_materials SET size = ?, pages = ?, outline_status = ?, outline_key = NULL WHERE id = ?')
      .bind(head.size, pages, status, m.id)
      .run();
    await c.env.DB.prepare('UPDATE minutes SET updated_at = ? WHERE id = ?').bind(nowIso(), id).run();
    const row = await c.env.DB.prepare(`${SELECT_ITEMS} AND m.id = ?`).bind(id, m.id).first();
    return c.json(materialItem(row));
  });

  app.delete('/api/minutes/:id/materials/:matId', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    await loadVisible(c.env, id, user.id, { ownerOnly: true });
    const m = await loadMaterial(c.env, id, c.req.param('matId'));
    await deleteMaterialObjects(c.env, id, m);
    await c.env.DB.prepare('DELETE FROM minute_materials WHERE id = ?').bind(m.id).run();
    await c.env.DB.prepare('UPDATE minutes SET updated_at = ? WHERE id = ?').bind(nowIso(), id).run();
    return c.body(null, 204);
  });

  app.get('/api/minutes/:id/materials/:matId/url', async (c) => {
    const id = c.req.param('id');
    await loadVisible(c.env, id, c.get('user').id);
    const m = await loadMaterial(c.env, id, c.req.param('matId'));
    if (m.outline_status === 'uploading') throw new HttpError(404, 'not_found', '資料が見つかりません');
    const url = await sign(c.env, `/api/minutes/${id}/materials/${m.id}/file`, FILE_URL_TTL_SEC);
    return c.json({ url, expiresAt: new Date(Date.now() + FILE_URL_TTL_SEC * 1000).toISOString(), filename: safeFilename(m.name) });
  });

  // 署名とセッションの両方を確かめてから、R2 の本文をそのまま返す
  app.get('/api/minutes/:id/materials/:matId/file', async (c) => {
    if (!(await verify(c.env, c.req.url))) throw new HttpError(403, 'forbidden', 'URL の期限が切れました。もう一度開いてください');
    const id = c.req.param('id');
    await loadVisible(c.env, id, c.get('user').id);
    const m = await loadMaterial(c.env, id, c.req.param('matId'));
    const obj = await c.env.DATA.get(m.key);
    if (!obj) throw new HttpError(404, 'not_found', '資料が見つかりません');
    const headers = new Headers({
      'Content-Type': MIME[m.kind] ?? 'application/octet-stream',
      'Content-Length': String(obj.size),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    const disp = c.req.query('download') === '1' ? 'attachment' : 'inline';
    headers.set('Content-Disposition', `${disp}; filename*=UTF-8''${encodeURIComponent(safeFilename(m.name))}`);
    return new Response(obj.body, { status: 200, headers });
  });
}
