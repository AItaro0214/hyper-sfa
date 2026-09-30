// API のエラー（docs/api-contract.md §1）。code と HTTP ステータスの対応をここに固める。
export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const unauthorized = (message = 'ログインしてください') => new ApiError(401, 'unauthorized', message);
export const forbidden = (message = 'この操作をする権限がありません') => new ApiError(403, 'forbidden', message);
export const notFound = (message = '見つかりません') => new ApiError(404, 'not_found', message);
export const conflict = (message, extra) => new ApiError(409, 'conflict', message, extra);
export const rateLimited = (message) => new ApiError(429, 'rate_limited', message);
export const providerError = (message = 'AI サービスでエラーが起きました') => new ApiError(502, 'provider_error', message);
export const notConfigured = (message = 'API キーまたはモデルが未設定です') => new ApiError(503, 'not_configured', message);
export const validation = (details, message = '入力に誤りがあります') =>
  new ApiError(400, 'validation', message, { details });

export function errorBody(err) {
  return { error: { code: err.code, message: err.message, ...err.extra } };
}
