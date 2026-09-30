// 設定の読み書きの決まり（scan / minutes が読む形と同じ）。
//   ORG / SETTING#gemini   { models: { card, transcribe, summarize }, promptVersion: { card, transcribe, summarize } }
//   ORG / MODEL#<モデルID> core の DEFAULT_MODELS と同じ形（無い項目は DEFAULT_MODELS で補う）
//   ORG / PROMPT#<用途>#<版6桁> { kind, version, text, savedBy, savedAt }。promptVersion が無い / 0 なら初期値
import { DEFAULT_MODELS, DEFAULT_SELECTION, DEFAULT_PROMPTS } from '@hyper-sfa/core';
import { ddb } from './ddb.js';
import { K } from './keys.js';

const TTL_MS = 30 * 1000;
let cache = { at: 0, value: null };

export function clearSettingsCache() {
  cache = { at: 0, value: null };
}

async function setting() {
  if (cache.value && Date.now() - cache.at < TTL_MS) return cache.value;
  const k = K.setting('gemini');
  const value = (await ddb.get(k.pk, k.sk)) ?? {};
  cache = { at: Date.now(), value };
  return value;
}

/** 用途ごとの選択中のモデル ID。 */
export async function getSelection() {
  const s = await setting();
  return { ...DEFAULT_SELECTION, ...(s.models ?? {}) };
}

/** モデルの設定。DynamoDB に無ければ初期一覧から。どちらにも無ければ null。 */
export async function getModel(id) {
  const k = K.model(id);
  const stored = await ddb.get(k.pk, k.sk);
  const fallback = DEFAULT_MODELS.find((m) => m.id === id);
  if (!stored && !fallback) return null;
  return { ...(fallback ?? {}), ...(stored ?? {}), id };
}

/** 現在のプロンプト。{ text, version, isDefault, savedBy, savedAt } */
export async function getPrompt(kind) {
  const s = await setting();
  const version = Number(s.promptVersion?.[kind] ?? 0);
  if (version > 0) {
    const k = K.prompt(kind, version);
    const p = await ddb.get(k.pk, k.sk);
    if (p?.text) return { text: p.text, version, isDefault: false, savedBy: p.savedBy ?? null, savedAt: p.savedAt ?? null };
  }
  return { text: DEFAULT_PROMPTS[kind], version: 0, isDefault: true, savedBy: null, savedAt: null };
}
