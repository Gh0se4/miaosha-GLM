// Activity-specific configuration for the Coding Plan vertical slice.
const __volc_version =
  (typeof document !== 'undefined' && document.currentScript?.dataset?.version) ||
  (typeof chrome !== 'undefined' && chrome?.runtime?.getManifest?.()?.version) ||
  '__PKG_VERSION__';

const __volc_config = {
  platform: 'volcengine-codingplan',
  title: '火山引擎 Coding Plan',
  productCode: 'ark_bd',
  globalName: '__activity__codingplan__',
  payPath: 'codingplan',
  version: __volc_version,
  defaultProductId: 'Coding_Plan_Lite_monthly|duration:1',
  displayNames: {
    'Coding_Plan_Lite_monthly': 'Lite',
    'Coding_Plan_Pro_monthly': 'Pro',
  },
};
