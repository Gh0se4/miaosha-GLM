import type { IOverlayLayout } from '../../types';

export class VolcengineOverlayLayout implements IOverlayLayout {
  readonly mountSelector = 'body';
  readonly mountPoint = 'floating' as const;

  buildRoot(): HTMLElement {
    const el = document.createElement('div');
    el.id = '_panel_info';
    el.style.cssText =
      'position:fixed;top:80px;right:20px;width:280px;background:rgba(255,255,255,0.98);' +
      'backdrop-filter:blur(12px);border:1px solid #e2e8f0;border-radius:16px;' +
      'box-shadow:0 8px 32px rgba(0,0,0,0.15);z-index:2147483646;' +
      'font-family:Inter,system-ui,sans-serif;color:#1e293b;overflow:hidden;';
    return el;
  }
}
