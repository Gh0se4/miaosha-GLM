import { createVolcengineOrderPipeline } from '../volcengine-shared/order-pipeline-factory';
import { getVolcengineAgentplanConfigItem, getVolcengineAgentplanIndexKey } from './product-probe';

export const VolcengineAgentplanOrderPipeline = createVolcengineOrderPipeline({
  platform: 'volcengine-agentplan',
  product: 'ark_subscription',
  payPath: 'agentplan',
  getConfigItem: getVolcengineAgentplanConfigItem,
  getIndexKey: getVolcengineAgentplanIndexKey,
});
