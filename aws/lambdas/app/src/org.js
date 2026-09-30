// 部署とユーザーの一覧。名刺や議事録の表示に名前を付けるために読む。
// 変更は console が行うので、ここは 60 秒だけ持つ（役職や所属の変更が 1 分以内に効く決めと合わせる）。
import { ddb } from '@hyper-sfa/aws-shared';

const TTL_MS = 60 * 1000;
let deptCache = null;
let userCache = null;

export async function listDepartments() {
  if (deptCache && Date.now() - deptCache.at < TTL_MS) return deptCache.list;
  const items = await ddb.queryAll({ pk: 'ORG', skPrefix: 'DEPT#' });
  const list = items
    .map((i) => ({ id: String(i.sk).slice('DEPT#'.length), name: i.name ?? '', order: i.order ?? 0, active: i.active !== false }))
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'ja'));
  deptCache = { at: Date.now(), list, byId: new Map(list.map((d) => [d.id, d])) };
  return list;
}

export async function departmentMap() {
  await listDepartments();
  return deptCache.byId;
}

/** 登録済みのユーザー（無効も含む）。 */
export async function listUsers() {
  if (userCache && Date.now() - userCache.at < TTL_MS) return userCache.list;
  const items = await ddb.queryAll({ pk: 'ORG', skPrefix: 'USER#' });
  const list = items.map((i) => ({
    id: String(i.sk).slice('USER#'.length),
    email: String(i.sk).slice('USER#'.length),
    displayName: i.displayName || String(i.sk).slice('USER#'.length),
    position: i.position,
    deptIds: Array.isArray(i.deptIds) ? i.deptIds : [],
    status: i.status,
  }));
  userCache = { at: Date.now(), list, byId: new Map(list.map((u) => [u.id, u])) };
  return list;
}

export async function userMap() {
  await listUsers();
  return userCache.byId;
}

/** [{ id, name }]。存在しない部署 ID は捨てる。 */
export async function deptRefs(ids) {
  const m = await departmentMap();
  return (ids ?? []).filter((id) => m.has(id)).map((id) => ({ id, name: m.get(id).name }));
}
