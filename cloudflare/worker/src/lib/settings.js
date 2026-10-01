// 設定（API キー、モデル、プロンプト）の読み書き。D1 の settings / models / prompts 表。
// API キーは AES-GCM で暗号化して settings に置き、鍵は Secret（KEY_ENCRYPTION_KEY）。復号はこのファイルの中だけ。
import { DEFAULT_MODELS, DEFAULT_PROMPTS, DEFAULT_SELECTION } from '../core.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import { safeJson, nowIso } from './time.js';

export const PROVIDERS = ['gemini', 'openai'];
export const USES = ['card', 'transcribe', 'summarize'];
// プロンプトだけが持つ種類（モデルの用途ではない。資料の目次化と、資料を踏まえた議事録は「議事録」用のモデルを使う）
export const PROMPT_KINDS = [...USES, 'outline', 'summarize_materials'];

const keyName = (provider) => `apikey:${provider}`;

export async function saveApiKey(env, provider, plainKey, userId) {
  const sealed = await encryptSecret(plainKey, env.KEY_ENCRYPTION_KEY, keyName(provider));
  const value = JSON.stringify({ ...sealed, last4: plainKey.slice(-4) });
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  )
    .bind(keyName(provider), value, userId, nowIso())
    .run();
}

// 登録が無ければ null。呼び出し側は not_configured にする
export async function getApiKey(env, provider) {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(keyName(provider)).first();
  if (!row) return null;
  const v = safeJson(row.value, null);
  if (!v?.ct) return null;
  try {
    return await decryptSecret(v, env.KEY_ENCRYPTION_KEY, keyName(provider));
  } catch {
    // Secret を変えた等で復号できない。未設定と同じ扱いにして、設定画面から入れ直してもらう
    return null;
  }
}

export async function keyStatus(env, provider) {
  const row = await env.DB.prepare(
    `SELECT s.value, s.updated_at, u.display_name, u.login_id FROM settings s
     LEFT JOIN users u ON u.id = s.updated_by WHERE s.key = ?`,
  )
    .bind(keyName(provider))
    .first();
  const v = row ? safeJson(row.value, null) : null;
  if (!v?.ct) return { configured: false, last4: null, updatedAt: null, updatedBy: null };
  return { configured: true, last4: v.last4 ?? null, updatedAt: row.updated_at, updatedBy: row.display_name || row.login_id || null };
}

// ---- モデル ----

export function rowToModel(r) {
  return {
    id: r.id,
    provider: r.provider,
    label: r.label,
    uses: safeJson(r.uses, []),
    pricing: safeJson(r.pricing, {}),
    thinkingLevel: r.thinking_level ?? null,
    maxAudioMinutes: r.max_audio_minutes ?? null,
    shutdownAt: r.shutdown_at ?? null,
    active: Boolean(r.active),
    builtin: Boolean(r.builtin),
  };
}

// models 表が空なら初期一覧を入れる（設計書: 一覧はコードに固定せず設定として持つ）
export async function ensureModels(env) {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM models').first();
  if (row.n > 0) return;
  const stmt = env.DB.prepare(
    `INSERT OR IGNORE INTO models (id, provider, label, uses, pricing, thinking_level, max_audio_minutes, shutdown_at, active, builtin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`,
  );
  await env.DB.batch(
    DEFAULT_MODELS.map((m) =>
      stmt.bind(
        m.id,
        m.provider,
        m.label,
        JSON.stringify(m.uses ?? []),
        JSON.stringify(m.pricing ?? {}),
        m.thinkingLevel ?? null,
        m.maxAudioMinutes ?? null,
        m.shutdownAt ?? null,
      ),
    ),
  );
}

export async function listModels(env) {
  await ensureModels(env);
  const { results } = await env.DB.prepare('SELECT * FROM models ORDER BY builtin DESC, id').all();
  return results.map(rowToModel);
}

export async function getModel(env, id) {
  await ensureModels(env);
  const r = await env.DB.prepare('SELECT * FROM models WHERE id = ?').bind(id).first();
  return r ? rowToModel(r) : null;
}

export async function selectedModelId(env, use) {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(`model:${use}`).first();
  return row?.value || DEFAULT_SELECTION[use];
}

export async function selection(env) {
  const { results } = await env.DB.prepare("SELECT key, value FROM settings WHERE key LIKE 'model:%'").all();
  const out = { ...DEFAULT_SELECTION };
  for (const r of results) out[r.key.slice(6)] = r.value;
  return out;
}

// ---- プロンプト ----

// text が '' の版は「初期値に戻した」印。実際の文面は DEFAULT_PROMPTS を使う
export async function currentPrompt(env, kind) {
  const r = await env.DB.prepare(
    `SELECT p.version, p.text, p.saved_at, u.display_name, u.login_id FROM prompts p
     LEFT JOIN users u ON u.id = p.saved_by WHERE p.kind = ? ORDER BY p.version DESC LIMIT 1`,
  )
    .bind(kind)
    .first();
  if (!r) return { kind, text: DEFAULT_PROMPTS[kind], version: 0, savedBy: null, savedAt: null, isDefault: true };
  const isDefault = r.text === '';
  return {
    kind,
    text: isDefault ? DEFAULT_PROMPTS[kind] : r.text,
    version: r.version,
    savedBy: r.display_name || r.login_id || null,
    savedAt: r.saved_at,
    isDefault,
  };
}

export async function savePrompt(env, kind, text, userId) {
  const max = await env.DB.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM prompts WHERE kind = ?').bind(kind).first();
  await env.DB.prepare('INSERT INTO prompts (kind, version, text, saved_by, saved_at) VALUES (?, ?, ?, ?, ?)')
    .bind(kind, max.v + 1, text, userId, nowIso())
    .run();
}

// 議事録側が使う名前
export const getSelectedModel = selectedModelId;
export const getPrompt = currentPrompt;
