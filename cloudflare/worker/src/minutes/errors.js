// 土台の API エラー型への窓口。
// 依頼では `import { HttpError } from '../lib/http.js'` だったが、土台は現在 lib/errors.js の ApiError
// （status, code, message, extra）を持っている。土台が名前を決めたらここ 1 か所を直す。
import { ApiError } from '../lib/errors.js';

export class HttpError extends ApiError {}

/** 契約 §1 の validation。details は [{ field, message }] */
export function validationError(message, details) {
  return new HttpError(400, 'validation', message, details ? { details } : {});
}
