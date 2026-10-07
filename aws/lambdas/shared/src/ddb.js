// 単一テーブル（TABLE_NAME）への薄い入口。lib-dynamodb の DocumentClient を包み、
// 式の組み立て（プレースホルダー、ページ送り、再試行）をここに閉じ込める。
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, DeleteCommand,
  QueryCommand, BatchGetCommand, TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';

let doc = null;
function client() {
  // undefined を含む項目を書けるようにする（任意の項目を「無い」として扱うため）
  doc ??= DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  return doc;
}

function table() {
  const t = process.env.TABLE_NAME;
  if (!t) throw new Error('TABLE_NAME が未設定です');
  return t;
}

const INDEX_KEYS = { gsi1: ['gsi1pk', 'gsi1sk'], gsi2: ['gsi2pk', 'gsi2sk'] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TRANSACT_RETRIES = 3;
const TRANSACT_BASE_MS = 50;

/**
 * トランザクションが、条件の不一致ではなく「同じ項目への同時のトランザクション」だけで拒否されたか。
 * 理由に ConditionalCheckFailed が 1 つでもあれば false（それは先を越された合図なので、やり直さない）。
 */
export function isTransactionConflict(err) {
  if (err?.name === 'TransactionConflictException') return true;
  if (err?.name !== 'TransactionCanceledException') return false;
  const codes = (err.CancellationReasons ?? []).map((r) => r?.Code ?? 'None');
  return codes.includes('TransactionConflict') && !codes.includes('ConditionalCheckFailed');
}

/** 条件付き書き込みが条件に合わなかった（トランザクション内も含む）か。 */
export function isConditionFailed(err) {
  if (err?.name === 'ConditionalCheckFailedException') return true;
  // やり直しても同時のトランザクションが続いた場合も、利用者には「ほかの人が先に更新した」（409）として返す
  if (isTransactionConflict(err)) return true;
  if (err?.name === 'TransactionCanceledException') {
    return (err.CancellationReasons ?? []).some((r) => r?.Code === 'ConditionalCheckFailed');
  }
  return false;
}

// 条件式。利用側が #v / :v のような名前を自分で付けて names / values に渡す。
function conditionParts(o) {
  const out = {};
  if (o?.condition) out.ConditionExpression = o.condition;
  if (o?.names && Object.keys(o.names).length) out.ExpressionAttributeNames = { ...o.names };
  if (o?.values && Object.keys(o.values).length) out.ExpressionAttributeValues = { ...o.values };
  return out;
}

function buildUpdate(o = {}) {
  const names = { ...(o.names ?? {}) };
  const values = { ...(o.values ?? {}) };
  const sets = [];
  const adds = [];
  const removes = [];
  let i = 0;
  for (const [k, v] of Object.entries(o.set ?? {})) {
    if (v === undefined) continue;
    names[`#s${i}`] = k;
    values[`:s${i}`] = v;
    sets.push(`#s${i} = :s${i}`);
    i++;
  }
  for (const [k, v] of Object.entries(o.add ?? {})) {
    names[`#a${i}`] = k;
    values[`:a${i}`] = v;
    adds.push(`#a${i} :a${i}`);
    i++;
  }
  for (const k of o.remove ?? []) {
    names[`#r${i}`] = k;
    removes.push(`#r${i}`);
    i++;
  }
  const parts = [];
  if (sets.length) parts.push(`SET ${sets.join(', ')}`);
  if (adds.length) parts.push(`ADD ${adds.join(', ')}`);
  if (removes.length) parts.push(`REMOVE ${removes.join(', ')}`);
  if (parts.length === 0) throw new Error('update に更新内容がありません');
  const out = { UpdateExpression: parts.join(' ') };
  if (Object.keys(names).length) out.ExpressionAttributeNames = names;
  if (Object.keys(values).length) out.ExpressionAttributeValues = values;
  if (o.condition) out.ConditionExpression = o.condition;
  return out;
}

export const ddb = {
  async get(pk, sk) {
    const r = await client().send(new GetCommand({ TableName: table(), Key: { pk, sk } }));
    return r.Item ?? null;
  },

  /** item は pk / sk を含む。opts: { condition?, names?, values? } */
  async put(item, opts = {}) {
    await client().send(new PutCommand({ TableName: table(), Item: item, ...conditionParts(opts) }));
  },

  /**
   * o: { set?, add?, remove?: string[], condition?, names?, values? }
   * 更新後の項目を返す。set / add / remove は最上位の属性名だけ。
   */
  async update(pk, sk, o = {}) {
    const r = await client().send(new UpdateCommand({
      TableName: table(), Key: { pk, sk }, ReturnValues: 'ALL_NEW', ...buildUpdate(o),
    }));
    return r.Attributes ?? null;
  },

  async del(pk, sk, opts = {}) {
    await client().send(new DeleteCommand({ TableName: table(), Key: { pk, sk }, ...conditionParts(opts) }));
  },

  /**
   * 1 ページ分。index は 'gsi1' | 'gsi2'。索引を使うときの pk は索引の pk の値。
   * sk の条件は skPrefix / skGte / skGt / skLte / skBetween:[a,b] のどれか 1 つ。
   * 戻り値は { items, lastKey }。
   */
  async query({ pk, skPrefix, skGte, skGt, skLte, skBetween, index, forward = true, limit, startKey, filter, names, values, projection } = {}) {
    const [pkAttr, skAttr] = index ? (INDEX_KEYS[index] ?? []) : ['pk', 'sk'];
    if (!pkAttr) throw new Error('未知の索引です');
    const n = { '#pk': pkAttr, ...(names ?? {}) };
    const v = { ':pk': pk, ...(values ?? {}) };
    let cond = '#pk = :pk';
    if (skPrefix != null) { n['#sk'] = skAttr; cond += ' AND begins_with(#sk, :sk)'; v[':sk'] = skPrefix; }
    else if (skGte != null) { n['#sk'] = skAttr; cond += ' AND #sk >= :sk'; v[':sk'] = skGte; }
    else if (skGt != null) { n['#sk'] = skAttr; cond += ' AND #sk > :sk'; v[':sk'] = skGt; }
    else if (skLte != null) { n['#sk'] = skAttr; cond += ' AND #sk <= :sk'; v[':sk'] = skLte; }
    else if (skBetween) { n['#sk'] = skAttr; cond += ' AND #sk BETWEEN :sk1 AND :sk2'; v[':sk1'] = skBetween[0]; v[':sk2'] = skBetween[1]; }
    const r = await client().send(new QueryCommand({
      TableName: table(),
      IndexName: index,
      KeyConditionExpression: cond,
      ExpressionAttributeNames: n,
      ExpressionAttributeValues: v,
      ScanIndexForward: forward,
      Limit: limit,
      ExclusiveStartKey: startKey,
      FilterExpression: filter,
      ProjectionExpression: projection,
    }));
    return { items: r.Items ?? [], lastKey: r.LastEvaluatedKey };
  },

  /** 最後まで読んで項目の配列を返す。max は暴走防止の上限で、超えたら打ち切る。 */
  async queryAll(q = {}) {
    const { max = 200_000, ...rest } = q;
    const out = [];
    let startKey;
    do {
      const r = await ddb.query({ ...rest, startKey });
      out.push(...r.items);
      startKey = r.lastKey;
    } while (startKey && out.length < max);
    return out;
  },

  /** keys: [{pk, sk}]。100 件ずつ読み、未処理は少し待って読み直す。順序は保証しない。 */
  async batchGet(keys) {
    const seen = new Set();
    const uniq = [];
    for (const k of keys) {
      const id = `${k.pk}\u0000${k.sk}`;
      if (!seen.has(id)) {
        seen.add(id);
        uniq.push({ pk: k.pk, sk: k.sk });
      }
    }
    const out = [];
    for (let i = 0; i < uniq.length; i += 100) {
      let pending = uniq.slice(i, i + 100);
      for (let attempt = 0; pending.length && attempt < 6; attempt++) {
        if (attempt) await sleep(50 * 2 ** attempt);
        const r = await client().send(new BatchGetCommand({ RequestItems: { [table()]: { Keys: pending } } }));
        out.push(...(r.Responses?.[table()] ?? []));
        pending = r.UnprocessedKeys?.[table()]?.Keys ?? [];
      }
      if (pending.length) throw new Error('batchGet: 未処理のキーが残りました');
    }
    return out;
  },

  /**
   * ops の各要素は次のどれか（condition / names / values は任意）。
   *   { put: item }  { update: {pk, sk}, set?, add?, remove? }  { del: {pk, sk} }  { check: {pk, sk}, condition }
   * 25 件まで。
   */
  async transact(ops) {
    const items = ops.map((op) => {
      if (op.put) return { Put: { TableName: table(), Item: op.put, ...conditionParts(op) } };
      if (op.update) return { Update: { TableName: table(), Key: { pk: op.update.pk, sk: op.update.sk }, ...buildUpdate(op) } };
      if (op.del) return { Delete: { TableName: table(), Key: { pk: op.del.pk, sk: op.del.sk }, ...conditionParts(op) } };
      if (op.check) return { ConditionCheck: { TableName: table(), Key: { pk: op.check.pk, sk: op.check.sk }, ...conditionParts(op) } };
      throw new Error('transact: 不明な操作です');
    });
    if (items.length > 25) throw new Error('transact: 操作が多すぎます');
    // 同じ項目に別のトランザクションが同時に走っていると、条件に関係なく TransactionConflict で拒否される。
    // 少し待ってやり直せば条件が改めて判定される（先を越されていれば ConditionalCheckFailed → 409、そうでなければ通る）。
    // ここで吸収しないと、利用者には 500 として見えてしまう
    for (let attempt = 0; ; attempt++) {
      try {
        await client().send(new TransactWriteCommand({ TransactItems: items }));
        return;
      } catch (e) {
        if (!isTransactionConflict(e) || attempt >= TRANSACT_RETRIES) throw e;
        await sleep(TRANSACT_BASE_MS * 2 ** attempt + Math.floor(Math.random() * TRANSACT_BASE_MS));
      }
    }
  },
};
