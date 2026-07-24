export type PaymentCheckStatus = 'SUCCESS' | 'EXPIRE' | 'timeout';

export function reportPaymentStatus(
  status: PaymentCheckStatus,
  bizId: string,
  postToOverlay: (message: { type: string; data?: Record<string, string>; line?: string }) => void,
) {
  const suffix = String(bizId).slice(-8);
  if (status === 'SUCCESS') {
    postToOverlay({ type: 'STRIKE_PAYMENT_SUCCESS', data: { bizId, orderId: bizId } });
    postToOverlay({ type: 'FIRE_RESULT', line: '> Payment confirmed bizId=' + suffix });
    return;
  }
  if (status === 'EXPIRE') {
    postToOverlay({ type: 'STRIKE_PAYMENT_EXPIRED', data: { bizId, orderId: bizId } });
    postToOverlay({ type: 'FIRE_RESULT', line: '> Payment expired bizId=' + suffix });
    return;
  }
  postToOverlay({ type: 'STRIKE_PAYMENT_TIMEOUT', data: { bizId, orderId: bizId } });
  postToOverlay({ type: 'FIRE_RESULT', line: '> Payment status timeout bizId=' + suffix });
}
