/**
 * `@astroid/client` — the main SDK entry point.
 *
 * ```ts
 * import { Astroid } from '@astroid/client';
 *
 * const astroid = new Astroid({ apiKey: process.env.ASTROID_API_KEY! });
 *
 * // Resource namespaces:
 * const wallet = await astroid.wallets.create({ name: 'Ops', walletType: 'CUSTODIAL' });
 *
 * // AI-native intent:
 * const result = await astroid.ai.requestPayment({
 *   intent: 'Purchase OpenAI credits',
 *   amount: 150,
 *   asset: 'USDC',
 * });
 * ```
 *
 * The client owns a single {@link HttpClient} and hands it to every resource, so
 * a runtime token refresh (via {@link Astroid.setAccessToken}) is seen by all of
 * them at once.
 *
 * @packageDocumentation
 */

import {
  HttpClient,
  SDK_VERSION,
  type AstroidClientConfig,
  type Middleware,
} from '@astroid/core';
import { AgentResource } from '@astroid/agent';
import { AnalyticsResource } from '@astroid/analytics';
import { AuthResource, SessionManager, createSessionMiddleware } from '@astroid/auth';
import { BudgetResource } from '@astroid/budget';
import { NotificationResource } from '@astroid/notification';
import { PolicyResource } from '@astroid/policy';
import { TransactionResource } from '@astroid/transaction';
import { WalletResource } from '@astroid/wallet';
import { WebhookResource } from '@astroid/webhook';
import type {
  AuthTokens,
  EventHandlerMap,
  PaymentIntent,
  PaymentIntentResult,
  WebhookEventEnvelope,
  WebhookEventName,
} from '@astroid/types';
import { createErrorTranslatorMiddleware } from './middleware/error.js';

/** The AI-native namespace: express intents, not low-level transfers. */
export class AiResource {
  constructor(private readonly client: HttpClient) {}

  /**
   * Submit a high-level financial intent. The backend orchestrates the whole
   * workflow — proposal, policy evaluation, risk scoring, transaction — and
   * returns a {@link PaymentIntentResult} whose `outcome` says what happened
   * (`executed`, `pending_approval`, `simulated`, or `rejected`), always with a
   * human-readable `explanation`.
   *
   * Set `simulateOnly: true` to force AI Simulation Mode (nothing is created).
   */
  async requestPayment(intent: PaymentIntent): Promise<PaymentIntentResult> {
    const res = await this.client.post<PaymentIntentResult>('/ai/request-payment', intent);
    return res.data;
  }

  /**
   * Simulate an intent without creating anything. Convenience wrapper over
   * {@link AiResource.requestPayment} with `simulateOnly` forced on.
   */
  async simulatePayment(intent: Omit<PaymentIntent, 'simulateOnly'>): Promise<PaymentIntentResult> {
    return this.requestPayment({ ...intent, simulateOnly: true });
  }
}

/** A listener for a specific event name, typed via {@link EventHandlerMap}. */
export type EventListener<K extends WebhookEventName> = EventHandlerMap[K];

/** Unsubscribe function returned by {@link Astroid.on}. */
export type Unsubscribe = () => void;

/**
 * A plugin extends the client at construction time. It receives the fully-built
 * {@link Astroid} instance and may register middleware, attach event listeners,
 * or hang extra helpers off it. Return value is ignored.
 */
export interface AstroidPlugin {
  name: string;
  install(client: Astroid): void;
}

/**
 * A minimal, fully-typed event emitter over the platform's webhook event names.
 * The client uses this so application code can react to events it feeds in
 * (e.g. from a webhook handler or a websocket) with the same names the backend
 * emits: `astroid.on('transaction.completed', tx => ...)`.
 */
class TypedEmitter {
  private readonly listeners = new Map<WebhookEventName, Set<(...args: never[]) => void>>();

