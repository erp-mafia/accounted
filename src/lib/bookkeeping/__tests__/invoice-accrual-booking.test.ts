import { describe, it, expect, vi, beforeEach } from 'vitest'
import type {
  CreateJournalEntryInput,
  Invoice,
  InvoiceItem,
  SupplierInvoice,
  SupplierInvoiceItem,
} from '@/types'
import { makeSupplierInvoice } from '@/tests/helpers'
import { roundOre } from '@/lib/money'

// Periodisering booking behaviour: lines with an accrual period book their
// net to the 17xx/29xx interim account instead of the P&L account, while
// VAT and AR/AP lines stay untouched.

vi.mock('../engine', () => ({
  findFiscalPeriod: vi.fn().mockResolvedValue('period-1'),
  createJournalEntry: vi.fn().mockImplementation(
    async (_supabase: unknown, _companyId: string, _userId: string, input: CreateJournalEntryInput) => ({
      id: 'entry-1',
      ...input,
      lines: input.lines,
    })
  ),
}))

vi.mock('../vat-entries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../vat-entries')>()
  return {
    ...actual,
    generateSalesVatLines: vi.fn().mockImplementation(
      ({ vatTreatment, baseAmount }: { vatTreatment: string; baseAmount: number }) => {
        const rate = vatTreatment === 'standard_25' ? 0.25
          : vatTreatment === 'reduced_12' ? 0.12
          : vatTreatment === 'reduced_6' ? 0.06 : 0
        if (rate === 0) return []
        const account = vatTreatment === 'standard_25' ? '2611'
          : vatTreatment === 'reduced_12' ? '2621' : '2631'
        return [{
          account_number: account,
          debit_amount: 0,
          credit_amount: roundOre(baseAmount * rate),
          line_description: 'Utgående moms',
        }]
      },
    ),
  }
})

// The upplupen kostnad guard reads each month-end's lock state.
vi.mock('@/lib/api/v1/check-period-lock', () => ({
  checkPeriodLock: vi.fn().mockResolvedValue({ locked: false, fiscal_period_id: 'period-1' }),
}))

const { createJournalEntry } = await import('../engine')
const mockedCreateEntry = vi.mocked(createJournalEntry)
const { checkPeriodLock } = await import('@/lib/api/v1/check-period-lock')
const mockedCheckPeriodLock = vi.mocked(checkPeriodLock)

const { createSupplierInvoiceRegistrationEntry, createSupplierCreditNoteEntry } =
  await import('../supplier-invoice-entries')
const { createInvoiceJournalEntry, createCreditNoteJournalEntry } =
  await import('../invoice-entries')

function makeSupplierItem(overrides: Partial<SupplierInvoiceItem> = {}): SupplierInvoiceItem {
  const lineTotal = overrides.line_total ?? 12000
  const vatRate = overrides.vat_rate ?? 0.25
  return {
    id: 'si-item-1',
    supplier_invoice_id: 'si-1',
    sort_order: 0,
    description: 'Företagsförsäkring 2026',
    quantity: 1,
    unit: 'st',
    unit_price: lineTotal,
    line_total: lineTotal,
    account_number: '6310',
    vat_code: null,
    vat_rate: vatRate,
    vat_amount: overrides.vat_amount ?? roundOre(lineTotal * vatRate),
    reverse_charge_rate: null,
    created_at: '2026-01-15T00:00:00Z',
    ...overrides,
  }
}

function makeCustomerInvoice(overrides: Partial<Invoice> & { items?: InvoiceItem[] }): Invoice {
  return {
    id: 'inv-1',
    user_id: 'user-1',
    customer_id: 'cust-1',
    invoice_number: 'F-100',
    invoice_date: '2026-01-15',
    due_date: '2026-02-14',
    currency: 'SEK',
    exchange_rate: null,
    subtotal: 12000,
    subtotal_sek: null,
    vat_amount: 3000,
    vat_amount_sek: null,
    total: 15000,
    total_sek: null,
    vat_treatment: 'standard_25',
    vat_rate: 25,
    moms_ruta: '05',
    status: 'sent',
    paid_at: null,
    credited_invoice_id: null,
    document_type: 'invoice',
    created_at: '2026-01-15T00:00:00Z',
    updated_at: '2026-01-15T00:00:00Z',
    items: [],
    ...overrides,
  } as Invoice
}

