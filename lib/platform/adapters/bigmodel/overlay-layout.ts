import type { IOverlayLayout } from '../../types';

export class BigmodelOverlayLayout implements IOverlayLayout {
  readonly mountSelector = '.pc-header-nav-left';
  readonly mountPoint = 'header' as const;

  buildRoot(): HTMLElement {
    const el = document.createElement('div');
    el.id = '_hdr_info';
    el.style.cssText =
      'display:flex;align-items:center;gap:14px;flex:1;min-width:0;margin:0 16px 0 0;padding:0;font-family:Inter,system-ui,sans-serif;color:#334155';
    return el;
  }
}
