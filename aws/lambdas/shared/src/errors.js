// API のエラー（docs/api-contract.md §1）。message は利用者に見せてよい日本語だけを入れる。
// 名刺の内容や API キーなど、外から来た値・秘密の値は message にも details にも入れない。
export class HttpError extends Error {
  /**
   * @param {number} status HTTP ステータス
   * @param {string} code unauthorized / forbidden / not_found / conflict / validation / rate_limited / provider_error / not_configured
   * @param {string} message
   * @param {Array<{field: string, message: string}>} [details] validation のときの項目ごとの誤り
   */
  constructor(status, code, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (message = '見つかりません') => new HttpError(404, 'not_found', message);
export const forbidden = (message = 'この操作をする権限がありません') => new HttpError(403, 'forbidden', message);
export const conflict = (message) => new HttpError(409, 'conflict', message);
export const validation = (message, details) => new HttpError(400, 'validation', message, details);

/** 契約の形 { status, body } にする。HttpError 以外は内容を出さず 500 にする。 */
export function errorResponse(err) {
  if (err instanceof HttpError) {
    const error = { code: err.code, message: err.message };
    if (err.details) error.details = err.details;
    return { status: err.status, body: { error } };
  }
  return { status: 500, body: { error: { code: 'internal', message: '内部エラーが起きました。しばらくしてからもう一度お試しください' } } };
}