  on<K extends WebhookEventName>(event: K, listener: EventListener<K>): Unsubscribe {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as (...args: never[]) => void);
    return () => this.off(event, listener);
  }

  once<K extends WebhookEventName>(event: K, listener: EventListener<K>): Unsubscribe {
    const wrapped = ((data, envelope) => {
      off();
      (listener as (d: unknown, e: unknown) => void)(data, envelope);
    }) as EventListener<K>;
    const off = this.on(event, wrapped);
    return off;
  }

  off<K extends WebhookEventName>(event: K, listener: EventListener<K>): void {
    this.listeners.get(event)?.delete(listener as (...args: never[]) => void);
  }

  emit<K extends WebhookEventName>(event: WebhookEventEnvelope<K>): void {
    const set = this.listeners.get(event.event);
    if (!set) return;
    for (const listener of [...set]) {
      (listener as (d: unknown, e: unknown) => void)(event.data, event);
    }
  }

  removeAll(event?: WebhookEventName): void {
    if (event) this.listeners.delete(event);
    else this.listeners.clear();
  }
}

/**
 * The Astroid SDK client. Construct once and reuse; it is safe to share across
 * requests. Each resource namespace shares the one underlying {@link HttpClient},
 * so a token refresh or middleware registration is seen by all of them at once.
 */
export class Astroid {
  /** The SDK version, for diagnostics. */
  static readonly version = SDK_VERSION;

  /** The shared low-level HTTP client (escape hatch for un-wrapped calls). */
  readonly http: HttpClient;

  readonly sessionManager: SessionManager;
  readonly auth: AuthResource;
  readonly wallets: WalletResource;
  readonly agents: AgentResource;
  readonly policies: PolicyResource;
  readonly budgets: BudgetResource;
  readonly transactions: TransactionResource;
  readonly notifications: NotificationResource;
  readonly analytics: AnalyticsResource;
  readonly webhooks: WebhookResource;
  readonly ai: AiResource;

  private readonly emitter = new TypedEmitter();
  private readonly plugins: AstroidPlugin[] = [];

  constructor(config: AstroidClientConfig | HttpClient) {
    this.http = config instanceof HttpClient ? config : new HttpClient(config);

    const authConfig = this.http.config.auth;

    // If accessToken is a dynamic function, extract it as a token provider.
    const dynamicTokenProvider = !(config instanceof HttpClient) && typeof config.accessToken === 'function'
      ? config.accessToken
      : undefined;

    this.sessionManager = new SessionManager({
      accessToken: typeof authConfig.accessToken === 'string' ? authConfig.accessToken : undefined,
      refreshToken: authConfig.refreshToken,
      onTokenUpdate: authConfig.onTokenUpdate,
    });

    this.auth = new AuthResource(this.http, this.sessionManager);
    this.wallets = new WalletResource(this.http);
    this.agents = new AgentResource(this.http);
    this.policies = new PolicyResource(this.http);
    this.budgets = new BudgetResource(this.http);
    this.transactions = new TransactionResource(this.http);
    this.notifications = new NotificationResource(this.http);
    this.analytics = new AnalyticsResource(this.http);
    this.webhooks = new WebhookResource(this.http);
    this.ai = new AiResource(this.http);

    // Structured error translation: map Horizon and API error payloads to typed domain exceptions
    // (e.g. op_low_reserve → InsufficientFundsError, POLICY_VIOLATION → PolicyViolationError).
    // Installed by default so consumers get high-fidelity errors without manual middleware wiring.
    this.use(createErrorTranslatorMiddleware());

    this.use(
      createSessionMiddleware(this.sessionManager, async (refreshToken: string) => {
        const res = await this.http.post<AuthTokens>('/auth/refresh', { refreshToken });
        this.setAccessToken(res.data.accessToken);
        return res.data;
      })
    );

    this.http.set401Handler(async () => {
      if (!this.sessionManager.getRefreshToken()) {
        return false;
      }
      try {
        await this.sessionManager.refreshSession(async (refreshToken: string) => {
          const res = await this.http.post<AuthTokens>('/auth/refresh', { refreshToken });
          this.setAccessToken(res.data.accessToken);
          return res.data;
        });
        return true;
      } catch {
        return false;
      }
    });

    // Wire up the dynamic token provider (called before every request;
    // the HttpClient deduplicates concurrent calls automatically).
    if (dynamicTokenProvider) {
      this.http.setTokenProvider(dynamicTokenProvider);
    }
  }

