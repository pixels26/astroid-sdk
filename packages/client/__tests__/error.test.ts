import { describe, it, expect, vi } from 'vitest';
import {
  PolicyViolationError,
  BudgetExceededError,
  InsufficientFundsError,
  AstroidError,
} from '@astroid/errors';
import {
  translateErrorBody,
  createErrorTranslatorMiddleware,
  detectStellarCode,
} from '../src/middleware/error.js';
import { StellarHorizonError } from '../src/errors.js';
import { Astroid } from '../src/index.js';

// ---------------------------------------------------------------------------
// translateErrorBody — pure function
// ---------------------------------------------------------------------------

describe('translateErrorBody', () => {
  it('maps Horizon op_low_reserve to InsufficientFundsError', () => {
    const body = {
      type: 'https://stellar.org/horizon-errors/transaction_failed',
      extras: { result_codes: { transaction: 'tx_failed', operations: ['op_low_reserve'] } },
    };
    const err = translateErrorBody(400, body, 'req_1');
    expect(err).toBeInstanceOf(InsufficientFundsError);
    expect(err?.code).toBe('op_low_reserve');
    expect(err?.status).toBe(402);
    expect(err?.requestId).toBe('req_1');
  });

  it('maps Horizon op_underfunded to InsufficientFundsError', () => {
    const body = {
      extras: { result_codes: { transaction: 'tx_failed', operations: ['op_underfunded'] } },
    };
    const err = translateErrorBody(400, body);
    expect(err).toBeInstanceOf(InsufficientFundsError);
    expect(err?.code).toBe('op_underfunded');
  });

  it('maps Horizon tx_insufficient_balance to InsufficientFundsError', () => {
    const body = { extras: { result_codes: { transaction: 'tx_insufficient_balance' } } };
    const err = translateErrorBody(400, body);
    expect(err).toBeInstanceOf(InsufficientFundsError);
  });

  it('maps API POLICY_VIOLATION to PolicyViolationError', () => {
    const body = { error: { code: 'POLICY_VIOLATION', message: 'Exceeds daily limit', details: { policyId: 'pol_1' } } };
    const err = translateErrorBody(422, body, 'req_pol');
    expect(err).toBeInstanceOf(PolicyViolationError);
    expect(err?.code).toBe('POLICY_VIOLATION');
    expect(err?.message).toBe('Exceeds daily limit');
    expect(err?.status).toBe(422);
    expect(err?.details).toEqual({ policyId: 'pol_1' });
  });

  it('maps API BUDGET_EXCEEDED to BudgetExceededError', () => {
    const body = { error: { code: 'BUDGET_EXCEEDED', message: 'Budget exceeded', details: {} } };
    const err = translateErrorBody(422, body);
    expect(err).toBeInstanceOf(BudgetExceededError);
  });

  it('maps API INSUFFICIENT_FUNDS to InsufficientFundsError', () => {
    const body = { error: { code: 'INSUFFICIENT_FUNDS', message: 'Not enough funds' } };
    const err = translateErrorBody(402, body);
    expect(err).toBeInstanceOf(InsufficientFundsError);
  });

  it('maps API INSUFFICIENT_FUNDS via error envelope with 402 status fallback', () => {
    const body = { error: { code: 'INSUFFICIENT_FUNDS', message: 'Wallet empty' } };
    const err = translateErrorBody(402, body, 'req_402');
    expect(err).toBeInstanceOf(InsufficientFundsError);
    expect(err?.status).toBe(402);
  });

  it('returns undefined for unmapped errors (pass-through)', () => {
    const body = { error: { code: 'SOME_UNKNOWN_CODE', message: 'Unknown' } };
    const err = translateErrorBody(418, body);
    expect(err).toBeUndefined();
  });

  it('returns undefined for Horizon codes without domain mapping (e.g., op_no_trust without mapping)', () => {
    // op_no_trust is mapped to ValidationError, so it should translate; test truly unknown
    const body = { extras: { result_codes: { operations: ['op_unknown_code_xyz'] } } };
    const err = translateErrorBody(400, body);
    expect(err).toBeUndefined();
  });

  it('preserves original details and requestId on translated errors', () => {
    const body = {
      error: { code: 'POLICY_VIOLATION', message: 'Blocked', details: { foo: 'bar' } },
    };
    const err = translateErrorBody(422, body, 'req_details');
    expect(err?.details).toEqual({ foo: 'bar' });
    expect(err?.requestId).toBe('req_details');
  });
});

