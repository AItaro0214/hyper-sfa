// API キー（Gemini / OpenAI）。Secrets Manager の 1 つのシークレットに JSON { gemini, openai } で持つ。
// シークレットの数で課金が決まるため増やさない（docs/design.md §2）。
// 読み取りは scan / minutes / console、書き込みは console だけが IAM で許されている。
import { SecretsManagerClient, GetSecretValueCommand, PutSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { ddb } from './ddb.js';
import { K } from './keys.js';

const TTL_MS = 5 * 60 * 1000;
const PROVIDERS = new Set(['gemini', 'openai']);

let sm = null;
let cache = null; // { at, value: { gemini, openai } }
const client = () => (sm ??= new SecretsManagerClient({}));

function secretId() {
  const id = process.env.API_KEYS_SECRET_ARN;
  if (!id) throw new Error('API_KEYS_SECRET_ARN が未設定です');
  return id;
}

async function readAll({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const r = await client().send(new GetSecretValueCommand({ SecretId: secretId() }));
  let value = {};
  try {
    value = JSON.parse(r.SecretString ?? '{}');
  } catch {
    value = {};
  }
  cache = { at: Date.now(), value };
  return value;
}

/** 未登録なら空文字。キーの値はログにも応答にも出さない。 */
export async function getApiKey(provider) {
  if (!PROVIDERS.has(provider)) throw new Error('未対応の provider です');
  const v = await readAll();
  return typeof v[provider] === 'string' ? v[provider] : '';
}

/**
 * キーを書き込む（console だけが権限を持つ）。もう一方のキーを消さないよう、最新を読んでから混ぜる。
 * 画面に出す「末尾 4 文字」「更新日時」は DynamoDB に置く（シークレットを読まずに設定画面を出すため）。
 */
export async function putApiKey(provider, key, actor) {
  if (!PROVIDERS.has(provider)) throw new Error('未対応の provider です');
  const current = await readAll({ fresh: true });
  const next = { gemini: '', openai: '', ...current, [provider]: key };
  await client().send(new PutSecretValueCommand({ SecretId: secretId(), SecretString: JSON.stringify(next) }));
  cache = { at: Date.now(), value: next };
  const at = new Date().toISOString();
  await ddb.put({
    ...K.setting(`key#${provider}`),
    last4: key.slice(-4),
    updatedAt: at,
    updatedBy: typeof actor === 'string' ? actor : (actor?.id ?? actor?.email ?? ''),
    updatedByName: typeof actor === 'string' ? '' : (actor?.name ?? ''),
  });
}

/** 設定画面用。{ configured, last4, updatedAt, updatedBy } */
export async function getKeyMeta(provider) {
  const item = await ddb.get(K.setting(`key#${provider}`).pk, K.setting(`key#${provider}`).sk);
  if (!item) return { configured: false, last4: null, updatedAt: null, updatedBy: null };
  return { configured: true, last4: item.last4 ?? null, updatedAt: item.updatedAt ?? null, updatedBy: item.updatedByName || item.updatedBy || null };
}
