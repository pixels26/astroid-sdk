import { describe, it, expect } from 'vitest';
import {
  exportToCSV,
  exportToJSON,
  formatTransactionForExport,
  escapeCsvValue,
  type CsvColumn,
} from '../src/exporter.js';

describe('exportToCSV', () => {
  it('outputs a valid CSV string with headers and matching data rows', () => {
    const records = [
      {
        createdAt: '2026-01-01T00:00:00.000Z',
        id: 'tx_1',
        asset: 'USDC',
        amount: '100.0000000',
        gasEstimate: '0.0000100',
        senderAddress: 'GABC',
        recipientAddress: 'GDEF',
      },
      {
        createdAt: '2026-01-02T00:00:00.000Z',
        id: 'tx_2',
        asset: 'XLM',
        amount: '250.5',
        gasEstimate: '0.0000200',
        senderAddress: 'GHIJ',
        recipientAddress: 'GKLM',
      },
    ];

    const csv = exportToCSV(records);

    const lines = csv.split('\n');
    // header + 2 data rows
    expect(lines).toHaveLength(3);
    const header = lines[0]!;
    // Must contain canonical financial headers
    expect(header).toContain('Timestamp');
    expect(header).toContain('Transaction ID');
    expect(header).toContain('Asset Code');
    expect(header).toContain('Total Volume');
    expect(header).toContain('Fee Paid');
    expect(header).toContain('Sender');
    expect(header).toContain('Receiver');

    // Data rows must preserve amounts as strings (full precision)
    expect(csv).toContain('100.0000000');
    expect(csv).toContain('0.0000100');
    expect(csv).toContain('tx_1');
    expect(csv).toContain('GABC');

    // Every data row must have same column count as header
    const headerCols = header.split(',');
    for (const line of lines.slice(1)) {
      // Naïve split works here because we control data has no commas; for comma-containing data we test separately
      const cols = line.split(',');
      expect(cols.length).toBe(headerCols.length);
    }
  });

  it('handles explicit columns with custom accessors and nested data', () => {
    const records = [
      { id: 'tx_1', asset: 'USDC', amount: '10', fee: { amount: '0.001' }, sender: 'GAAA', receiver: 'GBBB', timestamp: '2026-01-01T00:00:00Z' },
      { id: 'tx_2', asset: 'XLM', amount: '20', fee: { amount: '0.002' }, sender: 'GCCC', receiver: 'GDDD', timestamp: '2026-01-02T00:00:00Z' },
    ];

    const columns: CsvColumn<(typeof records)[number]>[] = [
      { header: 'Timestamp', accessor: 'timestamp' },
      { header: 'Transaction ID', accessor: 'id' },
      { header: 'Asset Code', accessor: 'asset' },
      { header: 'Total Volume', accessor: 'amount' },
      { header: 'Fee Paid', accessor: (r) => (r.fee as { amount: string }).amount },
      { header: 'Sender', accessor: 'sender' },
      { header: 'Receiver', accessor: 'receiver' },
    ];

    const csv = exportToCSV(records, { columns });
    expect(csv.split('\n')[0]).toBe('Timestamp,Transaction ID,Asset Code,Total Volume,Fee Paid,Sender,Receiver');
    expect(csv).toContain('0.001');
    expect(csv).toContain('0.002');
  });

  it('escapes characters requiring escaping (double quotes, commas, newlines)', () => {
    const records = [
      { name: 'Alice "The Great"', note: 'Hello, world', memo: 'line1\nline2' },
    ];
    const columns: CsvColumn<(typeof records)[number]>[] = [
      { header: 'Name', accessor: 'name' },
      { header: 'Note', accessor: 'note' },
      { header: 'Memo', accessor: 'memo' },
    ];
    const csv = exportToCSV(records, { columns });
    // Header
    expect(csv.split('\n')[0]).toBe('Name,Note,Memo');
    // Name contains quotes -> should be doubled and wrapped: "Alice ""The Great"""
    expect(csv).toContain('"Alice ""The Great"""');
    // Note contains comma -> wrapped in quotes
    expect(csv).toContain('"Hello, world"');
    // Memo contains newline -> wrapped in quotes
    expect(csv).toContain('"line1\nline2"');
  });

  it('escapes special characters to avoid formula injection', () => {
    const records = [
      { value: '=SUM(A1:A10)' },
      { value: '+123' },
      { value: '-456' },
      { value: '@SUM(B1:B2)' },
    ];
    const columns: CsvColumn<(typeof records)[number]>[] = [{ header: 'Value', accessor: 'value' }];
    const csv = exportToCSV(records, { columns });
    const lines = csv.split('\n').slice(1); // skip header
    for (const line of lines) {
      // Each injected cell must be prefixed with a single quote inside CSV.
      // e.g. "'=SUM..." (and quoted if needed)
      expect(line.startsWith("'") || line.startsWith("\"'")).toBe(true);
    }
    expect(csv).toContain("'=SUM(A1:A10)");
    expect(csv).toContain("'+123");
    expect(csv).toContain("'-456");
    expect(csv).toContain("'@SUM(B1:B2)");
  });

  it('preserves float strings and big numbers with full precision', () => {
    const records = [
      { amount: '12345678901234567890.123456789', fee: '0.0000001000000' },
      { amount: '0.12345678901234567890', fee: '9999999999.9999999' },
    ];
    const columns: CsvColumn<(typeof records)[number]>[] = [
      { header: 'Total Volume', accessor: 'amount' },
      { header: 'Fee Paid', accessor: 'fee' },
    ];
    const csv = exportToCSV(records, { columns });
    expect(csv).toContain('12345678901234567890.123456789');
    expect(csv).toContain('0.0000001000000');
    expect(csv).toContain('0.12345678901234567890');
    expect(csv).toContain('9999999999.9999999');
    // Should not be coerced to exponential or truncated
    expect(csv).not.toContain('1.2345678901234568e+19');
  });

  it('handles empty records gracefully', () => {
    const csv = exportToCSV([], { columns: [{ header: 'Timestamp', accessor: 'timestamp' }] });
    expect(csv).toBe('Timestamp');
    const csvEmptyNoColumns = exportToCSV([]);
    expect(csvEmptyNoColumns).toBe('');
  });

  it('supports custom delimiter and includeHeader:false', () => {
    const records = [{ a: '1', b: '2' }];
    const csv = exportToCSV(records, {
      columns: [
        { header: 'A', accessor: 'a' },
        { header: 'B', accessor: 'b' },
      ],
      delimiter: ';',
      includeHeader: false,
    });
    expect(csv).toBe('1;2');
  });

  it('supports dot-path accessors for nested fields', () => {
    const records = [
      { wallet: { address: 'GAAA' }, meta: { fee: '0.01' } },
    ];
    const csv = exportToCSV(records, {
      columns: [
        { header: 'Address', accessor: 'wallet.address' },
        { header: 'Fee', accessor: 'meta.fee' },
      ],
    });
    expect(csv).toContain('GAAA');
    expect(csv).toContain('0.01');
  });
});

