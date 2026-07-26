import { createVolcengineProductProbe } from '../volcengine-shared/product-probe-factory';

const impl = createVolcengineProductProbe({
  platform: 'volcengine-agentplan',
  globalName: '__activity__agentplan__',
  productCode: 'ark_subscription',
  displayNames: {
    'Agent_Plan_Small_monthly': 'Small',
    'Agent_Plan_Medium_monthly': 'Medium',
    'Agent_Plan_Large_monthly': 'Large',
    'Agent_Plan_Max_monthly': 'Max',
  },
});

export const getVolcengineAgentplanIndexKey = impl.getIndexKey;
export const getVolcengineAgentplanConfigItem = impl.getConfigItem;
export const seedVolcengineAgentplanCatalog = impl.seedCatalog;
export const VolcengineAgentplanProductProbe = impl.ProductProbe;
