import { createVolcengineOrderPipeline } from '../volcengine-shared/order-pipeline-factory';
import { getVolcengineCodingplanConfigItem, getVolcengineCodingplanIndexKey } from './product-probe';

export const VolcengineCodingplanOrderPipeline = createVolcengineOrderPipeline({
  platform: 'volcengine-codingplan',
  product: 'ark_bd',
  payPath: 'codingplan',
  getConfigItem: getVolcengineCodingplanConfigItem,
  getIndexKey: getVolcengineCodingplanIndexKey,
});
