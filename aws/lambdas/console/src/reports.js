// 開発コンソールの利用状況、監査ログ、CSV 出力（docs/api-contract.md §6、docs/design.md §10、docs/minutes-design.md §7.2）。
import {
  buildCsv, cardToCsvRow, historyToCsvRows, minutesUsageToCsvRow, parseQuery, matchCard, searchKeys,
  CARD_CSV_COLUMNS, HISTORY_CSV_COLUMNS, MINUTES_USAGE_CSV_COLUMNS,
} from '@hyper-sfa/core';
import {
  ddb, K, s3, audit, GSI1_SHARDS, notFound, validation, readJson, parseLimit, encodeCursor, decodeCursor,
} from '@hyper-sfa/aws-shared';
import { me, listUserItems, emailOf, listDeptItems, monthRange, presentHist, pageMonths } from './common.js';

const EXPORT_EXPIRES_SEC = 300;
const num = (v) => Number(v) || 0;

// ---- 利用状況 ----

const SUM_FIELDS = ['count', 'failed', 'inputTokens', 'outputTokens', 'cost'];
const pickSums = (i) => Object.fromEntries(SUM_FIELDS.map((f) => [f, num(i[f])]));
const addSums = (into, i) => {
  for (const f of SUM_FIELDS) into[f] = num(into[f]) + num(i[f]);
};

async function usageByMonth(month) {
  const items = await ddb.queryAll({ pk: `USAGE#${month}`, skPrefix: 'USE#' });
  const byUse = {};
  const byModel = [];
  for (const i of items) {
    const kind = i.kind ?? String(i.sk).split('#')[1];
    byUse[kind] ??= { count: 0, failed: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
    addSums(byUse[kind], i);
    byModel.push({ modelId: i.modelId ?? String(i.sk).split('#').slice(2).join('#'), kind, ...pickSums(i) });
  }
  return { month, byUse, byModel };
}

const MINUTES_SUMS = ['recordings', 'recordedSec', 'transcribeFirst', 'transcribeRetry', 'summarizeFirst', 'summarizeRetry', 'failed', 'transcribedSec', 'qa', 'inputTokens', 'outputTokens', 'cost'];
const emptyMinutes = () => Object.fromEntries(MINUTES_SUMS.map((f) => [f, 0]));

async function minutesUsage({ from, to, dept, includeUnused }) {
  const months = monthRange(from, to, 1);
  const [users, depts] = await Promise.all([listUserItems(), listDeptItems()]);
  const deptMap = new Map(depts.map((d) => [d.id, d.name]));
  const userMap = new Map(users.map((u) => [emailOf(u), u]));
  const agg = new Map();
  for (const m of months) {
    const items = await ddb.queryAll({ pk: `USAGE#${m}`, skPrefix: 'MINUTES#USER#' });
    for (const i of items) {
      const email = String(i.sk).slice('MINUTES#USER#'.length);
      const a = agg.get(email) ?? { ...emptyMinutes(), lastUsedAt: null };
      for (const f of MINUTES_SUMS) a[f] += num(i[f]);
      if (i.lastUsedAt && (!a.lastUsedAt || i.lastUsedAt > a.lastUsedAt)) a.lastUsedAt = i.lastUsedAt;
      agg.set(email, a);
    }
  }
  if (includeUnused) {
    for (const [email, u] of userMap) if (u.status === 'active' && !agg.has(email)) agg.set(email, { ...emptyMinutes(), lastUsedAt: null });
  }
  const items = [];
  const total = { users: 0, ...emptyMinutes() };
  for (const [email, a] of agg) {
    const u = userMap.get(email);
    const deptIds = u?.deptIds ?? [];
    if (dept && !deptIds.includes(dept)) continue;
    items.push({
      // タイトルや本文は含めない。誰がどれだけ使ったかだけ（§7.2）
      user: {
        id: email,
        name: u?.displayName || email,
        departments: deptIds.filter((d) => deptMap.has(d)).map((d) => ({ id: d, name: deptMap.get(d) })),
        status: u?.status === 'disabled' ? 'disabled' : 'active',
      },
      recordings: a.recordings,
      recordedSec: a.recordedSec,
      transcribe: { first: a.transcribeFirst, retry: a.transcribeRetry },
      summarize: { first: a.summarizeFirst, retry: a.summarizeRetry },
      qa: { count: a.qa },
      failed: a.failed,
      transcribedSec: a.transcribedSec,
      inputTokens: a.inputTokens,
      outputTokens: a.outputTokens,
      cost: a.cost,
      lastUsedAt: a.lastUsedAt,
    });
    total.users += 1;
    for (const f of MINUTES_SUMS) total[f] += a[f];
  }
  items.sort((x, y) => y.recordedSec - x.recordedSec);
  return { items, total };
}

// ---- CSV の材料 ----

function parseFilterDate(s, end) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s ?? ''))) return null;
  const d = new Date(`${s}T00:00:00+09:00`);
  if (end) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

