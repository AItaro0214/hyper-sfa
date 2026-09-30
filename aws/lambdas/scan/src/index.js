// Lambda「scan」の入口。実際の依存（DynamoDB、S3、API キー）をここでだけ束ねる。
// 処理本体は scan.js にあり、テストでは依存を差し替えて呼ぶ。
import { ddb, K, s3, getApiKey, recordUsage } from '@hyper-sfa/aws-shared';
import { runScan } from './scan.js';

const deps = {
  ddb,
  K,
  s3,
  getApiKey,
  recordUsage,
  fetch: (...a) => fetch(...a),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => new Date(),
  env: process.env,
};

// 例外は runScan の中で DynamoDB に失敗として書く。Lambda の自動再試行に頼らない（同じ名刺を二重に課金しないため）。
export async function handler(event) {
  try {
    return await runScan(event ?? {}, deps);
  } catch (e) {
    console.error('scan: unexpected', e?.name);
    return { ok: false, failure: { kind: 'provider', message: '読み取りで予期しないエラーが起きました', retryable: true } };
  }
}
