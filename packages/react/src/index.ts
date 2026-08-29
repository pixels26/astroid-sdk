/**
 * `@astroid/react` — React bindings for the Astroid SDK.
 *
 * Wrap your tree in {@link AstroidProvider}, then reach the client from any
 * component with {@link useAstroid}. The read hooks are thin, correctly-keyed
 * wrappers over TanStack Query v5; the mutation hooks invalidate the relevant
 * queries on success so lists stay fresh without manual bookkeeping.
 *
 * ```tsx
 * import { AstroidProvider, useWallets } from '@astroid/react';
 *
 * function App() {
 *   return (
 *     <AstroidProvider config={{ apiKey: process.env.NEXT_PUBLIC_ASTROID_KEY! }}>
 *       <Wallets />
 *     </AstroidProvider>
 *   );
 * }
 *
 * function Wallets() {
 *   const { data, isLoading } = useWallets();
 *   if (isLoading) return <p>Loading…</p>;
 *   return <ul>{data?.data.map((w) => <li key={w.id}>{w.name}</li>)}</ul>;
 * }
 * ```
 *
 * The `"use client"` directive is prepended to the built output by tsup, so this
 * module is safe to import from a React Server Components tree.
 *
 * @packageDocumentation
 */

import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationOptions,
  type UseMutationResult,
  type UseQueryOptions,
  type UseQueryResult,
} from '@tanstack/react-query';
import {
  Astroid,
  type AgentListParams,
  type BudgetListParams,
  type PolicyListParams,
  type WalletListParams,
} from '@astroid/client';
import type {
  Agent,
  AnalyticsOverview,
  AnalyticsQuery,
  Budget,
  CreateAgentInput,
  CreateWalletInput,
  Notification,
  NotificationListParams,
  Paginated,
  PaymentIntent,
  PaymentIntentResult,
  Policy,
  Transaction,
  TransactionListParams,
  TransferInput,
  Wallet,
  WebhookEventEnvelope,
  WebhookEventName,
} from '@astroid/types';

/* -------------------------------------------------------------------------- */
/*                                  provider                                  */
/* -------------------------------------------------------------------------- */

const AstroidContext = createContext<Astroid | null>(null);

/** Props for {@link AstroidProvider}: supply a ready client or a config to build one. */
export type AstroidProviderProps = {
  children: ReactNode;
} & (
  | { client: Astroid; config?: never }
  | { config: ConstructorParameters<typeof Astroid>[0]; client?: never }
);

/**
 * Provides an {@link Astroid} client to the tree. Pass either an existing
 * `client` (recommended if you construct it elsewhere) or a `config` object
 * from which one is memoized. Assumes a TanStack Query `QueryClientProvider`
 * is present higher in the tree.
 */
export function AstroidProvider(props: AstroidProviderProps): ReactNode {
  const { children } = props;
  const client = useMemo(
    () => ('client' in props && props.client ? props.client : new Astroid(props.config)),
    // Rebuild only when the identity of the passed client/config changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    ['client' in props ? props.client : props.config],
  );
  return createElement(AstroidContext.Provider, { value: client }, children);
}

/** Access the {@link Astroid} client from context. Throws if no provider is present. */
export function useAstroid(): Astroid {
  const client = useContext(AstroidContext);
  if (!client) {
    throw new Error('useAstroid must be used within an <AstroidProvider>.');
  }
  return client;
}

/* -------------------------------------------------------------------------- */
/*                               query key factory                            */
/* -------------------------------------------------------------------------- */

/**
 * Canonical, stable query keys. Every read hook derives its key from here so
 * mutations can invalidate precisely (e.g. `queryKeys.wallets.all`).
 */
