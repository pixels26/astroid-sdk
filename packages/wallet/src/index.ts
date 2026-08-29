/**
 * `@astroid/wallet` — wallet lifecycle and on-chain balance resource.
 *
 * Covers creating/importing wallets, listing and reading them, updating status
 * (freeze/pause/archive), reading live Stellar balances, and initiating
 * transfers. Secret material (`ImportWalletInput.secretKey`) is passed straight
 * to the API and is never logged, cached, or returned.
 *
 * @packageDocumentation
 */

import { Resource } from '@astroid/core';
import type {
  CreateWalletInput,
  ImportWalletInput,
  Paginated,
  PaginationParams,
  Transaction,
  TransferInput,
  UpdateWalletInput,
  Wallet,
  WalletBalance,
  WalletStatus,
} from '@astroid/types';

export {
  signTransactionOffline,
  StellarNetworkPassphrase,
  type OfflineSigningResult,
  type SignerLike,
  type TransactionLike,
} from './signing.js';

export { SecureKeystore, type EncryptedPayload } from './keystore.js';

/** Filters accepted by {@link WalletResource.list}. */
export interface WalletListParams extends PaginationParams {
  status?: WalletStatus;
  walletType?: string;
  agentId?: string;
  network?: string;
}

/**
 * The `wallets` namespace on the Astroid client.
 *
 * A wallet is a managed Stellar account bound to an organization (and optionally
 * an agent). This resource never exposes private keys: creation returns only the
 * public {@link Wallet}, and imports accept a secret that the backend stores
 * encrypted and never echoes back.
 */
export class WalletResource extends Resource {
  /** Provision a brand-new managed wallet (the backend generates the keypair). */
  async create(input: CreateWalletInput): Promise<Wallet> {
    const res = await this.client.post<Wallet>('/wallets', input);
    return res.data;
  }

  /**
   * Import an existing Stellar account. The optional `secretKey` is transmitted
   * once for encrypted custody and is never logged or returned.
   */
  async import(input: ImportWalletInput): Promise<Wallet> {
    const res = await this.client.post<Wallet>('/wallets/import', input);
    return res.data;
  }

  /** Fetch a single wallet by id. */
  async get(walletId: string): Promise<Wallet> {
    return this.getData<Wallet>(`/wallets/${encodeURIComponent(walletId)}`);
  }

  /** List wallets, with optional status/type/agent filters and pagination. */
  async list(params: WalletListParams = {}): Promise<Paginated<Wallet>> {
    return this.listData<Wallet>('/wallets', { ...params });
  }

  /** Iterate every wallet across all pages. */
  iterate(params: WalletListParams = {}): AsyncGenerator<Wallet, void, void> {
    return this.iterateData<Wallet>('/wallets', { ...params });
  }

  /** Update a wallet's mutable fields (label, status, metadata). */
  async update(walletId: string, input: UpdateWalletInput): Promise<Wallet> {
    const res = await this.client.patch<Wallet>(`/wallets/${encodeURIComponent(walletId)}`, input);
    return res.data;
  }

  /** Freeze a wallet: block all outgoing transactions immediately. */
  async freeze(walletId: string): Promise<Wallet> {
    const res = await this.client.post<Wallet>(`/wallets/${encodeURIComponent(walletId)}/freeze`);
    return res.data;
  }

  /** Reverse a freeze, returning the wallet to `ACTIVE`. */
  async unfreeze(walletId: string): Promise<Wallet> {
    const res = await this.client.post<Wallet>(`/wallets/${encodeURIComponent(walletId)}/unfreeze`);
    return res.data;
  }

  /** Archive a wallet (soft-delete; it can no longer transact). */
  async archive(walletId: string): Promise<Wallet> {
    const res = await this.client.post<Wallet>(`/wallets/${encodeURIComponent(walletId)}/archive`);
    return res.data;
  }

  /** Read live on-chain balances for a wallet. */
  async balance(walletId: string): Promise<WalletBalance> {
    return this.getData<WalletBalance>(`/wallets/${encodeURIComponent(walletId)}/balance`);
  }

  /**
   * Initiate a transfer from a wallet. Returns the created {@link Transaction},
   * which may be `PENDING` if policy requires an approval before submission.
   */
  async transfer(walletId: string, input: TransferInput): Promise<Transaction> {
    const res = await this.client.post<Transaction>(
      `/wallets/${encodeURIComponent(walletId)}/transfer`,
      input,
    );
    return res.data;
  }
}
