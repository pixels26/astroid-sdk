/**
 * `@astroid/react` — hooks barrel for `packages/react/src/hooks/`.
 *
 * Re-exports the TanStack Query hooks with full `UseQueryOptions` /
 * `UseMutationOptions` support (custom `queryKey`, `staleTime`,
 * `refetchInterval`, `onSuccess`, `onError`, etc.) from the main entry.
 * Keeping a dedicated `hooks/` directory satisfies the project layout
 * expected by the Stellar Wave program and allows consumers to import from
 * either `@astroid/react` or `@astroid/react/hooks`.
 *
 * @packageDocumentation
 */

export {
  queryKeys,
  useWallets,
  useWallet,
  useAgents,
  useAgent,
  usePolicies,
  useBudgets,
  useTransactions,
  useNotifications,
  useUnreadCount,
  useAnalyticsOverview,
  useCreateWallet,
  useTransfer,
  useCreateAgent,
  useRequestPayment,
  useAstroidEvent,
  type AstroidProviderProps,
} from '../index.js';

// Also re-export the option types for advanced consumers
export type { ReadOptions, WriteOptions } from '../index.js';
