/**
 * Platform-agnostic seckill contracts.
 *
 * Design reference:
 *   worktree/share/architecture/platform-seckill-modular-design.html
 *
 * Rules:
 *   - These interfaces are the stable core. New platforms are added by
 *     implementing them, not by editing them.
 *   - Feature slices coordinate only through the shared seams defined here
 *     (Iron Law).
 */

// =============================================================================
// SECTION 1: Identity & Platform Registry
// =============================================================================

export type PlatformId = 'bigmodel' | 'volcengine' | string;

export interface PlatformEntryInfo {
  id: PlatformId;
  displayName: string;
  hostPatterns: string[];
  entryUrl: string;
}

export interface IPlatformRegistry {
  register(adapter: IPlatformAdapter): void;
  get(id: PlatformId): IPlatformAdapter | undefined;
  list(): readonly IPlatformAdapter[];
}

// =============================================================================
// SECTION 2: Domain Models
// =============================================================================

export type BillingPeriod = 'monthly' | 'quarterly' | 'yearly';

/** Normalized, platform-agnostic product description. */
export interface Product {
  id: string;
  name: string;
  billingPeriod: BillingPeriod;
  /** Monthly-equivalent price for sorting/display. */
  price: number;
  /** Amount payable in this purchase. */
  currentAmount: number;
  /** Renewal/second-year amount if known. */
  renewAmount: number;
  originalPrice?: number;
  soldOut: boolean;
  tag?: string;
  description?: string;
  /** Platform-specific payload; consumers must treat it as opaque. */
  raw: unknown;
}

export interface ProductCatalog {
  platform: PlatformId;
  updatedAt: number;
  groups: Record<BillingPeriod, Product[]>;
}

export interface PlatformAuth {
  platform: PlatformId;
  capturedAt: number;
  /** Request headers required to call platform APIs. */
  headers: Record<string, string>;
  /** Platform-specific extras (cookies, csrf, customerId, etc.). */
  metadata?: Record<string, unknown>;
}

export interface Ticket {
  ticket: string;
  randstr?: string;
  provider: string;
  createdAt: number;
}

export interface OrderContext {
  platform: PlatformId;
  productId: string;
  ticket?: Ticket;
  payType?: string;
}

export interface PaymentSession {
  platform: PlatformId;
  productId: string;
  amount: number;
  currency: string;
  /** Platform-specific payment handle. */
  bizId?: string;
  payUrl?: string;
  orderId?: string;
  qrCode?: string;
  raw: unknown;
}

export interface AuthSignals {
  ok: boolean;
  source: 'live-page' | 'cache' | 'none';
  ageMs?: number;
  tokenSuffix?: string;
  userDisplay?: string;
}

// =============================================================================
// SECTION 3: Workflow Contracts
// =============================================================================

export interface OperationResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  metadata?: Record<string, unknown>;
}

/** Platform-specific authentication capture. */
export interface IAuthProbe {
  isAuthenticated(auth?: PlatformAuth | null): Promise<boolean>;
  capture(): Promise<PlatformAuth | null>;
  getSignals(auth: PlatformAuth | null): AuthSignals;
}

/** Platform-specific product catalog source. */
export interface IProductProbe {
  fetch(auth: PlatformAuth): Promise<ProductCatalog>;
  /** Extract catalog directly from the current page when available. */
  extractFromPage(): ProductCatalog | null;
}

/** Ticket / captcha provider. */
export interface ITicketProvider {
  readonly providerId: string;
  produce(): Promise<Ticket | null>;
  startBatch(): void;
  stopBatch(): void;
  destroyActive(): void;
}

/**
 * The order pipeline is a black box from the core's perspective.
 * Bigmodel does preview in one call; Volcengine does preorder → order → pay.
 * The caller only sees the resulting PaymentSession.
 */
export interface IOrderPipeline {
  run(ctx: OrderContext, auth: PlatformAuth): Promise<OperationResult<PaymentSession>>;
}

export interface LaunchContext {
  tabId?: number;
  window?: Window;
  testMode?: boolean;
}

