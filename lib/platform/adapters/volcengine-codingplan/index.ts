import { createVolcengineAdapter } from '../volcengine-shared/adapter-factory';
import { VolcengineCodingplanProductProbe } from './product-probe';
import { VolcengineCodingplanOrderPipeline } from './order-pipeline';

export const volcengineCodingplanAdapter = createVolcengineAdapter({
  id: 'volcengine-codingplan',
  displayName: '火山引擎 Coding Plan',
  entryUrl: 'https://www.volcengine.com/activity/codingplan',
  ProductProbe: VolcengineCodingplanProductProbe,
  OrderPipeline: VolcengineCodingplanOrderPipeline,
});
