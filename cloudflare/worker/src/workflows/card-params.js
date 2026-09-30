// Workflow の起動パラメータの形（cards.js は cloudflare:* を import するので、Node で試せるようここに分ける）。
export function cardScanParams(payload) {
  return {
    cardId: payload.cardId,
    userId: payload.userId,
    userName: payload.userName ?? '',
    type: payload.type === 'rescan' ? 'rescan' : 'scan',
  };
}
