/**
 * pg-real parity for 20261109060100_kontantmetod_bank_debit_requires_sale.sql
 * (#146).
 *
 * link_invoice_to_voucher reads invoice_voucher_books_sale() on the bank_debit
 * side; the candidate search and the validator read its TypeScript twin,
 * voucherBooksSale (lib/invoices/invoice-settlement-side.ts). One table of
 * verifikat shapes runs through both, and both must give the expected answer,
 * so what the dialog offers, what the MCP stage previews and what the RPC
 * accepts cannot drift apart. The RPC's own use of the function is pinned in
 * link-invoice-voucher-owner-paid.pg.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { getPool } from './setup'
import { voucherBooksSale, type SaleCheckLine } from '@/lib/invoices/invoice-settlement-side'

type Row = [account: string | null, debit: number | string, credit: number | string]

const line = ([account_number, debit_amount, credit_amount]: Row): SaleCheckLine => ({
  account_number,
  debit_amount,
  credit_amount,
})

const CASES: ReadonlyArray<[label: string, rows: Row[], lineAccounts: string[], expected: boolean]> = [
  ['the sale booked at payment', [['1930', 1250, 0], ['3001', 0, 1000], ['2611', 0, 250]], [], true],
  ['the sale paid to the owner privately', [['2013', 1250, 0], ['3001', 0, 1000], ['2611', 0, 250]], [], true],
  ['a USD sale paid to the owner with a kursförlust', [['2013', 2965, 0], ['7960', 14.5, 0], ['3308', 0, 2979.5]], [], true],
  ['a receivable booked elsewhere', [['1930', 1250, 0], ['1510', 0, 1250]], [], true],
  ['a ROT claim cleared by Skatteverket', [['1930', 5000, 0], ['1513', 0, 5000]], [], true],
  ['an outlay on the invoice line\'s 1680', [['1930', 1000, 0], ['3740', 0.4, 0], ['1680', 0, 1000.4]], ['1680'], true],
  ['the same outlay, no line on 1680', [['1930', 1000, 0], ['3740', 0.4, 0], ['1680', 0, 1000.4]], ['2420'], false],
  ['a deposit on the invoice line\'s 2420', [['1930', 3000, 0], ['2420', 0, 3000]], ['2420'], true],
  ['interest on the invoice line\'s 8313', [['1930', 500, 0], ['8313', 0, 500]], ['8313', '1385'], true],
  ['a private withdrawal', [['2013', 1250, 0], ['1930', 0, 1250]], [], false],
  ['an owner deposit', [['1930', 1250, 0], ['2018', 0, 1250]], [], false],
  ['an owner deposit even when 2018 is listed for another account', [['1930', 1250, 0], ['2018', 0, 1250]], ['2010'], false],
  ['a sale next to a withdrawal from the bank', [['2013', 1750, 0], ['3001', 0, 1000], ['2611', 0, 250], ['1930', 0, 500]], [], false],
  ['a sale next to a withdrawal, on the line account', [['2013', 1500, 0], ['1680', 0, 1000], ['1920', 0, 500]], ['1680'], false],
  ['a 2013 debit next to a 19xx debit (no 19xx credit)', [['2013', 500, 0], ['1930', 750, 0], ['3001', 0, 1000], ['2611', 0, 250]], [], true],
  ['a revenue debit only', [['1930', 100, 0], ['3001', 100, 0], ['2018', 0, 200]], [], false],
  ['a zero revenue credit', [['1930', 100, 0], ['3001', 0, 0], ['2018', 0, 100]], [], false],
  ['amounts as strings', [['1930', '1250.00', '0.00'], ['3001', '0.00', '1250.00']], [], true],
  ['a line without an account', [[null, 0, 100], ['1930', 100, 0]], [], false],
  ['a five-digit 3-account (prefix, not arithmetic)', [['1930', 100, 0], ['30011', 0, 100]], [], true],
  ['no lines at all', [], [], false],
]

describe('invoice_voucher_books_sale parity with voucherBooksSale', () => {
  it.each(CASES)('%s', async (_label, rows, lineAccounts, expected) => {
    const lines = rows.map(line)
    const { rows: result } = await getPool().query<{ books: boolean }>(
      'SELECT public.invoice_voucher_books_sale($1::jsonb, $2::text[]) AS books',
      [JSON.stringify(lines), lineAccounts],
    )
    expect({ sql: result[0].books, ts: voucherBooksSale(lines, lineAccounts) }).toEqual({
      sql: expected,
      ts: expected,
    })
  })

  it('reads a NULL lines or accounts argument as empty', async () => {
    const { rows } = await getPool().query<{ no_lines: boolean; no_accounts: boolean }>(
      `SELECT public.invoice_voucher_books_sale(NULL, NULL) AS no_lines,
              public.invoice_voucher_books_sale($1::jsonb, NULL) AS no_accounts`,
      [JSON.stringify([line(['1930', 100, 0]), line(['3001', 0, 100])])],
    )
    expect(rows[0]).toEqual({ no_lines: false, no_accounts: true })
  })

  it('is not callable by anon', async () => {
    const { rows } = await getPool().query<{ anon: boolean; authenticated: boolean }>(
      `SELECT has_function_privilege('anon', 'public.invoice_voucher_books_sale(jsonb,text[])', 'EXECUTE') AS anon,
              has_function_privilege('authenticated', 'public.invoice_voucher_books_sale(jsonb,text[])', 'EXECUTE') AS authenticated`,
    )
    expect(rows[0]).toEqual({ anon: false, authenticated: true })
  })
})
