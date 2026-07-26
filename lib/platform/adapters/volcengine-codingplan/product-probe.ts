import { createVolcengineProductProbe } from '../volcengine-shared/product-probe-factory';

const impl = createVolcengineProductProbe({
  platform: 'volcengine-codingplan',
  globalName: '__activity__codingplan__',
  productCode: 'ark_bd',
  displayNames: {
    'Coding_Plan_Lite_monthly': 'Lite',
    'Coding_Plan_Pro_monthly': 'Pro',
  },
});

export const getVolcengineCodingplanIndexKey = impl.getIndexKey;
export const getVolcengineCodingplanConfigItem = impl.getConfigItem;
export const seedVolcengineCodingplanCatalog = impl.seedCatalog;
export const VolcengineCodingplanProductProbe = impl.ProductProbe;