export const queryKeys = {
  wallets: {
    all: ['astroid', 'wallets'] as const,
    list: (params?: WalletListParams) => ['astroid', 'wallets', 'list', params ?? {}] as const,
    detail: (id: string) => ['astroid', 'wallets', 'detail', id] as const,
    balance: (id: string) => ['astroid', 'wallets', 'balance', id] as const,
  },
  agents: {
    all: ['astroid', 'agents'] as const,
    list: (params?: AgentListParams) => ['astroid', 'agents', 'list', params ?? {}] as const,
    detail: (id: string) => ['astroid', 'agents', 'detail', id] as const,
  },
  policies: {
    all: ['astroid', 'policies'] as const,
    list: (params?: PolicyListParams) => ['astroid', 'policies', 'list', params ?? {}] as const,
    detail: (id: string) => ['astroid', 'policies', 'detail', id] as const,
  },
  budgets: {
    all: ['astroid', 'budgets'] as const,
    list: (params?: BudgetListParams) => ['astroid', 'budgets', 'list', params ?? {}] as const,
    detail: (id: string) => ['astroid', 'budgets', 'detail', id] as const,
  },
  transactions: {
    all: ['astroid', 'transactions'] as const,
    list: (params?: TransactionListParams) =>
      ['astroid', 'transactions', 'list', params ?? {}] as const,
    detail: (id: string) => ['astroid', 'transactions', 'detail', id] as const,
  },
  notifications: {
    all: ['astroid', 'notifications'] as const,
    list: (params?: NotificationListParams) =>
      ['astroid', 'notifications', 'list', params ?? {}] as const,
    unreadCount: ['astroid', 'notifications', 'unread-count'] as const,
  },
  analytics: {
    overview: (query?: AnalyticsQuery) => ['astroid', 'analytics', 'overview', query ?? {}] as const,
  },
} as const;

/**
 * Options a caller may pass to a read hook (wrapper over TanStack `UseQueryOptions`).
 *
 * Supports full TanStack overrides including `queryKey`, `staleTime`,
 * `refetchInterval`, `gcTime`, `select`, `enabled`, etc. When `queryKey` is
 * supplied it replaces the hook's default `queryKeys.*` value, enabling custom
 * caching strategies and integration with global state managers.
 *
 * @typeParam TData  Data returned by the query.
 * @typeParam TError Error type (defaults to `Error`).
 */
export type ReadOptions<TData, TError = Error> = Omit<
  UseQueryOptions<TData, TError, TData, readonly unknown[]>,
  'queryKey' | 'queryFn'
> & {
  /** Override the default query key for custom caching / global state sync. */
  queryKey?: readonly unknown[];
};

/* -------------------------------------------------------------------------- */
/*                                 read hooks                                 */
/* -------------------------------------------------------------------------- */

/**
 * List wallets.
 *
 * Supports custom query options such as `queryKey`, `staleTime`,
 * `refetchInterval`, `gcTime`, and `select` for advanced caching strategies.
 *
 * @param params  Pagination/filter params forwarded to `astroid.wallets.list`.
 * @param options Custom TanStack Query options including `queryKey` override,
 *                `staleTime`, `refetchInterval`, `gcTime`, `select`, etc.
 *                When `queryKey` is supplied it replaces the default
 *                `queryKeys.wallets.list(params)` key, enabling integration
 *                with global state managers.
 */
export function useWallets(
  params?: WalletListParams,
  options?: ReadOptions<Paginated<Wallet>>,
): UseQueryResult<Paginated<Wallet>, Error> {
  const astroid = useAstroid();
  const { queryKey, ...rest } = options ?? {};
  return useQuery({
    queryKey: queryKey ?? queryKeys.wallets.list(params),
    queryFn: () => astroid.wallets.list(params),
    ...(rest as Omit<UseQueryOptions<Paginated<Wallet>, Error, Paginated<Wallet>, readonly unknown[]>, 'queryKey' | 'queryFn'>),
  });
}

/**
 * Fetch a single wallet. Disabled until `id` is truthy.
 *
 * `options.enabled` is merged with the internal `Boolean(id)` guard so a
 * custom `enabled: false` still disables the query even when `id` is present.
 *
 * @param id      Wallet id (when falsy, the query is disabled regardless of options).
 * @param options Custom query options including `queryKey` override, `staleTime`,
 *                `refetchInterval`, `gcTime`, `select`, and `enabled`.
 */
export function useWallet(
  id: string | undefined,
  options?: ReadOptions<Wallet>,
): UseQueryResult<Wallet, Error> {
  const astroid = useAstroid();
  const { queryKey, enabled: optionEnabled, ...rest } = options ?? {};
  const enabled = Boolean(id) && (optionEnabled ?? true);
  return useQuery({
    queryKey: queryKey ?? queryKeys.wallets.detail(id ?? ''),
    queryFn: () => astroid.wallets.get(id as string),
    enabled,
    ...(rest as Omit<UseQueryOptions<Wallet, Error, Wallet, readonly unknown[]>, 'queryKey' | 'queryFn' | 'enabled'>),
  });
}

