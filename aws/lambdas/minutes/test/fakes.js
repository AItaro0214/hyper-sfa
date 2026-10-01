// テスト用の差し替え部品（メモリの DynamoDB / S3、台本どおりの fetch）
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
    async query({ pk, skPrefix = '' }) {
      return [...m.values()].filter((i) => i.pk === pk && i.sk.startsWith(skPrefix)).sort((a, b) => a.sk.localeCompare(b.sk));
    },
  };
}

export const K = {
  minute: (id) => ({ pk: `MIN#${id}`, sk: 'META' }),
  minuteSeg: (id, seq) => ({ pk: `MIN#${id}`, sk: `SEG#${seq}` }),
  minuteMaterial: (id, seq) => ({ pk: `MIN#${id}`, sk: `MAT#${String(seq).padStart(3, '0')}` }),
  setting: (n) => ({ pk: 'ORG', sk: `SETTING#${n}` }),
  model: (id) => ({ pk: 'ORG', sk: `MODEL#${id}` }),
  prompt: (kind, v) => ({ pk: 'ORG', sk: `PROMPT#${kind}#${v}` }),
  userMinute: (email, heldAt, id) => ({ pk: `USER#${email}`, sk: `MIN#${heldAt}#${id}` }),
  cardMinute: (cardId, heldAt, id) => ({ pk: `CARD#${cardId}`, sk: `MIN#${heldAt}#${id}` }),
};

export const reply = (text, finishReason = 'STOP') => ({
  status: 200,
  json: async () => ({
    candidates: [{ content: { parts: [{ text }] }, finishReason }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 },
  }),
});

// S3 は、置かれた物があればそれを、無ければキー名そのものを音声の中身として返す
export function makeDeps({ ddb, fetchImpl }) {
  const t = {
    usage: [],
    puts: new Map(),
    fetchCalls: 0,
    deps: {
      ddb, K,
      s3: {
        getObjectBuffer: async ({ key }) => t.puts.get(key) ?? Buffer.from(key),
        putObject: async ({ key, body }) => { t.puts.set(key, Buffer.from(body)); },
      },
      getApiKey: async () => 'key',
      recordUsage: async (e) => { t.usage.push(e); },
      fetch: async (url, init) => { t.fetchCalls++; return fetchImpl(url, init); },
      sleep: async () => {},
      now: () => new Date('2026-10-01T00:00:00Z'),
      env: { AUDIO_BUCKET: 'audio', DATA_BUCKET: 'data', FFMPEG_PATH: '/none' },
      io: { exists: async () => false, rm: async () => {} },
    },
  };
  return t;
}
