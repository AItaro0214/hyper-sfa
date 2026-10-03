// DynamoDB の名刺を API の形（docs/api-contract.md §4）にする。
import { s3 } from '@hyper-sfa/aws-shared';
import { departmentMap } from './org.js';

const IMAGE_EXPIRES_SEC = 900;

async function imageUrls(item) {
  const sign = (key) => (key ? s3.presignGet({ bucket: 'image', key, expiresSec: IMAGE_EXPIRES_SEC }) : Promise.resolve(null));
  const [thumb, front, back] = await Promise.all([sign(item.thumbKey), sign(item.imageFrontKey), sign(item.imageBackKey)]);
  return { thumb, front, back };
}

/**
 * @param {object} item DynamoDB の名刺（一覧用に削った写しでもよい）
 * @param {{ detail?: boolean, matches?: Array, person?: { cards: Array } }} [opts] detail なら rawText を含める（一覧には入れない）。
 *   person は詳細だけ（人の名刺の一覧。呼び出し側が Query で作る）
 */
export async function presentCard(item, { detail = false, matches, person } = {}) {
  const depts = await departmentMap();
  const deptIds = Array.isArray(item.deptIds) ? item.deptIds : [];
  const out = {
    id: item.id ?? String(item.pk).slice('CARD#'.length),
    // 過去の名刺（superseded）も、画面には確認済みとして見せる。過去かどうかは isCurrent で分かる
    status: item.status === 'superseded' ? 'confirmed' : item.status,
    company: item.company ?? '',
    department: item.department ?? '',
    title: item.title ?? '',
    name: item.name ?? '',
    nameReading: item.nameReading ?? '',
    phones: item.phones ?? [],
    mobiles: item.mobiles ?? [],
    emails: item.emails ?? [],
    note: item.note ?? '',
    deptIds,
    departments: deptIds.filter((id) => depts.has(id)).map((id) => ({ id, name: depts.get(id).name })),
    imageUrls: await imageUrls(item),
    imageOptimized: item.imageOptimized === true,
    createdBy: { id: item.createdBy ?? null, name: item.createdByName ?? '' },
    createdAt: item.createdAt ?? null,
    updatedBy: item.updatedBy ? { id: item.updatedBy, name: item.updatedByName ?? '' } : null,
    updatedAt: item.updatedAt ?? null,
    editCount: item.editCount ?? 0,
    scanCount: item.scanCount ?? 0,
    version: item.version ?? 1,
    // 人の単位（design §5.5b）。personId が無い古い名刺は「名刺 ID = 人 ID」。移行の書き込みはしない
    personId: item.personId ?? item.id ?? String(item.pk).slice('CARD#'.length),
    isCurrent: item.isCurrent !== false,
    supersedes: item.supersedes ?? null,
    failure: item.failure
      ? { kind: item.failure.kind, message: item.failure.message ?? '', retryable: item.failure.retryable !== false }
      : null,
  };
  if (detail) out.rawText = item.rawText ?? '';
  if (matches && item.status === 'review') out.matches = matches;
  if (detail && person) out.person = person;
  return out;
}