/**
 * List agents.
 * @param params  Filter params.
 * @param options Custom query options (`queryKey`, `staleTime`, `refetchInterval`, `gcTime`, etc.).
 */
export function useAgents(
  params?: AgentListParams,
  options?: ReadOptions<Paginated<Agent>>,
): UseQueryResult<Paginated<Agent>, Error> {
  const astroid = useAstroid();
  const { queryKey, ...rest } = options ?? {};
  return useQuery({
    queryKey: queryKey ?? queryKeys.agents.list(params),
    queryFn: () => astroid.agents.list(params),
    ...(rest as Omit<UseQueryOptions<Paginated<Agent>, Error, Paginated<Agent>, readonly unknown[]>, 'queryKey' | 'queryFn'>),
  });
}

/**
 * Fetch a single agent. Disabled until `id` is truthy.
 * @param id      Agent id.
 * @param options Custom query options (`queryKey` override, `staleTime`, `refetchInterval`, etc.).
 */
export function useAgent(
  id: string | undefined,
  options?: ReadOptions<Agent>,
): UseQueryResult<Agent, Error> {
  const astroid = useAstroid();
  const { queryKey, enabled: optionEnabled, ...rest } = options ?? {};
  const enabled = Boolean(id) && (optionEnabled ?? true);
  return useQuery({
    queryKey: queryKey ?? queryKeys.agents.detail(id ?? ''),
    queryFn: () => astroid.agents.get(id as string),
    enabled,
    ...(rest as Omit<UseQueryOptions<Agent, Error, Agent, readonly unknown[]>, 'queryKey' | 'queryFn' | 'enabled'>),
  });
}

/**
 * List policies.
 * @param params  Filter params.
 * @param options Custom query options (`queryKey`, `staleTime`, `refetchInterval`, etc.).
 */
export function usePolicies(
  params?: PolicyListParams,
  options?: ReadOptions<Paginated<Policy>>,
): UseQueryResult<Paginated<Policy>, Error> {
  const astroid = useAstroid();
  const { queryKey, ...rest } = options ?? {};
  return useQuery({
    queryKey: queryKey ?? queryKeys.policies.list(params),
    queryFn: () => astroid.policies.list(params),
    ...(rest as Omit<UseQueryOptions<Paginated<Policy>, Error, Paginated<Policy>, readonly unknown[]>, 'queryKey' | 'queryFn'>),
  });
}

/**
 * List budgets.
 * @param params  Filter params.
 * @param options Custom query options (`queryKey`, `staleTime`, `refetchInterval`, etc.).
 */
export function useBudgets(
  params?: BudgetListParams,
  options?: ReadOptions<Paginated<Budget>>,
): UseQueryResult<Paginated<Budget>, Error> {
  const astroid = useAstroid();
  const { queryKey, ...rest } = options ?? {};
  return useQuery({
    queryKey: queryKey ?? queryKeys.budgets.list(params),
    queryFn: () => astroid.budgets.list(params),
    ...(rest as Omit<UseQueryOptions<Paginated<Budget>, Error, Paginated<Budget>, readonly unknown[]>, 'queryKey' | 'queryFn'>),
  });
}

/**
 * List transactions.
 * @param params  Filter params.
 * @param options Custom query options (`queryKey`, `staleTime`, `refetchInterval`, etc.).
 */
export function useTransactions(
  params?: TransactionListParams,
  options?: ReadOptions<Paginated<Transaction>>,
): UseQueryResult<Paginated<Transaction>, Error> {
  const astroid = useAstroid();
  const { queryKey, ...rest } = options ?? {};
  return useQuery({
    queryKey: queryKey ?? queryKeys.transactions.list(params),
    queryFn: () => astroid.transactions.list(params),
    ...(rest as Omit<UseQueryOptions<Paginated<Transaction>, Error, Paginated<Transaction>, readonly unknown[]>, 'queryKey' | 'queryFn'>),
  });
}

/**
 * List notifications.
 * @param params  Filter params.
 * @param options Custom query options (`queryKey`, `staleTime`, `refetchInterval`, etc.).
 */