function makeCustomerItem(overrides: Partial<InvoiceItem> = {}): InvoiceItem {
  return {
    id: 'item-1',
    invoice_id: 'inv-1',
    sort_order: 0,
    description: 'Serviceavtal 2026',
    quantity: 1,
    unit: 'st',
    unit_price: 12000,
    line_total: 12000,
    vat_rate: 25,
    vat_amount: 3000,
    created_at: '2026-01-15T00:00:00Z',
    ...overrides,
  }
}

function entryLines() {
  return mockedCreateEntry.mock.calls[0][3].lines
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('supplier invoice registration with periodisering', () => {
  it('debits the 17xx interim account instead of the cost account', async () => {
    const invoice = makeSupplierInvoice({
      id: 'si-1',
      subtotal: 12000,
      vat_amount: 3000,
      total: 15000,
    }) as SupplierInvoice
    const items = [
      makeSupplierItem({
        accrual_period_start: '2026-01-01',
        accrual_period_end: '2026-12-31',
        accrual_balance_account: '1730',
      }),
    ]

    await createSupplierInvoiceRegistrationEntry(
      {} as never, 'company-1', 'user-1', invoice, items, 'swedish_business', 'Försäkrings AB',
    )

    const lines = entryLines()
    expect(lines).toContainEqual(
      expect.objectContaining({ account_number: '1730', debit_amount: 12000 }),
    )
    expect(lines.some((l) => l.account_number === '6310')).toBe(false)
    expect(lines).toContainEqual(
      expect.objectContaining({ account_number: '2641', debit_amount: 3000 }),
    )
    expect(lines).toContainEqual(
      expect.objectContaining({ account_number: '2440', credit_amount: 15000 }),
    )
  })

  it('falls back to the BAS-conventional interim account when none is set', async () => {
    const invoice = makeSupplierInvoice({ id: 'si-1' }) as SupplierInvoice
    const items = [
      makeSupplierItem({
        accrual_period_start: '2026-01-01',
        accrual_period_end: '2026-12-31',
        accrual_balance_account: null,
      }),
    ]

    await createSupplierInvoiceRegistrationEntry(
      {} as never, 'company-1', 'user-1', invoice, items, 'swedish_business',
    )

    // 6310 försäkring → 1730 Förutbetalda försäkringspremier
    expect(entryLines()).toContainEqual(
      expect.objectContaining({ account_number: '1730', debit_amount: 12000 }),
    )
  })

  it('books mixed invoices with deferred and ordinary lines side by side', async () => {
    const invoice = makeSupplierInvoice({ id: 'si-1' }) as SupplierInvoice
    const items = [
      makeSupplierItem({
        accrual_period_start: '2026-01-01',
        accrual_period_end: '2026-12-31',
        accrual_balance_account: '1730',
      }),
      makeSupplierItem({
        id: 'si-item-2',
        sort_order: 1,
        description: 'Kontorsmaterial',
        line_total: 500,
        account_number: '6110',
      }),
    ]

    await createSupplierInvoiceRegistrationEntry(
      {} as never, 'company-1', 'user-1', invoice, items, 'swedish_business',
    )

    const lines = entryLines()
    expect(lines).toContainEqual(
      expect.objectContaining({ account_number: '1730', debit_amount: 12000 }),
    )
    expect(lines).toContainEqual(
      expect.objectContaining({ account_number: '6110', debit_amount: 500 }),
    )
  })
})

// Upplupen kostnad: July-September electricity on an invoice dated
// 2026-10-05. The registration clears 2990 with the net; moms stays on the
// invoice date (Dr 2641), and the months themselves book Dr 5020 / Cr 2990
// on their last days afterwards (accruals service).
describe('supplier invoice registration with an upplupen kostnad (29xx)', () => {
  const invoice = () =>
    makeSupplierInvoice({
      id: 'si-1',
      invoice_date: '2026-10-05',
      subtotal: 3000,
      vat_amount: 750,
      total: 3750,
    }) as SupplierInvoice
  const items = () => [
    makeSupplierItem({
      description: 'El juli-september',
      account_number: '5020',
      line_total: 3000,
      accrual_period_start: '2026-07-01',
      accrual_period_end: '2026-09-30',
      accrual_balance_account: '2990',
    }),
  ]

  it('debits 2990 with the net and keeps the moms and 2440 on the invoice date', async () => {
    await createSupplierInvoiceRegistrationEntry(
      {} as never, 'company-1', 'user-1', invoice(), items(), 'swedish_business', 'Elbolaget',
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.entry_date).toBe('2026-10-05')
    expect(input.lines).toContainEqual(expect.objectContaining({ account_number: '2990', debit_amount: 3000 }))
    expect(input.lines.some((l) => l.account_number === '5020')).toBe(false)
    expect(input.lines).toContainEqual(expect.objectContaining({ account_number: '2641', debit_amount: 750 }))
    expect(input.lines).toContainEqual(expect.objectContaining({ account_number: '2440', credit_amount: 3750 }))
    // Every month-end was checked before anything was posted.
    expect(mockedCheckPeriodLock.mock.calls.map((call) => call[2])).toEqual([
      '2026-07-31',
      '2026-08-31',
      '2026-09-30',
    ])
  })

  it('refuses the whole registration, posting nothing, when one of the months is locked', async () => {
    mockedCheckPeriodLock.mockImplementation(async (_s, _c, date) =>
      date === '2026-09-30'
        ? { locked: true, reason: 'company_lock_date_covers' }
        : { locked: false, fiscal_period_id: 'period-1' },
    )
    try {
      await expect(
        createSupplierInvoiceRegistrationEntry(
          {} as never, 'company-1', 'user-1', invoice(), items(), 'swedish_business',
        ),
      ).rejects.toMatchObject({
        code: 'SI_ACCRUED_COST_PERIOD_LOCKED',
        blocked: [{ date: '2026-09-30', reason: 'company_lock_date_covers' }],
      })
      expect(mockedCreateEntry).not.toHaveBeenCalled()
    } finally {
      mockedCheckPeriodLock.mockResolvedValue({ locked: false, fiscal_period_id: 'period-1' })
    }
  })

  it('refuses a 29xx period reaching the invoice month even when the stored row skipped validation', async () => {
    await expect(
      createSupplierInvoiceRegistrationEntry(
        {} as never, 'company-1', 'user-1',
        // The invoice date moved back into the period after registration
        // (a deferred invoice edited before Bokför).
        { ...invoice(), invoice_date: '2026-09-15' },
        items(),
        'swedish_business',
      ),
    ).rejects.toMatchObject({ code: 'SI_ACCRUED_COST_PERIOD_INVALID' })
    expect(mockedCreateEntry).not.toHaveBeenCalled()
  })

  it('a credit note credits 2990 back with the original rows', async () => {
    await createSupplierCreditNoteEntry(
      {} as never, 'company-1', 'user-1',
      makeSupplierInvoice({ id: 'si-credit-1', is_credit_note: true, invoice_date: '2026-11-02' }) as SupplierInvoice,
      items(),
      'swedish_business',
    )

    expect(entryLines()).toContainEqual(expect.objectContaining({ account_number: '2990', credit_amount: 3000 }))
  })
})

describe('supplier credit note with periodisering', () => {
  it('credits the interim account when given the original deferred items', async () => {
    const creditNote = makeSupplierInvoice({
      id: 'si-credit-1',
      is_credit_note: true,
    }) as SupplierInvoice
    const originalItems = [
      makeSupplierItem({
        accrual_period_start: '2026-01-01',
        accrual_period_end: '2026-12-31',
        accrual_balance_account: '1730',
      }),
    ]

    await createSupplierCreditNoteEntry(
      {} as never, 'company-1', 'user-1', creditNote, originalItems, 'swedish_business',
    )

    const lines = entryLines()
    expect(lines).toContainEqual(
      expect.objectContaining({ account_number: '1730', credit_amount: 12000 }),
    )
    expect(lines.some((l) => l.account_number === '6310')).toBe(false)
    expect(lines).toContainEqual(
      expect.objectContaining({ account_number: '2440', debit_amount: 15000 }),
    )
  })
})

describe('customer invoice with periodisering', () => {
  it('credits 29xx instead of revenue; output VAT untouched', async () => {
    const invoice = makeCustomerInvoice({
      items: [
        makeCustomerItem({
          accrual_period_start: '2026-01-01',
          accrual_period_end: '2026-12-31',
          accrual_balance_account: '2970',
        }),
      ],
    })

    await createInvoiceJournalEntry({} as never, 'company-1', 'user-1', invoice, 'aktiebolag')

    const lines = entryLines()
    expect(lines).toContainEqual(
      expect.objectContaining({ account_number: '1510', debit_amount: 15000 }),
    )
    expect(lines).toContainEqual(
      expect.objectContaining({ account_number: '2970', credit_amount: 12000 }),
    )
    expect(lines.some((l) => l.account_number === '3001')).toBe(false)
    expect(lines).toContainEqual(
      expect.objectContaining({ account_number: '2611', credit_amount: 3000 }),
    )
  })

  it('keeps ordinary lines on revenue accounts next to deferred lines', async () => {
    const invoice = makeCustomerInvoice({
      subtotal: 13000,
      vat_amount: 3250,
      total: 16250,
      items: [
        makeCustomerItem({
          accrual_period_start: '2026-01-01',
          accrual_period_end: '2026-12-31',
          accrual_balance_account: '2970',
        }),
        makeCustomerItem({
          id: 'item-2',
          sort_order: 1,
          description: 'Konsulttimmar',
          unit_price: 1000,
          line_total: 1000,
          vat_amount: 250,
        }),
      ],
    })

    await createInvoiceJournalEntry({} as never, 'company-1', 'user-1', invoice, 'aktiebolag')

    const lines = entryLines()
    expect(lines).toContainEqual(
      expect.objectContaining({ account_number: '2970', credit_amount: 12000 }),
    )
    expect(lines).toContainEqual(
      expect.objectContaining({ account_number: '3001', credit_amount: 1000 }),
    )
  })

  it('never defers reverse-charge lines (3308 keeps the full amount)', async () => {
    const invoice = makeCustomerInvoice({
      vat_treatment: 'reverse_charge',
      vat_amount: 0,
      total: 12000,
      items: [
        makeCustomerItem({
          vat_rate: 0,
          vat_amount: 0,
          accrual_period_start: '2026-01-01',
          accrual_period_end: '2026-12-31',
          accrual_balance_account: '2970',
        }),
      ],
    })

    await createInvoiceJournalEntry({} as never, 'company-1', 'user-1', invoice, 'aktiebolag')

    const lines = entryLines()
    expect(lines).toContainEqual(
      expect.objectContaining({ account_number: '3308', credit_amount: 12000 }),
    )
    expect(lines.some((l) => l.account_number === '2970')).toBe(false)
  })
})

describe('customer credit note with periodisering', () => {
  it('debits the interim account via the copied accrual fields', async () => {
    const creditNote = makeCustomerInvoice({
      id: 'kr-1',
      invoice_number: 'KR-F-100',
      subtotal: -12000,
      vat_amount: -3000,
      total: -15000,
      credited_invoice_id: 'inv-1',
      items: [
        makeCustomerItem({
          id: 'kr-item-1',
          invoice_id: 'kr-1',
          quantity: -1,
          line_total: -12000,
          vat_amount: -3000,
          accrual_period_start: '2026-01-01',
          accrual_period_end: '2026-12-31',
          accrual_balance_account: '2970',
        }),
      ],
    })

    await createCreditNoteJournalEntry(
      {} as never, 'company-1', 'user-1', creditNote, 'aktiebolag', 'Kund AB', 'A-42',
    )

    const lines = entryLines()
    expect(lines).toContainEqual(
      expect.objectContaining({ account_number: '2970', debit_amount: 12000 }),
    )
    expect(lines.some((l) => l.account_number === '3001')).toBe(false)
    expect(lines).toContainEqual(
      expect.objectContaining({ account_number: '1510', credit_amount: 15000 }),
    )
  })
})
