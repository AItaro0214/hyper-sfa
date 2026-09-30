// Lambda「minutes」の入口。実際の依存をここでだけ束ねる。処理本体は minutes.js。
import { ddb, K, s3, getApiKey, recordUsage } from '@hyper-sfa/aws-shared';
import { runMinutes } from './minutes.js';
import { defaultIo } from './ffmpeg.js';

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
  io: defaultIo,
};

// 例外は runMinutes の中で DynamoDB に失敗として書く。Lambda の自動再試行には頼らない
// （文字起こしを二重に課金しないため）。
export async function handler(event) {
  try {
    return await runMinutes(event ?? {}, deps);
  } catch (e) {
    console.error('minutes: unexpected', e?.name);
    return { ok: false };
  }
}
