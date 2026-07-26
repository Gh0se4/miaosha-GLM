// Activity-specific configuration for the Agent Plan vertical slice.
const __volc_version =
  (typeof document !== 'undefined' && document.currentScript?.dataset?.version) ||
  (typeof chrome !== 'undefined' && chrome?.runtime?.getManifest?.()?.version) ||
  '__PKG_VERSION__';

const __volc_config = {
  platform: 'volcengine-agentplan',
  title: '火山引擎 Agent Plan',
  productCode: 'ark_subscription',
  globalName: '__activity__agentplan__',
  payPath: 'agentplan',
  version: __volc_version,
  defaultProductId: 'Agent_Plan_Small_monthly|duration:1',
  displayNames: {
    'Agent_Plan_Small_monthly': 'Small',
    'Agent_Plan_Medium_monthly': 'Medium',
    'Agent_Plan_Large_monthly': 'Large',
    'Agent_Plan_Max_monthly': 'Max',
  },
};
