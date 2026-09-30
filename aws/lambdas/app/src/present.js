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
 * @param {{ detail?: boolean, duplicates?: Array }} [opts] detail なら rawText を含める（一覧には入れない）
 */
export async function presentCard(item, { detail = false, duplicates } = {}) {
  const depts = await departmentMap();
  const deptIds = Array.isArray(item.deptIds) ? item.deptIds : [];
  const out = {
    id: item.id ?? String(item.pk).slice('CARD#'.length),
    status: item.status,
    company: item.company ?? '',
    department: item.department ?? '',
    name: item.name ?? '',
    nameReading: item.nameReading ?? '',
    phones: item.phones ?? [],
    mobiles: item.mobiles ?? [],
    emails: item.emails ?? [],
    note: item.note ?? '',
    deptIds,
    departments: deptIds.filter((id) => depts.has(id)).map((id) => ({ id, name: depts.get(id).name })),
    imageUrls: await imageUrls(item),
    createdBy: { id: item.createdBy ?? null, name: item.createdByName ?? '' },
    createdAt: item.createdAt ?? null,
    updatedBy: item.updatedBy ? { id: item.updatedBy, name: item.updatedByName ?? '' } : null,
    updatedAt: item.updatedAt ?? null,
    editCount: item.editCount ?? 0,
    scanCount: item.scanCount ?? 0,
    version: item.version ?? 1,
    failure: item.failure
      ? { kind: item.failure.kind, message: item.failure.message ?? '', retryable: item.failure.retryable !== false }
      : null,
  };
  if (detail) out.rawText = item.rawText ?? '';
  if (duplicates && item.status === 'review') out.duplicates = duplicates;
  return out;
}
