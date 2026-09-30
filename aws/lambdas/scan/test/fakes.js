// テスト用の差し替え部品。DynamoDB と S3 はメモリ、fetch は台本どおりの応答を返す。
export function fakeDdb(seed = []) {
  const m = new Map();
  const key = (pk, sk) => `${pk}|${sk}`;
  for (const it of seed) m.set(key(it.pk, it.sk), { ...it });
  return {
    m,
    async get(pk, sk) { return m.get(key(pk, sk)); },
    async put(item) { m.set(key(item.pk, item.sk), { ...item }); },
    async update(pk, sk, { set = {}, add = {}, remove = [] } = {}) {
      const it = m.get(key(pk, sk)) ?? { pk, sk };
      Object.assign(it, set);
      for (const [k, v] of Object.entries(add)) it[k] = (it[k] ?? 0) + v;
      for (const k of remove) delete it[k];
      m.set(key(pk, sk), it);
    },
  };
}

export const K = {
  card: (id) => ({ pk: `CARD#${id}`, sk: 'META' }),
  setting: (n) => ({ pk: 'ORG', sk: `SETTING#${n}` }),
  model: (id) => ({ pk: 'ORG', sk: `MODEL#${id}` }),
  prompt: (kind, v) => ({ pk: 'ORG', sk: `PROMPT#${kind}#${v}` }),
};

export function geminiReply(text, finishReason = 'STOP') {
  return {
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text }] }, finishReason }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 },
    }),
  };
}

// replies は呼び出し順の台本。足りなければ最後の応答を繰り返す
export function makeDeps({ replies, ddb }) {
  const t = {
    usage: [],
    sleeps: [],
    calls: 0,
    deps: {
      ddb, K,
      s3: { getObjectBuffer: async () => Buffer.from('jpeg') },
      getApiKey: async () => 'key',
      recordUsage: async (e) => { t.usage.push(e); },
      fetch: async () => replies[Math.min(t.calls++, replies.length - 1)],
      sleep: async (ms) => { t.sleeps.push(ms); },
      now: () => new Date('2026-10-01T00:00:00Z'),
      env: { IMAGE_BUCKET: 'img' },
    },
  };
  return t;
}
