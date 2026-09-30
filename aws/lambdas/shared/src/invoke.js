// 別の Lambda を呼ぶ。関数名は環境変数に入れておく（Terraform で循環せずに渡すため、名前は環境変数の名前で受ける）。
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

let lc = null;
const client = () => (lc ??= new LambdaClient({}));

function functionName(envName) {
  const name = process.env[envName];
  if (!name) throw new Error(`${envName} が未設定です`);
  return name;
}

/** 非同期（Event）。呼び出しの受け付けだけを待つ。処理の結果は DynamoDB に書かれる。 */
export async function invokeAsync(functionNameEnv, payload) {
  const r = await client().send(new InvokeCommand({
    FunctionName: functionName(functionNameEnv),
    InvocationType: 'Event',
    Payload: Buffer.from(JSON.stringify(payload)),
  }));
  if (r.StatusCode !== 202) throw new Error('Lambda の非同期呼び出しに失敗しました');
}

/**
 * 同期（RequestResponse）。timeoutMs を超えたら待つのをやめて例外（name: 'TimeoutError'）にする。
 * 相手の Lambda は止まらずに最後まで動く。開発コンソールの試し読み用。
 */
export async function invokeSync(functionNameEnv, payload, { timeoutMs = 29_000 } = {}) {
  const r = await client().send(
    new InvokeCommand({
      FunctionName: functionName(functionNameEnv),
      InvocationType: 'RequestResponse',
      Payload: Buffer.from(JSON.stringify(payload)),
    }),
    { abortSignal: AbortSignal.timeout(timeoutMs) },
  );
  if (r.FunctionError) throw new Error('Lambda が異常終了しました');
  const text = r.Payload ? Buffer.from(r.Payload).toString('utf8') : '';
  return text ? JSON.parse(text) : null;
}
