// Lambda「auth」の入口。Cognito が呼ぶ。処理本体は handler.js。
import { ddb } from '@hyper-sfa/aws-shared';
import { createHandler } from './handler.js';

export const handler = createHandler({ ddb });