async function loadAllHistory(months, keep = () => true) {
  const out = [];
  for (const m of months) out.push(...(await ddb.queryAll({ pk: `HIST#${m}`, index: 'gsi2' })).filter(keep));
  return out;
}

async function cardsCsv(filters) {
  const depts = await listDeptItems();
  const deptMap = new Map(depts.map((d) => [d.id, d.name]));
  // 検索と同じ条件で絞る（gsi1 の全件を読む。10 万件でも 1〜2 秒。docs/design.md §7）
  const lists = await Promise.all(Array.from({ length: GSI1_SHARDS }, (_, n) => ddb.queryAll({ pk: `IDX#${n}`, index: 'gsi1' })));
  const q = parseQuery(filters);
  const lo = parseFilterDate(filters.from, false);
  const hi = parseFilterDate(filters.to, true);
  const cards = lists.flat().filter((i) => {
    if (i.deletedAt) return false;
    if (filters.status ? i.status !== filters.status : !(i.status === 'review' || i.status === 'confirmed')) return false;
    if (filters.owner && String(i.createdBy).toLowerCase() !== String(filters.owner).toLowerCase()) return false;
    if (filters.dept && !(i.deptIds ?? []).includes(filters.dept)) return false;
    if (lo && String(i.createdAt) < lo) return false;
    if (hi && String(i.createdAt) >= hi) return false;
    return matchCard(i.keys ?? searchKeys(i), q);
  });

  // 編集履歴の列。名刺ごとの履歴を古い順に 1 つのセルにまとめる
  const oldest = cards.reduce((m, c) => (c.createdAt && c.createdAt < m ? c.createdAt : m), new Date().toISOString());
  const months = monthRange(oldest.slice(0, 7), null, 1).slice(0, 60);
  const edits = new Map();
  for (const h of await loadAllHistory(months, (x) => x.type === 'edit')) {
    const id = String(h.pk).slice('CARD#'.length);
    const list = edits.get(id) ?? [];
    list.push({ at: h.at, actor: { name: h.actorName }, changes: h.changes ?? [] });
    edits.set(id, list);
  }
  const rows = cards
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    .map((i) => {
      const id = i.id ?? String(i.pk).slice('CARD#'.length);
      const ids = i.deptIds ?? [];
      return cardToCsvRow({
        ...i,
        id,
        departments: ids.filter((d) => deptMap.has(d)).map((d) => ({ id: d, name: deptMap.get(d) })),
        createdBy: { name: i.createdByName },
        updatedBy: { name: i.updatedByName },
        scanModel: i.extraction?.modelId,
      }, {
        createdByDepts: (i.createdByDeptIds ?? []).map((d) => deptMap.get(d)).filter(Boolean).join(';'),
        createdByPosition: i.createdByPosition,
        editEvents: (edits.get(id) ?? []).sort((a, b) => a.at.localeCompare(b.at)),
      });
    });
  return { csv: buildCsv(rows, CARD_CSV_COLUMNS), rows: rows.length };
}

async function historyCsv(filters) {
  const months = monthRange(filters.from, filters.to, 12);
  const lo = parseFilterDate(filters.from, false);
  const hi = parseFilterDate(filters.to, true);
  const actor = filters.actor ? String(filters.actor).toLowerCase() : null;
  const items = await loadAllHistory(months, (h) =>
    (!filters.type || h.type === filters.type) && (!actor || h.actorUserId === actor) && (!lo || h.at >= lo) && (!hi || h.at < hi));
  items.sort((a, b) => a.at.localeCompare(b.at));
  const rows = items.flatMap((h) => historyToCsvRows(presentHist(h)));
  return { csv: buildCsv(rows, HISTORY_CSV_COLUMNS), rows: rows.length };
}