describe('detectStellarCode', () => {
  it('detects extras.result_codes.operations', () => {
    const body = { extras: { result_codes: { operations: ['op_underfunded'] } } };
    expect(detectStellarCode(body)).toEqual({ stellarCode: 'op_underfunded', operationCode: 'op_underfunded' });
  });
  it('detects extras.result_codes.transaction', () => {
    const body = { extras: { result_codes: { transaction: 'tx_bad_seq' } } };
    expect(detectStellarCode(body)).toEqual({ stellarCode: 'tx_bad_seq', operationCode: undefined });
  });
  it('detects flat result_code', () => {
    expect(detectStellarCode({ result_code: 'tx_bad_auth' })).toEqual({ stellarCode: 'tx_bad_auth' });
  });
});

// ---------------------------------------------------------------------------
// Middleware integration
// ---------------------------------------------------------------------------

describe('createErrorTranslatorMiddleware', () => {
  it('throws domain error on response with Horizon op_underfunded (onResponse)', async () => {
    const mw = createErrorTranslatorMiddleware();
    const raw = {
      status: 400,
      headers: new Headers({ 'x-request-id': 'req_hor' }),
      body: { extras: { result_codes: { operations: ['op_underfunded'] } } },
      requestId: 'req_hor',
    } as unknown as Parameters<NonNullable<typeof mw.onResponse>>[0];
    const req = {} as Parameters<NonNullable<typeof mw.onResponse>>[1];
    await expect(mw.onResponse!(raw, req)).rejects.toBeInstanceOf(InsufficientFundsError);
  });

  it('throws PolicyViolationError on API policy rejection payload', async () => {
    const mw = createErrorTranslatorMiddleware();
    const raw = {
      status: 422,
      headers: new Headers(),
      body: { error: { code: 'POLICY_VIOLATION', message: 'Policy blocked' } },
      requestId: 'req_pol',
    } as unknown as Parameters<NonNullable<typeof mw.onResponse>>[0];
    await expect(mw.onResponse!(raw, {} as any)).rejects.toBeInstanceOf(PolicyViolationError);
  });

  it('does not throw for unmapped error (pass-through)', async () => {
    const mw = createErrorTranslatorMiddleware();
    const raw = {
      status: 500,
      headers: new Headers(),
      body: { error: { code: 'UNKNOWN', message: 'Something else' } },
      requestId: undefined,
    } as unknown as Parameters<NonNullable<typeof mw.onResponse>>[0];
    await expect(mw.onResponse!(raw, {} as any)).resolves.toBeUndefined();
  });

  it('remaps generic StellarHorizonError to domain via onError', async () => {
    const mw = createErrorTranslatorMiddleware();
    const stellarErr = new StellarHorizonError('Payment failed', {
      code: 'op_underfunded',
      status: 402,
      stellarCode: 'op_underfunded',
      operationCode: 'op_underfunded',
    });
    await expect(mw.onError!(stellarErr, {} as any)).rejects.toBeInstanceOf(InsufficientFundsError);
  });

  it('leaves unmapped StellarHorizonError untouched via onError', async () => {
    const mw = createErrorTranslatorMiddleware();
    const stellarErr = new StellarHorizonError('Unknown', {
      code: 'op_unknown',
      status: 400,
      stellarCode: 'op_unknown',
    });
    // Middleware should not throw a remapped error for unknown code — it should resolve without throwing
    await expect(mw.onError!(stellarErr, {} as any)).resolves.toBeUndefined();
  });

  it('maintains backward-compatibility: generic AstroidError with INSUFFICIENT_FUNDS is refined', async () => {
    const mw = createErrorTranslatorMiddleware();
    const generic = new AstroidError('Funds', { code: 'INSUFFICIENT_FUNDS', status: 402 });
    await expect(mw.onError!(generic, {} as any)).rejects.toBeInstanceOf(InsufficientFundsError);
  });
});