export function useNotifications(
  params?: NotificationListParams,
  options?: ReadOptions<Paginated<Notification>>,
): UseQueryResult<Paginated<Notification>, Error> {
  const astroid = useAstroid();
  const { queryKey, ...rest } = options ?? {};
  return useQuery({
    queryKey: queryKey ?? queryKeys.notifications.list(params),
    queryFn: () => astroid.notifications.list(params),
    ...(rest as Omit<UseQueryOptions<Paginated<Notification>, Error, Paginated<Notification>, readonly unknown[]>, 'queryKey' | 'queryFn'>),
  });
}

/**
 * The count of unread notifications.
 * @param options Custom query options (`queryKey`, `staleTime`, `refetchInterval`, etc.).
 */
export function useUnreadCount(
  options?: ReadOptions<number>,
): UseQueryResult<number, Error> {
  const astroid = useAstroid();
  const { queryKey, ...rest } = options ?? {};
  return useQuery({
    queryKey: queryKey ?? queryKeys.notifications.unreadCount,
    queryFn: () => astroid.notifications.unreadCount(),
    ...(rest as Omit<UseQueryOptions<number, Error, number, readonly unknown[]>, 'queryKey' | 'queryFn'>),
  });
}

/**
 * Headline analytics for the dashboard.
 * @param query   Analytics filters.
 * @param options Custom query options (`queryKey`, `staleTime`, `refetchInterval`, etc.).
 */
export function useAnalyticsOverview(
  query?: AnalyticsQuery,
  options?: ReadOptions<AnalyticsOverview>,
): UseQueryResult<AnalyticsOverview, Error> {
  const astroid = useAstroid();
  const { queryKey, ...rest } = options ?? {};
  return useQuery({
    queryKey: queryKey ?? queryKeys.analytics.overview(query),
    queryFn: () => astroid.analytics.overview(query),
    ...(rest as Omit<UseQueryOptions<AnalyticsOverview, Error, AnalyticsOverview, readonly unknown[]>, 'queryKey' | 'queryFn'>),
  });
}

/* -------------------------------------------------------------------------- */
/*                               mutation hooks                               */
/* -------------------------------------------------------------------------- */

/**
 * Options a caller may pass to a mutation hook (wrapping `UseMutationOptions`).
 *
 * Supports standard overrides: `mutationKey`, `onSuccess`, `onError`,
 * `onSettled`, `retry`, `gcTime`, etc. The hook's automatic cache
 * invalidation is composed with any user-provided callbacks so both run.
 *
 * @typeParam TData  Result data type.
 * @typeParam TVars  Variable type passed to the mutation.
 * @typeParam TError Error type (defaults to `Error`).
 */
export type WriteOptions<TData, TVars, TError = Error, TContext = unknown> = Omit<
  UseMutationOptions<TData, TError, TVars, TContext>,
  'mutationFn'
>;

/**
 * Create a wallet; invalidates the wallet lists on success.
 *
 * Supports full mutation option overrides: `mutationKey`, `onSuccess`,
 * `onError`, `onSettled`, `retry`, etc. User callbacks are composed with
 * the automatic invalidation so both run.
 *
 * @param options Custom mutation options including `onSuccess`, `onError`,
 *                `onSettled`, `mutationKey`, `retry`, etc.
 */
export function useCreateWallet(
  options?: WriteOptions<Wallet, CreateWalletInput>,
): UseMutationResult<Wallet, Error, CreateWalletInput> {
  const astroid = useAstroid();
  const qc = useQueryClient();
  const { onSuccess, onError, onSettled, ...rest } = options ?? {};
  return useMutation({
    mutationFn: (input: CreateWalletInput) => astroid.wallets.create(input),
    ...(rest as Omit<UseMutationOptions<Wallet, Error, CreateWalletInput, unknown>, 'mutationFn'>),
    onSuccess: (data, vars, ctx) => {
      void qc.invalidateQueries({ queryKey: queryKeys.wallets.all });
      onSuccess?.(data, vars, ctx as unknown as void);
    },
    onError: (err, vars, ctx) => onError?.(err, vars, ctx as unknown as void),
    onSettled: (data, err, vars, ctx) => onSettled?.(data, err, vars, ctx as unknown as void),
  });
}

/**
 * Transfer from a wallet; invalidates wallets and transactions on success.
 *
 * @param walletId Source wallet id.
 * @param options  Custom mutation options (`onSuccess`, `onError`, `onSettled`,
 *                 `mutationKey`, `retry`, etc.).
 */
