import { beforeEach, describe, expect, it } from 'vitest'
import { openInvoiceVoucherWarning } from '../voucher-open-invoice-warning'

type Answer = { data: unknown; error: { message: string } | null }

const queries: Array<{ table: string; filters: Array<[string, string, unknown]> }> = []
let answers: Record<string, Answer> = {}

function client() {
  return {
    from(table: string) {
      const query = { table, filters: [] as Array<[string, string, unknown]> }
      queries.push(query)
      const chain = {
        select: () => chain,
        eq: (column: string, value: unknown) => (query.filters.push(['eq', column, value]), chain),
        in: (column: string, value: unknown) => (query.filters.push(['in', column, value]), chain),
        is: (column: string, value: unknown) => (query.filters.push(['is', column, value]), chain),
        limit: () => chain,
        then: (resolve: (value: Answer) => unknown) =>
          Promise.resolve(answers[table] ?? { data: [], error: null }).then(resolve),
      }
      return chain
    },
  } as never
}

const line = (account_number: string, debit_amount: number, credit_amount: number) => ({
  account_number,
  debit_amount,
  credit_amount,
})

describe('openInvoiceVoucherWarning', () => {
  beforeEach(() => {
    queries.length = 0
    answers = {}
  })

  it('asks nothing of the database for a verifikat that settles neither control account', async () => {
    const warning = await openInvoiceVoucherWarning(client(), 'company-1', {
      entry_date: '2026-11-01',
      lines: [line('5410', 1000, 0), line('1930', 0, 1000), line('1510', 500, 0), line('3001', 0, 500)],
    })

    expect(warning).toBeNull()
    expect(queries).toEqual([])
  })

  it('warns when the credit on kundfordringar is exactly what an owed invoice has left', async () => {
    answers.invoices = { data: [{ id: 'inv-1', invoice_number: '1042', currency: 'SEK' }], error: null }

    const warning = await openInvoiceVoucherWarning(client(), 'company-1', {
      entry_date: '2026-11-01',
      lines: [line('1930', 12500, 0), line('1510', 0, 12500)],
    })

    expect(warning).toMatchObject({
      code: 'OPEN_INVOICE_COVERS_POSTING',
      details: { account_number: '1510', amount: 12500, invoices: [{ kind: 'customer', id: 'inv-1' }] },
    })
    expect(warning?.message_sv).toContain('1042')
    expect(warning?.message_en).toContain('1042')
    expect(queries[0].table).toBe('invoices')
    expect(queries[0].filters).toEqual(
      expect.arrayContaining([
        ['eq', 'company_id', 'company-1'],
        ['eq', 'document_type', 'invoice'],
        ['in', 'status', ['sent', 'overdue', 'partially_paid']],
        ['eq', 'remaining_amount', 12500],
      ]),
    )
  })

  it('warns when the debit on leverantörsskulder is exactly what an open supplier invoice has left', async () => {
    answers.supplier_invoices = {
      data: [{ id: 'si-1', supplier_invoice_number: 'F-77', arrival_number: 12, currency: null }],
      error: null,
    }

    const warning = await openInvoiceVoucherWarning(client(), 'company-1', {
      entry_date: '2026-11-01',
      lines: [line('2440', 800.5, 0), line('1930', 0, 800.5)],
    })

    expect(warning).toMatchObject({
      code: 'OPEN_INVOICE_COVERS_POSTING',
      details: { account_number: '2440', amount: 800.5, invoices: [{ kind: 'supplier', id: 'si-1' }] },
    })
    expect(queries[0].table).toBe('supplier_invoices')
    expect(queries[0].filters).toEqual(
      expect.arrayContaining([
        ['in', 'status', ['registered', 'approved', 'overdue', 'partially_paid']],
        ['eq', 'remaining_amount', 800.5],
        ['is', 'reversed_at', null],
      ]),
    )
  })

  it('stays silent when no owed invoice has that amount left, and for an invoice in another currency', async () => {
    const none = await openInvoiceVoucherWarning(client(), 'company-1', {
      entry_date: '2026-11-01',
      lines: [line('1930', 300, 0), line('1510', 0, 300)],
    })
    expect(none).toBeNull()

    answers.invoices = { data: [{ id: 'inv-2', invoice_number: '7', currency: 'EUR' }], error: null }
    const foreign = await openInvoiceVoucherWarning(client(), 'company-1', {
      entry_date: '2026-11-01',
      lines: [line('1930', 300, 0), line('1510', 0, 300)],
    })
    expect(foreign).toBeNull()
  })

  it('leaves a rättelse and an ingående balans alone', async () => {
    answers.invoices = { data: [{ id: 'inv-1', invoice_number: '1042', currency: 'SEK' }], error: null }
    const lines = [line('1930', 12500, 0), line('1510', 0, 12500)]

    expect(
      await openInvoiceVoucherWarning(client(), 'company-1', {
        entry_date: '',
        lines,
        replaces: { entry_date: '2026-10-01', lines },
      }),
    ).toBeNull()
    expect(
      await openInvoiceVoucherWarning(client(), 'company-1', { entry_date: '2026-01-01', lines, opening_balance: true }),
    ).toBeNull()
    expect(queries).toEqual([])
  })

  it('throws when the read fails, for the guard to pass over', async () => {
    answers.invoices = { data: null, error: { message: 'down' } }

    await expect(
      openInvoiceVoucherWarning(client(), 'company-1', {
        entry_date: '2026-11-01',
        lines: [line('1930', 300, 0), line('1510', 0, 300)],
      }),
    ).rejects.toThrow('down')
  })
})