// ---------------------------------------------------------------------------
// Client integration — mock fetch to verify domain exceptions are thrown
// ---------------------------------------------------------------------------

function mockFetchFor(body: unknown, status: number, headers: Record<string, string> = {}): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    })) as unknown as typeof fetch;
}

describe('Astroid client integration with error translator', () => {
  const baseConfig = { apiKey: 'sk_test', baseUrl: 'https://api.example.test', retry: false as const };

  it('throws AstroidPolicyViolationError (PolicyViolationError) for policy rejection', async () => {
    const fetchMock = mockFetchFor(
      { error: { code: 'POLICY_VIOLATION', message: 'Spend limit exceeded' } },
      422,
      { 'x-request-id': 'req_int_pol' },
    );
    const client = new Astroid({ ...baseConfig, fetch: fetchMock });
    await expect(client.wallets.list()).rejects.toBeInstanceOf(PolicyViolationError);
    try {
      await client.wallets.list();
    } catch (err) {
      expect((err as PolicyViolationError).code).toBe('POLICY_VIOLATION');
      expect((err as PolicyViolationError).requestId).toBe('req_int_pol');
    }
  });

  it('throws AstroidInsufficientFundsError (InsufficientFundsError) for Horizon op_low_reserve', async () => {
    const fetchMock = mockFetchFor(
      {
        type: 'https://stellar.org/horizon-errors/transaction_failed',
        extras: { result_codes: { transaction: 'tx_failed', operations: ['op_low_reserve'] } },
        title: 'Transaction Failed',
      },
      400,
      { 'x-request-id': 'req_low' },
    );
    const client = new Astroid({ ...baseConfig, fetch: fetchMock });
    await expect(client.wallets.list()).rejects.toBeInstanceOf(InsufficientFundsError);
  });

  it('throws InsufficientFundsError for op_underfunded', async () => {
    const fetchMock = mockFetchFor(
      { extras: { result_codes: { transaction: 'tx_failed', operations: ['op_underfunded'] } } },
      400,
    );
    const client = new Astroid({ ...baseConfig, fetch: fetchMock });
    await expect(client.transactions.list()).rejects.toBeInstanceOf(InsufficientFundsError);
  });

  it('passes through unmapped errors with original details intact', async () => {
    const fetchMock = mockFetchFor({ error: { code: 'NOT_FOUND', message: 'Missing' } }, 404);
    const client = new Astroid({ ...baseConfig, fetch: fetchMock });
    // NOT_FOUND should still throw NotFoundError via translation (it is a domain error), but test a truly generic case
    // Use a 418 with unknown code that our translator leaves alone — HttpClient will map to AstroidError with code BAD_REQUEST
    const fetch418 = mockFetchFor({ error: { code: 'SOME_NEW_CODE', message: 'Weird' } }, 418);
    const client418 = new Astroid({ ...baseConfig, fetch: fetch418 });
    await expect(client418.wallets.list()).rejects.toBeInstanceOf(AstroidError);
    try {
      await client418.wallets.list();
    } catch (err) {
      expect((err as AstroidError).code).toBe('SOME_NEW_CODE');
      // Original message preserved
      expect((err as AstroidError).message).toBe('Weird');
    }
  });

  it('is installed by default — no manual middleware wiring needed', async () => {
    const client = new Astroid({
      ...baseConfig,
      fetch: mockFetchFor({ error: { code: 'POLICY_VIOLATION', message: 'Blocked' } }, 422),
    });
    // The client should have at least the error translator + session middleware
    expect(client.http.middleware).toBeDefined();
    await expect(client.wallets.list()).rejects.toBeInstanceOf(PolicyViolationError);
  });
});
