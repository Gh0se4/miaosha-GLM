import { describe, expect, it, vi } from 'vitest';

import { reportPaymentStatus } from '../../../../lib/api/payment-status-notifier';

describe('reportPaymentStatus', () => {
  it.each([
    ['SUCCESS', 'STRIKE_PAYMENT_SUCCESS', '> Payment confirmed bizId=34567890'],
    ['EXPIRE', 'STRIKE_PAYMENT_EXPIRED', '> Payment expired bizId=34567890'],
    ['timeout', 'STRIKE_PAYMENT_TIMEOUT', '> Payment status timeout bizId=34567890'],
  ] as const)('preserves the %s payment state and diagnostic log', (status, eventType, line) => {
    const post = vi.fn();

    reportPaymentStatus(status, '1234567890', post);

    expect(post).toHaveBeenCalledWith({ type: eventType, data: { bizId: '1234567890', orderId: '1234567890' } });
    expect(post).toHaveBeenCalledWith({ type: 'FIRE_RESULT', line });
  });
});