export function useTransfer(
  walletId: string,
  options?: WriteOptions<Transaction, TransferInput>,
): UseMutationResult<Transaction, Error, TransferInput> {
  const astroid = useAstroid();
  const qc = useQueryClient();
  const { onSuccess, onError, onSettled, ...rest } = options ?? {};
  return useMutation({
    mutationFn: (input: TransferInput) => astroid.wallets.transfer(walletId, input),
    ...(rest as Omit<UseMutationOptions<Transaction, Error, TransferInput, unknown>, 'mutationFn'>),
    onSuccess: (data, vars, ctx) => {
      void qc.invalidateQueries({ queryKey: queryKeys.wallets.all });
      void qc.invalidateQueries({ queryKey: queryKeys.transactions.all });
      onSuccess?.(data, vars, ctx as unknown as void);
    },
    onError: (err, vars, ctx) => onError?.(err, vars, ctx as unknown as void),
    onSettled: (data, err, vars, ctx) => onSettled?.(data, err, vars, ctx as unknown as void),
  });
}

/**
 * Create an agent; invalidates the agent lists on success.
 * @param options Custom mutation options (`onSuccess`, `onError`, `onSettled`, etc.).
 */
export function useCreateAgent(
  options?: WriteOptions<Agent, CreateAgentInput>,
): UseMutationResult<Agent, Error, CreateAgentInput> {
  const astroid = useAstroid();
  const qc = useQueryClient();
  const { onSuccess, onError, onSettled, ...rest } = options ?? {};
  return useMutation({
    mutationFn: (input: CreateAgentInput) => astroid.agents.create(input),
    ...(rest as Omit<UseMutationOptions<Agent, Error, CreateAgentInput, unknown>, 'mutationFn'>),
    onSuccess: (data, vars, ctx) => {
      void qc.invalidateQueries({ queryKey: queryKeys.agents.all });
      onSuccess?.(data, vars, ctx as unknown as void);
    },
    onError: (err, vars, ctx) => onError?.(err, vars, ctx as unknown as void),
    onSettled: (data, err, vars, ctx) => onSettled?.(data, err, vars, ctx as unknown as void),
  });
}

/**
 * The AI-native mutation: submit a financial intent. On an executed or pending
 * outcome it invalidates transactions and wallets so balances reflect the draw.
 *
 * @param options Custom mutation options (`onSuccess`, `onError`, `onSettled`,
 *                `mutationKey`, `retry`, etc.).
 */
export function useRequestPayment(
  options?: WriteOptions<PaymentIntentResult, PaymentIntent>,
): UseMutationResult<PaymentIntentResult, Error, PaymentIntent> {
  const astroid = useAstroid();
  const qc = useQueryClient();
  const { onSuccess, onError, onSettled, ...rest } = options ?? {};
  return useMutation({
    mutationFn: (intent: PaymentIntent) => astroid.ai.requestPayment(intent),
    ...(rest as Omit<UseMutationOptions<PaymentIntentResult, Error, PaymentIntent, unknown>, 'mutationFn'>),
    onSuccess: (data, vars, ctx) => {
      if (data.outcome === 'executed' || data.outcome === 'pending_approval') {
        void qc.invalidateQueries({ queryKey: queryKeys.transactions.all });
        void qc.invalidateQueries({ queryKey: queryKeys.wallets.all });
      }
      onSuccess?.(data, vars, ctx as unknown as void);
    },
    onError: (err, vars, ctx) => onError?.(err, vars, ctx as unknown as void),
    onSettled: (data, err, vars, ctx) => onSettled?.(data, err, vars, ctx as unknown as void),
  });
}

/* -------------------------------------------------------------------------- */
/*                                event bridge                                */
/* -------------------------------------------------------------------------- */

/**
 * Subscribe a component to a client event for its lifetime. The handler is kept
 * in a ref, so passing a fresh closure each render does not re-subscribe.
 *
 * ```tsx
 * useAstroidEvent('transaction.completed', (tx) => toast(`Sent ${tx.id}`));
 * ```
 */
export function useAstroidEvent<K extends WebhookEventName>(
  event: K,
  handler: (data: WebhookEventEnvelope<K>['data'], envelope: WebhookEventEnvelope<K>) => void,
): void {
  const astroid = useAstroid();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const off = astroid.on(event, ((data: unknown, envelope: unknown) => {
      (handlerRef.current as (d: unknown, e: unknown) => void)(data, envelope);
    }) as never);
    return off;
  }, [astroid, event]);
}

export { Astroid } from '@astroid/client';
