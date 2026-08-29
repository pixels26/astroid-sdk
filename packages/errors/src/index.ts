/**
 * `@astroid/errors` — typed error classes for the Astroid SDK.
 *
 * Every failure surfaced by the SDK is an `AstroidError` (or subclass), never a
 * generic `Error`. Consumers can branch on `instanceof PolicyViolationError`,
 * inspect `error.code`, `error.status`, and `error.requestId`, and read
 * structured `details`.
 */

import { ApiErrorCode, type ApiError } from '@astroid/types';

/** Structured context available on every Astroid error. */
export interface AstroidErrorOptions {
  code: string;
  status?: number;
  requestId?: string;
  details?: Record<string, unknown>;
  cause?: unknown;
}

/**
 * Base class for all Astroid SDK errors.
 *
 * @example
 * ```ts
 * try {
 *   await astroid.transactions.create(input);
 * } catch (err) {
 *   if (err instanceof BudgetExceededError) {
 *     console.error(err.code, err.details);
 *   }
 * }
 * ```
 */
export class AstroidError extends Error {
  /** Machine-readable error code (mirrors the API error code where possible). */
  readonly code: string;
  /** HTTP status code, when the error originated from an HTTP response. */
  readonly status: number | undefined;
  /** The API request id, for correlating with backend logs. */
  readonly requestId: string | undefined;
  /** Structured, machine-readable detail. */
  readonly details: Record<string, unknown> | undefined;

  constructor(message: string, options: AstroidErrorOptions) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options.code;
    this.status = options.status;
    this.requestId = options.requestId;
    this.details = options.details;
    // Restore prototype chain for reliable `instanceof` across transpile targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /** Whether retrying the request could plausibly succeed. */
  get isRetryable(): boolean {
    return false;
  }

  /** A plain, serialisable representation (safe to log — no secrets). */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      status: this.status,
      requestId: this.requestId,
      details: this.details,
    };
  }
}

/** 401 — missing/invalid credentials, expired token, or invalid API key. */
export class AuthenticationError extends AstroidError {}

/** 403 — authenticated but not permitted. */
export class AuthorizationError extends AstroidError {}

/** 400/422 — request failed schema or business validation. */
export class ValidationError extends AstroidError {
  /** Field-level validation issues, when the API provides them. */
  get fieldErrors(): Record<string, string[]> | undefined {
    return this.details?.fields as Record<string, string[]> | undefined;
  }
}

/** 404 — the requested resource does not exist. */
export class NotFoundError extends AstroidError {}

/** 409 — the request conflicts with the current resource state. */
export class ConflictError extends AstroidError {}

/** A transaction was blocked because it violates one or more spending policies. */
export class PolicyViolationError extends AstroidError {}

/** A transaction was blocked because the source account lacks sufficient funds. */
export class InsufficientFundsError extends AstroidError {}

/** Alias for {@link InsufficientFundsError} — matches the naming used in API docs and client middleware. */
export const AstroidInsufficientFundsError = InsufficientFundsError;

/** Alias for {@link PolicyViolationError} — matches the naming used in API docs and client middleware. */
export const AstroidPolicyViolationError = PolicyViolationError;

/** A transaction was blocked because it would exceed an available budget. */
export class BudgetExceededError extends AstroidError {}

/** A transaction requires human approval before it can execute. */
export class ApprovalRequiredError extends AstroidError {}

/** 429 — rate limit exceeded. Inspect `retryAfter` before retrying. */
export class RateLimitError extends AstroidError {
  /** Seconds to wait before retrying, from the `Retry-After` header if present. */
  get retryAfter(): number | undefined {
    const value = this.details?.retryAfter;
    return typeof value === 'number' ? value : undefined;
  }

  override get isRetryable(): boolean {
    return true;
  }
}

/** A transport-level failure: DNS, connection reset, offline, or timeout. */
export class NetworkError extends AstroidError {
  override get isRetryable(): boolean {
    return true;
  }
}

/** 5xx — the API failed to handle a valid request. */
export class ServerError extends AstroidError {
  override get isRetryable(): boolean {
    return true;
  }
}

/**
 * Maps an API error code to its concrete error class. Unknown codes fall back to
 * the base `AstroidError`.
 */
