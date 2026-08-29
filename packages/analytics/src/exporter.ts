/**
 * `@astroid/analytics` — CSV and JSON export helpers for financial audits.
 *
 * Converts collections of metric records / transaction events into flat,
 * spreadsheet-ready CSV strings and structured JSON payloads suitable for
 * off-platform reporting and compliance workflows.
 *
 * ## Security: CSV formula injection
 * Cells that start with `=`, `+`, `-`, or `@` are prefixed with a single quote
 * (`'`) to neutralise spreadsheet formula injection (CSV injection) while keeping
 * the underlying data human-readable.
 *
 * ## Precision
 * Monetary amounts in the Astroid API are `DecimalString` (string) to preserve
 * arbitrary precision. This module never coerces those values through `Number()`;
 * they are serialised verbatim so big numbers / high-precision floats survive
 * round-trips through spreadsheet software that would otherwise truncate them.
 *
 * @module
 */

/** A column definition for the CSV exporter. */
export interface CsvColumn<T = Record<string, unknown>> {
  /** Human-readable header, e.g. `Transaction ID`. */
  header: string;
  /**
   * How to read the value from a record.
   * - `string` — dot-path into the record (e.g. `"wallet.stellarAddress"` or `"amount"`).
   * - `keyof T` — direct key.
   * - `(row: T) => unknown` — custom accessor for nested/flat transforms.
   */
  accessor: string | keyof T | ((row: T) => unknown);
}

/** Options for {@link exportToCSV}. */
export interface CsvExportOptions<T = Record<string, unknown>> {
  /** Ordered column definitions. When omitted, columns are inferred from the first record. */
  columns?: CsvColumn<T>[];
  /** Field delimiter (default `,`). */
  delimiter?: string;
  /** Whether to emit a header row (default `true`). */
  includeHeader?: boolean;
  /** Line break string (default `\n`). */
  lineBreak?: string;
}

/** Options for {@link exportToJSON}. */
export interface JsonExportOptions {
  /** Pretty-print with 2-space indentation (default `true`). Set `false` for compact output. */
  pretty?: boolean;
  /** Indentation spaces when `pretty` is true (default `2`). */
  space?: number;
}

/* -------------------------------------------------------------------------- */
/* Column heading helpers                                                      */
/* -------------------------------------------------------------------------- */

/** Known key → human header mapping used for default inference. */
const HEADER_MAP: Record<string, string> = {
  createdAt: 'Timestamp',
  timestamp: 'Timestamp',
  date: 'Timestamp',
  created_at: 'Timestamp',
  id: 'Transaction ID',
  transactionId: 'Transaction ID',
  transaction_id: 'Transaction ID',
  asset: 'Asset Code',
  assetCode: 'Asset Code',
  asset_code: 'Asset Code',
  amount: 'Total Volume',
  totalVolume: 'Total Volume',
  total_volume: 'Total Volume',
  value: 'Total Volume',
  fee: 'Fee Paid',
  feePaid: 'Fee Paid',
  fee_paid: 'Fee Paid',
  gasEstimate: 'Fee Paid',
  gas_estimate: 'Fee Paid',
  totalFee: 'Fee Paid',
  senderAddress: 'Sender',
  sender: 'Sender',
  from: 'Sender',
  recipientAddress: 'Receiver',
  receiver: 'Receiver',
  recipient: 'Receiver',
  to: 'Receiver',
  destination: 'Receiver',
};

/**
 * Format a raw key into a Title Case header when no explicit mapping exists.
 * `camelCase` / `snake_case` → `Camel Case`
 */