async function minutesUsageCsv(filters) {
  const { items } = await minutesUsage({ from: filters.from, to: filters.to, dept: filters.dept, includeUnused: filters.includeUnused === true });
  return { csv: buildCsv(items.map(minutesUsageToCsvRow), MINUTES_USAGE_CSV_COLUMNS), rows: items.length };
}

export function registerReportRoutes(app) {
  app.get('/api/dev/usage', async (c) => {
    const q = c.req.query();
    const months = monthRange(q.from, q.to, 3);
    return c.json({ months: await Promise.all(months.map(usageByMonth)) });
  });

  app.get('/api/dev/usage/minutes', async (c) => {
    const q = c.req.query();
    return c.json(await minutesUsage({ from: q.from, to: q.to, dept: q.dept, includeUnused: q.includeUnused === 'true' || q.includeUnused === '1' }));
  });

  app.get('/api/dev/usage/minutes/:userId', async (c) => {
    const email = decodeURIComponent(c.req.param('userId')).trim().toLowerCase();
    const uk = K.user(email);
    const [user, monthsList] = await Promise.all([ddb.get(uk.pk, uk.sk), Promise.resolve(monthRange(null, null, 12))]);
    if (!user) throw notFound('ユーザーが見つかりません');
    const months = (await Promise.all(monthsList.map(async (m) => {
      const k = K.usage(m, `MINUTES#USER#${email}`);
      const i = await ddb.get(k.pk, k.sk);
      return i ? { month: m, ...Object.fromEntries(MINUTES_SUMS.map((f) => [f, num(i[f])])), lastUsedAt: i.lastUsedAt ?? null } : null;
    }))).filter(Boolean);
    // 1 回ごとの記録。新しい順に 200 件
    const log = await ddb.query({ pk: `MINUSER#${email}`, index: 'gsi2', forward: false, limit: 200 });
    const events = log.items.map((e) => ({
      at: e.at, kind: e.kind, retry: Boolean(e.retry), durationSec: num(e.durationSec), modelId: e.modelId ?? null,
      ok: e.ok !== false, failureKind: e.failureKind ?? null, inputTokens: num(e.inputTokens), outputTokens: num(e.outputTokens), cost: num(e.cost),
    }));
    return c.json({ months, events });
  });

  app.get('/api/dev/audit', async (c) => {
    const q = c.req.query();
    const limit = parseLimit(q.limit);
    const lo = parseFilterDate(q.from, false);
    const hi = parseFilterDate(q.to, true);
    const r = await pageMonths({
      months: monthRange(q.from, q.to),
      cursor: decodeCursor(q.cursor),
      limit,
      page: (month, startKey) => ddb.query({ pk: `AUDIT#${month}`, forward: false, limit: 100, startKey }),
      keep: (a) => (!lo || a.at >= lo) && (!hi || a.at < hi),
      map: (a) => ({ at: a.at, actor: a.actor ?? { id: '', name: '' }, action: a.action, detail: a.detail ?? {} }),
      keyOf: (a) => ({ pk: a.pk, sk: a.sk }),
    });
    return c.json({ items: r.items, nextCursor: r.cursor ? encodeCursor(r.cursor) : null });
  });

  // CSV は Lambda の応答（6MB 上限）に載せず、S3 に置いて 5 分だけ有効な URL で渡す（docs/design.md §10.3）
  app.post('/api/dev/export', async (c) => {
    const actor = me(c);
    const b = await readJson(c);
    const kinds = { cards: cardsCsv, history: historyCsv, 'minutes-usage': minutesUsageCsv };
    if (!kinds[b.kind]) throw validation('kind が正しくありません', [{ field: 'kind', message: Object.keys(kinds).join(' / ') }]);
    const filters = b.filters && typeof b.filters === 'object' && !Array.isArray(b.filters) ? b.filters : {};
    const { csv, rows } = await kinds[b.kind](filters);
    const at = new Date();
    const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const key = `exports/${stamp}-${b.kind}-${Math.random().toString(36).slice(2, 8)}.csv`;
    await s3.putObject({ bucket: 'export', key, body: csv, contentType: 'text/csv; charset=utf-8' });
    const url = await s3.presignGet({ bucket: 'export', key, expiresSec: EXPORT_EXPIRES_SEC, filename: `${b.kind}-${stamp}.csv` });
    await audit(actor, 'export', { kind: b.kind, rows });
    return c.json({ url, expiresAt: new Date(at.getTime() + EXPORT_EXPIRES_SEC * 1000).toISOString(), rows });
  });
}