describe('escapeCsvValue', () => {
  it('wraps fields containing delimiter', () => {
    expect(escapeCsvValue('a,b')).toBe('"a,b"');
  });
  it('doubles quotes', () => {
    expect(escapeCsvValue('a"b')).toBe('"a""b"');
  });
  it('prefixes formula cells', () => {
    expect(escapeCsvValue('=cmd')).toBe("'=cmd");
    expect(escapeCsvValue('+cmd')).toBe("'+cmd");
    expect(escapeCsvValue('-cmd')).toBe("'-cmd");
    expect(escapeCsvValue('@cmd')).toBe("'@cmd");
  });
  it('handles null/undefined as empty', () => {
    expect(escapeCsvValue(null)).toBe('');
    expect(escapeCsvValue(undefined)).toBe('');
  });
});

describe('formatTransactionForExport', () => {
  it('maps nested transaction data into flat row shape', () => {
    const tx = {
      id: 'tx_abc',
      asset: 'USDC',
      amount: '100.00',
      createdAt: '2026-01-01T00:00:00Z',
      gasEstimate: '0.00001',
      senderAddress: 'GSENDER',
      recipientAddress: 'GRECEIVER',
    };
    const row = formatTransactionForExport(tx);
    expect(row['Timestamp']).toBe('2026-01-01T00:00:00Z');
    expect(row['Transaction ID']).toBe('tx_abc');
    expect(row['Asset Code']).toBe('USDC');
    expect(row['Total Volume']).toBe('100.00');
    expect(row['Fee Paid']).toBe('0.00001');
    expect(row['Sender']).toBe('GSENDER');
    expect(row['Receiver']).toBe('GRECEIVER');
  });

  it('resolves fee from nested metadata.fee', () => {
    const tx = {
      id: 'tx_2',
      asset: 'XLM',
      amount: '50',
      createdAt: '2026-01-01T00:00:00Z',
      metadata: { fee: '0.123' },
      senderAddress: 'GA',
      recipientAddress: 'GB',
    };
    const row = formatTransactionForExport(tx);
    expect(row['Fee Paid']).toBe('0.123');
  });

  it('handles missing fields gracefully', () => {
    const row = formatTransactionForExport({});
    expect(row['Timestamp']).toBe('');
    expect(row['Transaction ID']).toBe('');
  });
});

describe('exportToJSON', () => {
  it('outputs pretty-printed JSON by default', () => {
    const records = [{ id: 'tx_1', amount: '100.00' }];
    const json = exportToJSON(records);
    expect(json).toContain('\n');
    expect(json).toContain('  "id"');
    expect(JSON.parse(json)).toEqual(records);
  });

  it('supports compact output', () => {
    const records = [{ id: 'tx_1', amount: '100.00' }];
    const json = exportToJSON(records, { pretty: false });
    expect(json).not.toContain('\n');
    expect(JSON.parse(json)).toEqual(records);
  });

  it('preserves string precision for monetary amounts', () => {
    const records = [{ amount: '12345678901234567890.123456789' }];
    const json = exportToJSON(records);
    expect(json).toContain('12345678901234567890.123456789');
    const parsed = JSON.parse(json);
    expect(parsed[0].amount).toBe('12345678901234567890.123456789');
  });

  it('handles empty arrays', () => {
    expect(exportToJSON([])).toBe('[]');
  });

  it('respects custom space', () => {
    const records = [{ a: 1 }];
    const json = exportToJSON(records, { space: 4 });
    expect(json).toContain('    "a"');
  });

  it('handles generic metric records', () => {
    const records = [
      { agentId: 'ag_1', totalSpent: '500.00' },
      { agentId: 'ag_2', totalSpent: '600.00' },
    ];
    const json = exportToJSON(records);
    expect(JSON.parse(json)).toEqual(records);
  });
});
