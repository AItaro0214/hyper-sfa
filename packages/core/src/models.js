// モデルの一覧と概算費用（docs/design.md §5.2、docs/minutes-design.md §7、docs/cost-estimate.md §4.1 §11.3）。
// 一覧は「初期値」で、実際の一覧は各バックエンドの保存先に置き、開発コンソールから追加・変更する。
// 新しいモデルが毎月のように出るので、コードを直して配り直さずに済むようにするため。
// 単価は 100 万トークンあたり USD（perMinute は音声 1 分あたり）。2026-09-30 に公式の料金ページで確認した値。

const ALL_USES = ['card', 'transcribe', 'summarize'];

// 2027-01-01 から単価が 2 倍になる予定の Flash 系
const FLASH_PRICING = {
  input: 0.75,
  output: 3.75,
  changesAt: '2027-01-01',
  next: { input: 1.5, output: 7.5 },
};

// 価格帯のバッジ（安い / 標準 / 高性能 / 最上位）。出力単価（100 万トークンあたり USD）で決める。
// 名前や世代では決めない。新しいモデルが出ても単価さえ分かれば同じ規則で付けられるようにするため。
export const TIER_LIMITS = Object.freeze({ lite: 2.5, standard: 10, high: 30 });

/**
 * 価格帯。出力単価が 2.5 以下 = lite、10 以下 = standard、30 以下 = high、それ以上 = top。
 * 単価が無い（分課金だけなど）モデルは null。
 * @returns {'lite' | 'standard' | 'high' | 'top' | null}
 */
export function tierOf(model) {
  const m = typeof model === 'string' ? DEFAULT_MODELS.find((x) => x.id === model) : model;
  const out = m?.pricing?.output;
  if (typeof out !== 'number') return null;
  if (out <= TIER_LIMITS.lite) return 'lite';
  if (out <= TIER_LIMITS.standard) return 'standard';
  if (out <= TIER_LIMITS.high) return 'high';
  return 'top';
}

const gemini = (id, label, pricing, thinkingLevel, extra = {}) => ({
  id,
  provider: 'gemini',
  label,
  uses: [...ALL_USES],
  pricing,
  thinkingLevel,
  // 1 回に渡せる音声の長さ。10 分の区切りをそのまま渡せる値にしてある
  maxAudioMinutes: 10,
  shutdownAt: null,
  status: 'stable',
  tier: tierOf({ pricing }),
  note: '',
  builtin: true,
  active: true,
  ...extra,
});

const openaiTranscribe = (id, label, pricing) => ({
  id,
  provider: 'openai',
  label,
  uses: ['transcribe'],
  pricing,
  thinkingLevel: null,
  // 公式の上限が確認できていない。10 分の区切りで送れる前提の仮の値なので、実機で確かめる
  maxAudioMinutes: 10,
  shutdownAt: null,
  status: 'stable',
  tier: tierOf({ pricing }),
  note: '',
  builtin: true,
  active: true,
});

// OpenAI の文章モデルは要約だけに使う。名刺の読み取りと文字起こしは行わないため。
// reasoningEffort は要約の呼び出し（reasoningEffort: model.reasoningEffort）がそのまま受ける
const openaiText = (id, label, pricing, note = '') => ({
  id,
  provider: 'openai',
  label,
  uses: ['summarize'],
  pricing,
  thinkingLevel: null,
  reasoningEffort: 'medium',
  maxAudioMinutes: null,
  shutdownAt: null,
  status: 'stable',
  tier: tierOf({ pricing }),
  note,
  builtin: true,
  active: true,
});