export function errorClassForCode(code: string): typeof AstroidError {
  switch (code) {
    case ApiErrorCode.AUTHENTICATION_ERROR:
    case ApiErrorCode.UNAUTHORIZED:
    case ApiErrorCode.INVALID_API_KEY:
    case ApiErrorCode.TOKEN_EXPIRED:
      return AuthenticationError;
    case ApiErrorCode.FORBIDDEN:
      return AuthorizationError;
    case ApiErrorCode.VALIDATION_ERROR:
    case ApiErrorCode.BAD_REQUEST:
      return ValidationError;
    case ApiErrorCode.NOT_FOUND:
      return NotFoundError;
    case ApiErrorCode.CONFLICT:
      return ConflictError;
    case ApiErrorCode.POLICY_VIOLATION:
    case ApiErrorCode.RISK_THRESHOLD_EXCEEDED:
      return PolicyViolationError;
    case ApiErrorCode.BUDGET_EXCEEDED:
      return BudgetExceededError;
    case ApiErrorCode.INSUFFICIENT_FUNDS:
    case ApiErrorCode.WALLET_FROZEN:
      return InsufficientFundsError;
    case ApiErrorCode.APPROVAL_REQUIRED:
      return ApprovalRequiredError;
    case ApiErrorCode.RATE_LIMITED:
      return RateLimitError;
    case ApiErrorCode.NETWORK_ERROR:
    case ApiErrorCode.TIMEOUT:
      return NetworkError;
    case ApiErrorCode.INTERNAL_ERROR:
    case ApiErrorCode.SERVICE_UNAVAILABLE:
      return ServerError;
    default:
      // Also support direct Horizon codes that may leak as API codes
      if (code === 'op_underfunded' || code === 'op_low_reserve' || code === 'tx_insufficient_balance') {
        return InsufficientFundsError;
      }
      return AstroidError;
  }
}

/**
 * Infers an error code from an HTTP status when the API did not supply one
 * (e.g. a proxy returned a bare 502).
 */
export function codeForStatus(status: number): string {
  if (status === 401) return ApiErrorCode.AUTHENTICATION_ERROR;
  if (status === 403) return ApiErrorCode.FORBIDDEN;
  if (status === 404) return ApiErrorCode.NOT_FOUND;
  if (status === 409) return ApiErrorCode.CONFLICT;
  if (status === 422 || status === 400) return ApiErrorCode.VALIDATION_ERROR;
  if (status === 429) return ApiErrorCode.RATE_LIMITED;
  if (status >= 500) return ApiErrorCode.INTERNAL_ERROR;
  return ApiErrorCode.BAD_REQUEST;
}

/** Fields the SDK knows how to lift out of an API error envelope. */
export interface NormalizeErrorContext {
  status?: number;
  requestId?: string;
  details?: Record<string, unknown>;
  cause?: unknown;
}

/**
 * Builds the correct typed error from an API error object (the `error` field of
 * a failed response envelope).
 */
export function fromApiError(apiError: ApiError, context: NormalizeErrorContext = {}): AstroidError {
  const ErrorClass = errorClassForCode(apiError.code);
  const details = { ...(apiError.details ?? {}), ...(context.details ?? {}) };
  return new ErrorClass(apiError.message, {
    code: apiError.code,
    status: context.status,
    requestId: context.requestId,
    details: Object.keys(details).length > 0 ? details : undefined,
    cause: context.cause,
  });
}

/**
 * Builds a typed error from an HTTP status alone (used when the response body is
 * missing or unparseable).
 */
export function fromStatus(
  status: number,
  message: string,
  context: NormalizeErrorContext = {},
): AstroidError {
  const code = codeForStatus(status);
  const ErrorClass = errorClassForCode(code);
  return new ErrorClass(message, {
    code,
    status,
    requestId: context.requestId,
    details: context.details,
    cause: context.cause,
  });
}

/** Wraps a low-level transport failure as a `NetworkError`. */
export function toNetworkError(cause: unknown, message = 'Network request failed'): NetworkError {
  return new NetworkError(message, {
    code: ApiErrorCode.NETWORK_ERROR,
    cause,
  });
}

/** Type guard: is this value an Astroid SDK error? */
export function isAstroidError(value: unknown): value is AstroidError {
  return value instanceof AstroidError;
}
