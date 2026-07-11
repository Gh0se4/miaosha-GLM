import type { IPaymentLauncher, LaunchContext, OperationResult, PaymentSession } from '../../types';

type VueInstance = any;

function findPayComponent(): VueInstance | null {
  const root = document.querySelector('#app');
  if (!root || !(root as any).__vue__) return null;
  let top: VueInstance = (root as any).__vue__;
  while (top.$parent) top = top.$parent;

  const queue: VueInstance[] = [top];
  const visited = new Set<VueInstance>();
  while (queue.length) {
    const vm = queue.shift();
    if (!vm || visited.has(vm)) continue;
    visited.add(vm);
    const opts = vm.$options;
    const data = vm.$data;
    if (opts?.name === 'PayComponent' && data && 'payDialogVisible' in data) {
      return vm;
    }
    const children = vm.$children || [];
    for (const child of children) queue.push(child);
  }
  return null;
}

function setReactive(pay: VueInstance, key: string, value: unknown) {
  if (typeof pay.$set === 'function') {
    pay.$set(pay.$data, key, value);
  } else {
    pay.$data[key] = value;
  }
}

export class BigmodelPaymentLauncher implements IPaymentLauncher {
  readonly platform = 'bigmodel';

  async launch(session: PaymentSession, ctx: LaunchContext): Promise<OperationResult<void>> {
    if (!session.bizId) {
      return { success: false, error: 'missing bizId' };
    }
    const pay = findPayComponent();
    if (!pay) {
      return { success: false, error: 'PayComponent not found in Vue tree' };
    }

    try {
      setReactive(pay, 'priceData', {
        bizId: session.bizId,
        productId: session.productId,
        thirdPartyAmount: session.amount,
        payAmount: session.amount,
        qrCode: session.qrCode || null,
      });
      setReactive(pay, 'isSoldOut', false);
      setReactive(pay, 'isServerBusy', false);
      setReactive(pay, 'payType', ctx?.testMode ? 'ALI' : (session.raw as any)?.payType || 'ALI');
      setReactive(pay, 'payDialogVisible', true);
      if (typeof pay.$forceUpdate === 'function') pay.$forceUpdate();

      const setVerified = () => {
        try {
          setReactive(pay, 'captchaVerified', true);
          setReactive(pay, 'captchaTicket', pay.$data.captchaTicket || 'qg-bypass');
          setReactive(pay, 'captchaRandstr', pay.$data.captchaRandstr || 'qg-bypass');
          if (typeof pay.$forceUpdate === 'function') pay.$forceUpdate();
        } catch {
          // ignore
        }
      };
      if (typeof pay.$nextTick === 'function') {
        pay.$nextTick(setVerified);
      } else {
        setTimeout(setVerified, 0);
      }
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e?.message || 'failed to open native pay dialog' };
    }
  }
}