export const DEFAULT_MODELS = Object.freeze([
  gemini('gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite', { input: 0.3, output: 2.5 }, 'minimal', {
    note: '初期の標準。名刺・文字起こし向け',
  }),
  // 音声だけ入力単価が高い（$0.50）。思考の設定は未確認。試し読みで確かめる
  gemini('gemini-3.1-flash-lite', 'Gemini 3.1 Flash-Lite', { input: 0.25, output: 1.5, audioInput: 0.5 }, 'minimal', {
    shutdownAt: '2027-05-07',
    note: '2027-05-07 に提供終了',
  }),
  gemini('gemini-3.6-flash', 'Gemini 3.6 Flash', { ...FLASH_PRICING }, 'minimal', {
    note: '2027-01-01 に単価が 2 倍',
  }),
  // 3.7 と 3.8 は minimal が使えない
  gemini('gemini-3.7-flash', 'Gemini 3.7 Flash', { ...FLASH_PRICING }, 'low', {
    note: '2027-01-01 に単価が 2 倍',
  }),
  gemini('gemini-3.8-flash', 'Gemini 3.8 Flash', { ...FLASH_PRICING }, 'low', {
    note: '2027-01-01 に単価が 2 倍',
  }),
  // 思考の設定は未確認。試し読みで確かめる
  gemini('gemini-3.5-flash', 'Gemini 3.5 Flash', { input: 1.5, output: 9.0 }, 'minimal'),
  // Pro は名刺と要約だけ。音声の文字起こしは Flash 系に任せる。200k トークン超は単価が上がる
  gemini(
    'gemini-3.1-pro-preview',
    'Gemini 3.1 Pro（プレビュー）',
    { input: 2.0, output: 12.0, longContext: { threshold: 200000, input: 4.0, output: 18.0 } },
    'low',
    { uses: ['card', 'summarize'], status: 'preview', note: 'プレビュー版。仕様や単価が変わることがある' },
  ),
  gemini(
    'gemini-2.5-pro',
    'Gemini 2.5 Pro',
    { input: 1.25, output: 10.0, longContext: { threshold: 200000, input: 2.5, output: 15.0 } },
    'low',
    { uses: ['card', 'summarize'], note: '安定版の Pro。200k トークン超は単価が上がる' },
  ),
  openaiTranscribe('gpt-transcribe', 'GPT Transcribe', { perMinute: 0.0045 }),
  openaiTranscribe('gpt-4o-transcribe', 'GPT-4o Transcribe', { input: 2.5, output: 10 }),
  openaiTranscribe('gpt-4o-mini-transcribe', 'GPT-4o mini Transcribe', { input: 1.25, output: 5 }),
  openaiTranscribe('whisper-1', 'Whisper', { perMinute: 0.006 }),
  openaiText(
    'gpt-6-astra',
    'GPT-6 Astra',
    { input: 10.0, output: 50.0, longContext: { threshold: 272000, input: 20, output: 75 } },
    '最上位。長い資料の要約向け。費用は Flash-Lite の 20 倍',
  ),
  openaiText(
    'gpt-6.1-sol',
    'GPT-6.1 Sol',
    { input: 2.0, output: 10.0, longContext: { threshold: 272000, input: 4.0, output: 15.0 } },
    '272k トークン超は単価が上がる',
  ),
  openaiText('gpt-6-sol', 'GPT-6 Sol', { input: 2.0, output: 10.0 }),
  openaiText(
    'gpt-6-luna',
    'GPT-6 Luna',
    { input: 0.1, output: 0.5, longContext: { threshold: 272000, input: 0.2, output: 0.75 } },
    '最も安い。272k トークン超は単価が上がる',
  ),
  openaiText('gpt-5.6-sol', 'GPT-5.6 Sol', { input: 4.0, output: 20.0 }),
  openaiText('gpt-5.6-terra', 'GPT-5.6 Terra', { input: 2.0, output: 12.0 }),
  openaiText('gpt-5.6-luna', 'GPT-5.6 Luna', { input: 0.2, output: 1.2 }),
  openaiText('gpt-5.5', 'GPT-5.5', { input: 5.0, output: 30.0 }),
  openaiText('gpt-5.4', 'GPT-5.4', { input: 2.5, output: 15.0 }),
  openaiText('gpt-5.4-mini', 'GPT-5.4 mini', { input: 0.75, output: 4.5 }),
  openaiText('gpt-5.4-nano', 'GPT-5.4 nano', { input: 0.2, output: 1.25 }),
]);

export const DEFAULT_SELECTION = Object.freeze({
  card: 'gemini-3.5-flash-lite',
  transcribe: 'gemini-3.5-flash-lite',
  summarize: 'gemini-3.6-flash',
});

// Gemini は音声を 1 秒 32 トークンで数える（docs/cost-estimate.md §11.1）
const GEMINI_AUDIO_TOKENS_PER_SEC = 32;

function isoDate(date) {
  if (date == null) return new Date().toISOString().slice(0, 10);
  if (date instanceof Date) return date.toISOString().slice(0, 10);
  return String(date).slice(0, 10);
}

function resolveModel(model) {
  if (typeof model === 'string') return DEFAULT_MODELS.find((m) => m.id === model) ?? null;
  return model ?? null;
}

/**
 * その日に適用される単価。changesAt 以降なら next の単価。
 * tokens（入力トークン数）が longContext.threshold を超えるときは長文の単価。
 * 日付は UTC の暦日で比べる（切り替え日の数時間のずれは概算として許容する）。
 * @returns {{ input?: number, output?: number, audioInput?: number, perMinute?: number }}
 */
export function priceAt(model, date, { tokens } = {}) {
  const m = resolveModel(model);
  if (!m?.pricing) return {};
  const { changesAt, next, longContext, ...base } = m.pricing;
  let price = changesAt && next && isoDate(date) >= changesAt ? { ...base, ...next } : { ...base };
  // 入力が閾値を超えたときだけ長文の単価にする。tokens を渡さなければ従来どおり
  if (longContext && typeof tokens === 'number' && tokens > longContext.threshold) {
    const { threshold, ...rest } = longContext;
    price = { ...price, ...rest };
  }
  return price;
}

/**
 * 概算費用（USD）。
 * - inputTokens は音声以外（文章や画像）の入力トークン。Gemini の音声は audioSeconds から
 *   1 秒 32 トークンに換算して足す（audioInput の単価があればそちら）。
 * - perMinute のモデルは、音声の長さを分単位に切り上げて数える。
 * - OpenAI のトークン課金の文字起こしは、音声が何トークンになるか確認できていないので、
 *   audioSeconds からは換算しない。返ってきた usage のトークン数を inputTokens に渡す。
 */
export function estimateCost({ model, inputTokens = 0, outputTokens = 0, audioSeconds = 0, date } = {}) {
  const m = resolveModel(model);
  if (!m) return 0;
  const p = priceAt(m, date, { tokens: inputTokens });
  if (p.perMinute != null) return Math.ceil(Math.max(0, audioSeconds) / 60) * p.perMinute;
  let cost = ((inputTokens || 0) * (p.input ?? 0) + (outputTokens || 0) * (p.output ?? 0)) / 1e6;
  if (m.provider === 'gemini' && audioSeconds > 0) {
    cost += (audioSeconds * GEMINI_AUDIO_TOKENS_PER_SEC * (p.audioInput ?? p.input ?? 0)) / 1e6;
  }
  return cost;
}