/** Platform-specific payment UI launcher. */
export interface IPaymentLauncher {
  launch(session: PaymentSession, ctx: LaunchContext): Promise<OperationResult<void>>;
}

/** Where and how the MAIN-world overlay is mounted. */
export interface IOverlayLayout {
  readonly mountSelector: string;
  readonly mountPoint: 'header' | 'floating';
  buildRoot(): HTMLElement;
}

// =============================================================================
// SECTION 4: Platform Adapter (the polymorphic seam)
// =============================================================================

export interface IPlatformAdapter {
  readonly id: PlatformId;
  readonly displayName: string;
  readonly hostPatterns: string[];
  readonly entryUrl: string;

  readonly authProbe: IAuthProbe;
  readonly productProbe: IProductProbe;
  readonly ticketProvider: ITicketProvider;
  readonly orderPipeline: IOrderPipeline;
  readonly paymentLauncher: IPaymentLauncher;
  readonly overlayLayout: IOverlayLayout;
}

// =============================================================================
// SECTION 5: Shared Seams (Shared Stores)
// =============================================================================

export interface IObservableStore<T> {
  get(): T | null;
  watch(callback: (value: T | null) => void): () => void;
  set(value: T): Promise<void>;
  clear(): Promise<void>;
}

export interface IAuthStore extends IObservableStore<PlatformAuth> {
  isReady(): boolean;
}

export interface IProductCatalogStore extends IObservableStore<Record<PlatformId, ProductCatalog>> {
  getPlatform(platform: PlatformId): ProductCatalog | null;
}

export interface ISelectedProducts {
  platform: PlatformId;
  priorityList: Array<{ productId: string }>;
  billing?: BillingPeriod;
}

export interface ISelectedProductsStore extends IObservableStore<Record<PlatformId, ISelectedProducts>> {
  getPlatform(platform: PlatformId): ISelectedProducts | null;
}

export interface TicketPoolSnapshot {
  tickets: Ticket[];
  maxSize: number;
  ttlMs: number;
}

export interface ITicketPoolStore extends IObservableStore<TicketPoolSnapshot> {
  add(ticket: Ticket): void;
  consume(): Ticket | null;
  expire(): void;
}

export interface RuntimeCalibration {
  latencyMs: number;
  clockOffsetMs: number;
  sampleCount: number;
  calibratedAt: number;
}

export interface IRuntimeCalibrationStore extends IObservableStore<RuntimeCalibration> {
  apply(data: Partial<RuntimeCalibration>): void;
}

export interface ISaleTimeStore extends IObservableStore<number> {
  /** Epoch ms of the next sale. */
  getNextSaleTime(): number | null;
}

export interface IPaymentBridge extends IObservableStore<PaymentSession | null> {
  push(session: PaymentSession): Promise<void>;
}

// =============================================================================
// SECTION 6: Pre/Core/Post Contracts for Fire
// =============================================================================

export interface FireContext {
  platform: PlatformId;
  selected: ISelectedProducts;
  catalog: ProductCatalog;
  auth: PlatformAuth;
  ticket?: Ticket;
  payType: string;
}

export interface IReadinessChecker<TInput, TPrepared> {
  prepare(input: TInput): OperationResult<TPrepared>;
}

export interface ICoreAction<TPrepared, TOutput> {
  run(input: TPrepared): Promise<OperationResult<TOutput>>;
}

export interface IAfterActionHandler<TOutput> {
  onSuccess(result: TOutput): Promise<void>;
  onFailure(error: Error): Promise<void>;
  cleanup(): Promise<void>;
}

// =============================================================================
// SECTION 7: Shared Services
// =============================================================================

export interface IFirePlanBuilder {
  build(catalog: ProductCatalog, selected: ISelectedProducts, pool: TicketPoolSnapshot): FireContext[];
}

/** Optional bridge for cross-world sync. Implementations are runtime-specific. */
export interface IWorldBridge {
  send(type: string, payload?: unknown): void;
  on(type: string, handler: (payload: unknown) => void): () => void;
}