  /** Register a request/response middleware. Returns `this` for chaining. */
  use(middleware: Middleware): this {
    this.http.use(middleware);
    return this;
  }

  /**
   * Install a plugin. The plugin's `install` is invoked immediately with this
   * client, so it can register middleware, attach listeners, or add helpers.
   * Returns `this` for chaining.
   */
  register(plugin: AstroidPlugin): this {
    this.plugins.push(plugin);
    plugin.install(this);
    return this;
  }

  /** The names of every installed plugin, in install order. */
  get installedPlugins(): readonly string[] {
    return this.plugins.map((p) => p.name);
  }

  /* -------------------------------- events -------------------------------- */

  /**
   * Subscribe to an event. Returns an unsubscribe function.
   *
   * ```ts
   * const off = astroid.on('transaction.completed', (tx) => console.log(tx.id));
   * // later: off();
   * ```
   *
   * The client does not open its own connection — feed it events from your
   * webhook handler (after {@link WebhookResource.constructEvent}) or a stream
   * via {@link Astroid.emit}, and they fan out to your typed listeners.
   */
  on<K extends WebhookEventName>(event: K, listener: EventListener<K>): Unsubscribe {
    return this.emitter.on(event, listener);
  }

  /** Subscribe to the next occurrence of an event only. */
  once<K extends WebhookEventName>(event: K, listener: EventListener<K>): Unsubscribe {
    return this.emitter.once(event, listener);
  }

  /** Remove a previously-registered listener. */
  off<K extends WebhookEventName>(event: K, listener: EventListener<K>): void {
    this.emitter.off(event, listener);
  }

  /** Dispatch an event envelope to all matching listeners. */
  emit<K extends WebhookEventName>(event: WebhookEventEnvelope<K>): void {
    this.emitter.emit(event);
  }

  /** Remove all listeners for one event, or (with no argument) for every event. */
  removeAllListeners(event?: WebhookEventName): void {
    this.emitter.removeAll(event);
  }

  /**
   * Update the bearer access token at runtime (e.g. after a refresh). All
   * resource namespaces pick it up immediately because they share one client.
   */
  setAccessToken(accessToken: string | undefined): void {
    this.http.setAccessToken(accessToken);
  }
}

export default Astroid;

// Re-export the resource classes and their param types so consumers can name
// them without reaching into individual packages.
export {
  AuthResource,
  SessionManager,
  createSessionMiddleware,
  parseJwt,
  isTokenExpired,
  getTokenExpiration,
  type TokenStorage,
  type SessionManagerConfig,
} from '@astroid/auth';
export { WalletResource, type WalletListParams } from '@astroid/wallet';
export { AgentResource, type AgentListParams } from '@astroid/agent';
export { PolicyResource, type PolicyListParams } from '@astroid/policy';
export { BudgetResource, type BudgetListParams } from '@astroid/budget';
export {
  TransactionResource,
  type ProposalListParams,
} from '@astroid/transaction';
export { NotificationResource } from '@astroid/notification';
export { AnalyticsResource } from '@astroid/analytics';
export {
  WebhookResource,
  WebhookSignatureError,
  type WebhookListParams,
  type ConstructEventOptions,
} from '@astroid/webhook';

// Convenience re-exports of the most-used types and errors.
export {
  createRetryMiddleware,
  retryMiddleware,
  backoffDelay,
  isRetryableStatus,
  type AstroidClientConfig,
  type Middleware,
  type RetryConfig,
  type RetryMiddlewareOptions,
} from '@astroid/core';
export * from '@astroid/types';
export {
  AstroidError,
  AuthenticationError,
  AuthorizationError,
  ValidationError,
  NotFoundError,
  ConflictError,
  PolicyViolationError,
  BudgetExceededError,
  ApprovalRequiredError,
  RateLimitError,
  NetworkError,
  ServerError,
  isAstroidError,
} from '@astroid/errors';
export {
  InsufficientFundsError,
  AstroidPolicyViolationError,
  AstroidInsufficientFundsError,
} from '@astroid/errors';
export {
  createErrorTranslatorMiddleware,
  errorTranslatorMiddleware,
  errorMiddleware,
  translateErrorBody,
  detectStellarCode,
} from './middleware/error.js';

