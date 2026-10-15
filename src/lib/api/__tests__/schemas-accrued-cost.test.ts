import { describe, expect, it } from 'vitest'
import { CreateSupplierInvoiceSchema } from '../schemas'

// Upplupen kostnad (29xx) on supplier invoice lines: the account range and
// the "months before the invoice month" rule, alongside the general rule that
// a period lying only in the invoice month is refused (one month is enough).

function invoice(item: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    supplier_id: '00000000-0000-4000-8000-000000000001',
    supplier_invoice_number: 'EL-2026-10',
    invoice_date: '2026-10-05',
    due_date: '2026-11-04',
    items: [{ description: 'El', amount: 3000, account_number: '5020', ...item }],
    ...overrides,
  }
}

function issues(result: ReturnType<typeof CreateSupplierInvoiceSchema.safeParse>) {
  return result.success ? [] : result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
}

describe('CreateSupplierInvoiceSchema: periodisering balance account', () => {
  it('accepts a 17xx förutbetald kostnad as before', () => {
    const result = CreateSupplierInvoiceSchema.safeParse(
      invoice({ accrual_period_start: '2026-10-01', accrual_period_end: '2027-09-30', accrual_balance_account: '1730' }),
    )
    expect(result.success).toBe(true)
  })

  it('accepts a 29xx upplupen kostnad for months before the invoice month (Jul-Sep on an October invoice)', () => {
    for (const account of ['2990', '2960']) {
      const result = CreateSupplierInvoiceSchema.safeParse(
        invoice({ accrual_period_start: '2026-07-01', accrual_period_end: '2026-09-30', accrual_balance_account: account }),
      )
      expect(result.success).toBe(true)
    }
  })

  it('accepts a single-month 29xx period before the invoice month (September on an October invoice)', () => {
    const result = CreateSupplierInvoiceSchema.safeParse(
      invoice({ accrual_period_start: '2026-09-01', accrual_period_end: '2026-09-30', accrual_balance_account: '2990' }),
    )
    expect(issues(result)).toEqual([])
    expect(result.success).toBe(true)
  })

  it('refuses a 29xx period lying only in the invoice month (October on an October invoice)', () => {
    const result = CreateSupplierInvoiceSchema.safeParse(
      invoice({ accrual_period_start: '2026-10-01', accrual_period_end: '2026-10-31', accrual_balance_account: '2990' }),
    )
    expect(result.success).toBe(false)
    expect(issues(result)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'items.0.accrual_period_end', message: expect.stringMatching(/Dela raden/) }),
      ]),
    )
  })

  it('accepts a previous fiscal year period (Nov-Dec cost on a January invoice)', () => {
    const result = CreateSupplierInvoiceSchema.safeParse(
      invoice(
        { accrual_period_start: '2025-11-01', accrual_period_end: '2025-12-31', accrual_balance_account: '2990' },
        { invoice_date: '2026-01-20', due_date: '2026-02-19' },
      ),
    )
    expect(result.success).toBe(true)
  })

  it('refuses a 29xx period that runs into the invoice month, asking for a split', () => {
    const result = CreateSupplierInvoiceSchema.safeParse(
      invoice({ accrual_period_start: '2026-09-01', accrual_period_end: '2026-10-31', accrual_balance_account: '2990' }),
    )
    expect(result.success).toBe(false)
    expect(issues(result)).toEqual([
      expect.objectContaining({ path: 'items.0.accrual_period_end', message: expect.stringMatching(/Dela raden/) }),
    ])
  })

  it('refuses a 29xx period that lies after the invoice month', () => {
    const result = CreateSupplierInvoiceSchema.safeParse(
      invoice({ accrual_period_start: '2026-11-01', accrual_period_end: '2026-12-31', accrual_balance_account: '2990' }),
    )
    expect(result.success).toBe(false)
  })

  it('leaves a 17xx period over the invoice month alone', () => {
    const result = CreateSupplierInvoiceSchema.safeParse(
      invoice({ accrual_period_start: '2026-09-01', accrual_period_end: '2026-12-31', accrual_balance_account: '1790' }),
    )
    expect(result.success).toBe(true)
  })

  it('refuses a balance account outside 17xx/29xx', () => {
    const result = CreateSupplierInvoiceSchema.safeParse(
      invoice({ accrual_period_start: '2026-07-01', accrual_period_end: '2026-09-30', accrual_balance_account: '2440' }),
    )
    expect(result.success).toBe(false)
    expect(issues(result)[0]).toMatchObject({ path: 'items.0.accrual_balance_account' })
  })
})
