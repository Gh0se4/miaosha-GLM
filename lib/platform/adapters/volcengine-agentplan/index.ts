import { createVolcengineAdapter } from '../volcengine-shared/adapter-factory';
import { VolcengineAgentplanProductProbe } from './product-probe';
import { VolcengineAgentplanOrderPipeline } from './order-pipeline';

export const volcengineAgentplanAdapter = createVolcengineAdapter({
  id: 'volcengine-agentplan',
  displayName: '火山引擎 Agent Plan',
  entryUrl: 'https://www.volcengine.com/activity/agentplan',
  ProductProbe: VolcengineAgentplanProductProbe,
  OrderPipeline: VolcengineAgentplanOrderPipeline,
});
