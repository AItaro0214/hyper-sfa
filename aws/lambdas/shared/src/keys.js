// DynamoDB のキー（docs/design.md §6.1、docs/minutes-design.md §10.1）。
// キーの組み立てをここに集めるのは、Lambda ごとに文字列を手で書くと、一箇所の書き間違いが
// 「保存したのに読めない」不具合になり、見つけにくいため。

export const GSI1_SHARDS = 8;

/** 名刺 ID から検索用の一覧の分割番号を決める。scan Lambda も同じ式を使う（変えると既存の名刺の索引と食い違う）。 */
export function shardOf(id) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % GSI1_SHARDS;
}

const lower = (s) => String(s ?? '').trim().toLowerCase();
// 連番は文字列の並びが数の並びと一致するように 0 埋めする
const padSeq = (n, w) => (typeof n === 'number' ? String(n).padStart(w, '0') : String(n));

export const K = {
  card: (id) => ({ pk: `CARD#${id}`, sk: 'META' }),
  cardHist: (id, at, seq) => ({ pk: `CARD#${id}`, sk: `HIST#${at}#${padSeq(seq, 4)}` }),
  /** 人 → 名刺。人ごとの名刺の一覧を Query 1 回で引く（design §5.5b）。 */
  personCard: (personId, cardId) => ({ pk: `PERSON#${personId}`, sk: `CARD#${cardId}` }),
  user: (email) => ({ pk: 'ORG', sk: `USER#${lower(email)}` }),
  dept: (id) => ({ pk: 'ORG', sk: `DEPT#${id}` }),
  position: (name) => ({ pk: 'ORG', sk: `POSITION#${name}` }),
  model: (id) => ({ pk: 'ORG', sk: `MODEL#${id}` }),
  setting: (name) => ({ pk: 'ORG', sk: `SETTING#${name}` }),
  prompt: (kind, version) => ({ pk: 'ORG', sk: `PROMPT#${kind}#${padSeq(Number(version), 6)}` }),
  usage: (month, sk) => ({ pk: `USAGE#${month}`, sk }),
  audit: (month, at, id) => ({ pk: `AUDIT#${month}`, sk: `${at}#${id}` }),
  minute: (id) => ({ pk: `MIN#${id}`, sk: 'META' }),
  minuteSeg: (id, seq) => ({ pk: `MIN#${id}`, sk: `SEG#${padSeq(Number(seq), 4)}` }),
  minuteMaterial: (id, seq) => ({ pk: `MIN#${id}`, sk: `MAT#${padSeq(Number(seq), 3)}` }),
  /** 議事録への質問のスレッド（利用者ごと）。連番は 4 桁で、質問と答えが 1 件ずつ。 */
  minuteChat: (id, userId, seq) => ({ pk: `MIN#${id}`, sk: `CHAT#${lower(userId)}#${padSeq(Number(seq), 4)}` }),
  minuteShare: (id, email) => ({ pk: `MIN#${id}`, sk: `SHARE#${lower(email)}` }),
  userMinute: (email, heldAt, id) => ({ pk: `USER#${lower(email)}`, sk: `MIN#${heldAt}#${id}` }),
  cardMinute: (cardId, heldAt, id) => ({ pk: `CARD#${cardId}`, sk: `MIN#${heldAt}#${id}` }),
  /** 検索用の一覧の索引キー。名刺の保存のたびに updatedAt と一緒に書き直す。 */
  gsi1: (cardId, updatedAt) => ({ gsi1pk: `IDX#${shardOf(cardId)}`, gsi1sk: `${updatedAt}#${cardId}` }),
  /** 履歴の索引キー。at は ISO 日時。月ごとに新しい順で読む。 */
  gsi2: (month, at, cardId) => ({ gsi2pk: `HIST#${month}`, gsi2sk: `${at}#${cardId}` }),
  // ---- 以下は共通ではなく、この実装で足したもの ----
  /** 1 人 1 日の読み取り回数の数え。ttl で消える。 */
  rate: (day, email) => ({ pk: `RATE#${day}`, sk: `USER#${lower(email)}` }),
};
