import type { IOrderPipeline, IPlatformAdapter, IProductProbe, PlatformId } from '../../types';
import { VolcengineAuthProbe } from './auth-probe';
import { VolcenginePaymentLauncher } from './payment-launcher';
import { VolcengineTicketProvider } from './ticket-provider';
import { VolcengineOverlayLayout } from './overlay-layout';

export interface VolcengineAdapterConfig {
  id: PlatformId;
  displayName: string;
  entryUrl: string;
  ProductProbe: new () => IProductProbe;
  OrderPipeline: new () => IOrderPipeline;
}

/**
 * Assemble a volcengine platform adapter. The Agent Plan and Coding Plan
 * adapters share every collaborator except their product probe, order pipeline,
 * id, display name, and entry URL.
 */
export function createVolcengineAdapter(config: VolcengineAdapterConfig): IPlatformAdapter {
  return {
    id: config.id,
    displayName: config.displayName,
    hostPatterns: ['*://*.volcengine.com/*'],
    entryUrl: config.entryUrl,

    authProbe: new VolcengineAuthProbe(),
    productProbe: new config.ProductProbe(),
    ticketProvider: new VolcengineTicketProvider(),
    orderPipeline: new config.OrderPipeline(),
    paymentLauncher: new VolcenginePaymentLauncher(),
    overlayLayout: new VolcengineOverlayLayout(),
  };
}