function formatHeader(key: string): string {
  if (HEADER_MAP[key]) return HEADER_MAP[key]!;
  // Convert snake_case and camelCase to words
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .split(/\s+/);
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * Read a value from a record via a dot-path or direct key.
 * Returns `undefined` when the path cannot be resolved.
 */
function getByPath(record: Record<string, unknown>, path: string): unknown {
  if (!path.includes('.')) return (record as Record<string, unknown>)[path];
  const parts = path.split('.');
  let cur: unknown = record;
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * Flatten a record one level: keep primitives, JSON-stringify nested objects that
 * are not simple, but prefer primitive leaves. Used only when inferring columns
 * from an arbitrary record – transactional rows are already flat.
 */
function flattenKeys(record: Record<string, unknown>): string[] {
  return Object.keys(record);
}

/** Build inferred columns from the first record's keys. */
function inferColumns<T extends Record<string, unknown>>(record: T): CsvColumn<T>[] {
  const keys = flattenKeys(record as Record<string, unknown>);
  // If the record looks transaction-like, ensure we order the canonical financial columns first
  const canonicalOrder = [
    'createdAt',
    'timestamp',
    'id',
    'transactionId',
    'asset',
    'assetCode',
    'amount',
    'totalVolume',
    'fee',
    'feePaid',
    'gasEstimate',
    'senderAddress',
    'sender',
    'recipientAddress',
    'receiver',
  ];
  const canonicalPresent = canonicalOrder.filter((k) => keys.includes(k));
  const remaining = keys.filter((k) => !canonicalPresent.includes(k));
  const orderedKeys = [...canonicalPresent, ...remaining];
  return orderedKeys.map((key) => ({
    header: formatHeader(key),
    accessor: key as keyof T,
  }));
}

/* -------------------------------------------------------------------------- */
/* CSV escaping                                                                */
/* -------------------------------------------------------------------------- */

/** Characters that trigger formula injection in spreadsheets. */
const FORMULA_PREFIXES = new Set(['=', '+', '-', '@']);

/**
 * Escape a single CSV field according to RFC 4180 and neutralise formula injection.
 *
 * - Strings starting with `=`, `+`, `-`, `@` are prefixed with `'`.
 * - Fields containing delimiter, quote, or line break are wrapped in quotes and internal quotes are doubled.
 * - `null`/`undefined` → empty field.
 * - Numbers/BigInts are stringified verbatim; strings are kept as-is to preserve precision.
 */
export function escapeCsvValue(value: unknown, delimiter = ','): string {
  if (value === null || value === undefined) return '';

  let str: string;
  if (typeof value === 'string') {
    str = value;
  } else if (typeof value === 'number' || typeof value === 'bigint') {
    // Preserve full precision for DecimalString; numbers are stringified without coercion
    str = String(value);
  } else if (typeof value === 'boolean') {
    str = value ? 'true' : 'false';
  } else if (value instanceof Date) {
    str = value.toISOString();
  } else if (typeof value === 'object') {
    // For nested objects/arrays, JSON-stringify so the CSV cell remains meaningful
    try {
      str = JSON.stringify(value);
    } catch {
      str = String(value);
    }
  } else {
    str = String(value);
  }

  // Formula injection guard: prefix risky leading characters with a single quote
  // Trim start: a leading space does NOT neutralise the formula; we check after trimming leading spaces/tabs
  const trimmedStart = str.replace(/^[\s\t]+/, '');
  const firstChar = trimmedStart[0];
  if (firstChar && FORMULA_PREFIXES.has(firstChar)) {
    str = `'${str}`;
  } else if (trimmedStart.startsWith('\t') || trimmedStart.startsWith('\r')) {
    str = `'${str}`;
  }

  const needsQuoting =
    str.includes(delimiter) || str.includes('"') || str.includes('\n') || str.includes('\r');

  if (needsQuoting) {
    // Escape quotes by doubling them
    const escaped = str.replace(/"/g, '""');
    return `"${escaped}"`;
  }

  return str;
}

/**
 * Resolve a column's value from a record.
 */
function resolveColumnValue<T>(row: T, col: CsvColumn<T>): unknown {
  const { accessor } = col;
  if (typeof accessor === 'function') {
    return (accessor as (row: T) => unknown)(row);
  }
  if (typeof accessor === 'string') {
    // Allow dot-path strings for nested fields like "fee.amount" or "wallet.address"
    return getByPath(row as unknown as Record<string, unknown>, accessor);
  }
  // keyof T (symbol keys are not used for CSV columns)
  return (row as Record<string, unknown>)[accessor as unknown as string];
}

/* -------------------------------------------------------------------------- */
/* Public API: exportToCSV / exportToJSON                                      */
/* -------------------------------------------------------------------------- */

/**
 * Convert a collection of metric / transaction records to a CSV string.
 *
 * Generic over the record shape so callers can export `Transaction[]`, spending
 * rows, or any domain object without casting.
 *
 * @param records  Array of rows to serialise. Empty arrays produce only a header (if columns are known) or `""`.
 * @param options  Column definitions and CSV dialect settings.
 * @returns A single CSV string (header + rows) suitable for writing to a file or `Blob`.
 *
 * @example
 * ```ts
 * import { exportToCSV } from '@astroid/analytics';
 *
 * const csv = exportToCSV(transactions, {
 *   columns: [
 *     { header: 'Timestamp', accessor: 'createdAt' },
 *     { header: 'Transaction ID', accessor: 'id' },
 *     { header: 'Asset Code', accessor: 'asset' },
 *     { header: 'Total Volume', accessor: 'amount' },
 *     { header: 'Fee Paid', accessor: (r) => r.gasEstimate ?? '' },
 *     { header: 'Sender', accessor: 'senderAddress' },
 *     { header: 'Receiver', accessor: 'recipientAddress' },
 *   ],
 * });
 * ```
 */
export function exportToCSV<T extends Record<string, unknown>>(
  records: T[],
  options: CsvExportOptions<T> = {},
): string {
  const delimiter = options.delimiter ?? ',';
  const includeHeader = options.includeHeader ?? true;
  const lineBreak = options.lineBreak ?? '\n';

  const columns: CsvColumn<T>[] =
    options.columns ??
    (records.length > 0 ? inferColumns(records[0] as T) : []);

  if (columns.length === 0) return '';

  const lines: string[] = [];

  if (includeHeader) {
    const headerLine = columns.map((col) => escapeCsvValue(col.header, delimiter)).join(delimiter);
    lines.push(headerLine);
  }

  for (const row of records) {
    const line = columns
      .map((col) => escapeCsvValue(resolveColumnValue(row, col), delimiter))
      .join(delimiter);
    lines.push(line);
  }

  return lines.join(lineBreak);
}

/**
 * Convert a collection of metric / transaction records to a formatted JSON string.
 *
 * The output is a JSON array of the input records, suitable for financial audits
 * and archival. Monetary fields remain strings so precision is not lost.
 *
 * @param records  Array of rows to serialise.
 * @param options  Pretty-print settings.
 * @returns A JSON string representing the array.
 *
 * @example
 * ```ts
 * import { exportToJSON } from '@astroid/analytics';
 * const json = exportToJSON(transactions); // pretty-printed by default
 * const compact = exportToJSON(transactions, { pretty: false });
 * ```
 */
export function exportToJSON<T>(records: T[], options: JsonExportOptions = {}): string {
  const pretty = options.pretty ?? true;
  if (!pretty) return JSON.stringify(records);
  const space = options.space ?? 2;
  return JSON.stringify(records, null, space);
}

/**
 * Map a `Transaction`-like object into a flat, spreadsheet-ready row.
 *
 * Useful as a `columns` accessor helper or as a standalone formatter when callers
 * want explicit control over how nested fees/dates/amounts are surfaced. Keeps
 * `amount` and `gasEstimate` as strings to preserve decimal precision.
 *
 * @param tx  A transaction record (loose shape: supports `id`, `asset`, `amount`, `createdAt`, `fee`/`gasEstimate`/`metadata`, `senderAddress`/`recipientAddress`).
 * @returns A flat row with canonical headers as keys.
 *
 * @example
 * ```ts
 * const rows = transactions.map(formatTransactionForExport);
 * const csv = exportToCSV(rows);
 * ```
 */
export function formatTransactionForExport(
  tx: Record<string, unknown>,
): Record<string, string> {
  const get = (keys: string[]): string => {
    for (const k of keys) {
      const v = k.includes('.') ? getByPath(tx, k) : tx[k];
      if (v !== null && v !== undefined && v !== '') return String(v);
    }
    return '';
  };

  // Fee may be nested: fee.amount, gasEstimate, metadata.fee, etc.
  const fee =
    get(['feePaid', 'fee', 'gasEstimate', 'gas_estimate', 'totalFee', 'metadata.fee', 'metadata.gasEstimate', 'fee.amount']) ||
    (typeof tx.fee === 'object' && tx.fee !== null
      ? String((tx.fee as Record<string, unknown>).amount ?? '')
      : '');

  return {
    Timestamp: get(['createdAt', 'timestamp', 'date', 'created_at']),
    'Transaction ID': get(['id', 'transactionId', 'transaction_id']),
    'Asset Code': get(['asset', 'assetCode', 'asset_code']),
    'Total Volume': get(['amount', 'totalVolume', 'total_volume', 'value']),
    'Fee Paid': fee,
    Sender: get(['senderAddress', 'sender', 'from', 'source']),
    Receiver: get(['recipientAddress', 'receiver', 'recipient', 'to', 'destination']),
  };
}

/**
 * Prepare generic metric rows for export by flattening one level of nesting.
 * Nested objects are JSON-stringified; primitives are kept as strings.
 */
export function flattenRecordForExport(record: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === null || value === undefined) {
      out[formatHeader(key)] = '';
    } else if (typeof value === 'object' && !(value instanceof Date)) {
      try {
        out[formatHeader(key)] = JSON.stringify(value);
      } catch {
        out[formatHeader(key)] = String(value);
      }
    } else {
      out[formatHeader(key)] = String(value);
    }
  }
  return out;
}
