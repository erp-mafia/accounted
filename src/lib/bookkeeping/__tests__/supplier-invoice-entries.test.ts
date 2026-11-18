import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupplierInvoice, SupplierInvoiceItem, CreateJournalEntryLineInput, CreateJournalEntryInput } from '@/types'
import { makeSupplierInvoice } from '@/tests/helpers'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { getErrorMessage } from '@/lib/errors/get-error-message'

// Mock engine
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

// The company's momskoder (chart_of_accounts.default_vat_treatment and
// default_vat_rate): none configured unless a test says otherwise.
// Reverse-charge paths read them.
type Momskoder = Map<string, { default_vat_treatment: string | null; default_vat_rate: number | null }>
const mockFetchChartVatTreatments = vi.fn(async (_supabase: unknown, _companyId: string): Promise<Momskoder> => new Map())
vi.mock('../chart-vat-treatments', () => ({
  fetchChartVatTreatments: (supabase: unknown, companyId: string) => mockFetchChartVatTreatments(supabase, companyId),
}))
/** account -> momskod, or [momskod, momssats]. */
const momskoder = (codes: Record<string, string | [string, number]>): Momskoder =>
  new Map(Object.entries(codes).map(([account, code]) => [account, {
    default_vat_treatment: Array.isArray(code) ? code[0] : code,
    default_vat_rate: Array.isArray(code) ? code[1] : null,
  }]))

// Mock currency-utils with real logic
vi.mock('../currency-utils', () => ({
  resolveSekAmount: vi.fn().mockImplementation(
    (amount: number, amountSek: number | null, currency: string | null, exchangeRate: number | null) => {
      if (!currency || currency === 'SEK') return amount
      if (amountSek != null) return Math.round(amountSek * 100) / 100
      if (exchangeRate != null && exchangeRate > 0) return Math.round(amount * exchangeRate * 100) / 100
      return amount
    }
  ),
  buildCurrencyMetadata: vi.fn().mockImplementation(
    (currency: string | null, amountInCurrency: number | null | undefined, exchangeRate: number | null) => {
      if (!currency || currency === 'SEK') return {}
      return {
        ...(currency ? { currency } : {}),
        ...(amountInCurrency != null ? { amount_in_currency: amountInCurrency } : {}),
        ...(exchangeRate != null && exchangeRate > 0 ? { exchange_rate: exchangeRate } : {}),
      }
    }
  ),
}))

const { createJournalEntry, findFiscalPeriod } = await import('../engine')
const mockedCreateEntry = vi.mocked(createJournalEntry)
const mockedFindFiscalPeriod = vi.mocked(findFiscalPeriod)

const {
  buildSupplierInvoiceRegistrationEntryInput,
  createSupplierInvoiceRegistrationEntry,
  createSupplierInvoicePaymentEntry,
  createSupplierInvoiceCashEntry,
  createSupplierCreditNoteEntry,
  assertSupplierCreditNoteRowsMatchPayable,
  buildSupplierInvoicePrivatelyPaidLines,
  largestExpenseAccount,
  SupplierInvoiceFxRateMissingError,
  SupplierCreditNoteRowsMismatchError,
} = await import('../supplier-invoice-entries')
const { buildSupplierPaymentClearingLines } = await import('../supplier-payment-lines')

function makeItem(overrides: Partial<SupplierInvoiceItem> = {}): SupplierInvoiceItem {
  // Mirror the API: vat_amount derives from line_total × vat_rate unless the
  // test overrides it explicitly (manual-override cases). This keeps multi-
  // item and mixed-rate fixtures self-consistent with the engine, which now
  // reads stored vat_amount directly rather than recomputing from line_total.
  const lineTotal = overrides.line_total ?? 8000
  const vatRate = overrides.vat_rate ?? 0.25
  const vatAmount = overrides.vat_amount ?? Math.round(lineTotal * vatRate * 100) / 100
  return {
    id: 'si-item-1',
    supplier_invoice_id: 'si-1',
    sort_order: 0,
    description: 'Consulting services',
    quantity: 1,
    unit: 'st',
    unit_price: lineTotal,
    line_total: lineTotal,
    account_number: '6200',
    vat_code: null,
    vat_rate: vatRate,
    vat_amount: vatAmount,
    reverse_charge_rate: null,
    created_at: '2024-06-01T00:00:00Z',
    ...overrides,
  }
}

function findByAccount(lines: CreateJournalEntryLineInput[], account: string) {
  return lines.filter((l) => l.account_number === account)
}

/** Balance check helper */
function assertBalanced(input: CreateJournalEntryInput) {
  const totalDebit = input.lines.reduce((sum, l) => sum + l.debit_amount, 0)
  const totalCredit = input.lines.reduce((sum, l) => sum + l.credit_amount, 0)
  expect(Math.round(totalDebit * 100)).toBe(Math.round(totalCredit * 100))
  expect(totalDebit).toBeGreaterThan(0)
}

// ============================================================
// createSupplierInvoiceRegistrationEntry
// ============================================================

describe('createSupplierInvoiceRegistrationEntry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedFindFiscalPeriod.mockResolvedValue('period-1')
  })

  it('returns null when no fiscal period found', async () => {
    mockedFindFiscalPeriod.mockResolvedValue(null)
    const invoice = makeSupplierInvoice()
    const items = [makeItem()]

    const result = await createSupplierInvoiceRegistrationEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'swedish_business'
    )

    expect(result).toBeNull()
    expect(mockedCreateEntry).not.toHaveBeenCalled()
  })

  it('creates domestic entry with VAT (D expense + D 2641 + C 2440)', async () => {
    const invoice = makeSupplierInvoice({
      subtotal: 8000,
      vat_amount: 2000,
      total: 10000,
    })
    const items = [makeItem({ line_total: 8000, account_number: '6200', vat_rate: 0.25 })]

    await createSupplierInvoiceRegistrationEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'swedish_business'
    )

    expect(mockedCreateEntry).toHaveBeenCalledOnce()
    const input = mockedCreateEntry.mock.calls[0][3]

    const debit6200 = findByAccount(input.lines, '6200')
    expect(debit6200).toHaveLength(1)
    expect(debit6200[0].debit_amount).toBe(8000)

    const debit2641 = findByAccount(input.lines, '2641')
    expect(debit2641).toHaveLength(1)
    expect(debit2641[0].debit_amount).toBe(2000) // 8000 * 0.25

    const credit2440 = findByAccount(input.lines, '2440')
    expect(credit2440).toHaveLength(1)
    expect(credit2440[0].credit_amount).toBe(10000) // 8000 + 2000

    assertBalanced(input)
  })

  it('books manual VAT override (bilförmån 50%) instead of recomputing from rate', async () => {
    // Personbilsleasing: leverantören fakturerar 25% moms (2 500 kr), men
    // endast 50% (1 250 kr) är avdragsgill enligt ML 8 kap 16§. Användaren
    // anger 1 250 kr manuellt. Det resterande beloppet förblir på
    // kostnadskontot (10 000 + 1 250 ej avdragsgill moms = 11 250 brutto-
    // kostnad om användaren även justerar line_total; här testar vi enbart
    // att momsöverskridningen genererar rätt 2641-belopp).
    const invoice = makeSupplierInvoice({
      subtotal: 10000,
      vat_amount: 1250,
      total: 11250,
    })
    const items = [
      makeItem({
        line_total: 10000,
        account_number: '5615', // Leasing av personbilar
        vat_rate: 0.25,
        vat_amount: 1250, // manual override (50% av 2 500)
      }),
    ]

    await createSupplierInvoiceRegistrationEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'swedish_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]

    const debit5615 = findByAccount(input.lines, '5615')
    expect(debit5615[0].debit_amount).toBe(10000)

    const debit2641 = findByAccount(input.lines, '2641')
    expect(debit2641).toHaveLength(1)
    // Avgörande: 1 250 (manual), INTE 2 500 (10 000 × 0.25).
    expect(debit2641[0].debit_amount).toBe(1250)

    const credit2440 = findByAccount(input.lines, '2440')
    expect(credit2440[0].credit_amount).toBe(11250)

    assertBalanced(input)
  })

  it('recomputes 2641 from line_total × rate when stored vat_amount is 0 (legacy/import path)', async () => {
    // Schema default is vat_amount=0; SIE imports and demo seeders sometimes
    // leave it that way. Silently posting 0 to 2641 would understate ruta 48
    // in the momsdeklaration. The engine recovers by recomputing from the
    // base when the stored amount is missing.
    const invoice = makeSupplierInvoice({
      subtotal: 10000,
      vat_amount: 2500,
      total: 12500,
    })
    const items = [
      makeItem({ line_total: 10000, account_number: '5410', vat_rate: 0.25, vat_amount: 0 }),
    ]

    await createSupplierInvoiceRegistrationEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'swedish_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    const debit2641 = findByAccount(input.lines, '2641')
    expect(debit2641).toHaveLength(1)
    expect(debit2641[0].debit_amount).toBe(2500)
    assertBalanced(input)
  })

  it('posts 2641 from the items even when invoice.vat_amount is stale/zero (regression: MCP inbox-conversion header/line mismatch)', async () => {
    // Reported bug: gnubok_create_supplier_invoice_from_inbox sourced the
    // header vat_amount from the OCR-extracted document totals (totalsExt.vat)
    // instead of summing the line items. Customizing per-line VAT rates (or a
    // mis-extracted document total) left invoice.vat_amount at 0 while the
    // items still carried correct non-zero vat_rate/vat_amount. The engine
    // used to gate the whole VAT branch on `invoice.vat_amount > 0`, so a
    // stale header silently suppressed a correct per-line VAT posting (e.g.
    // Glesys 623884: 1 001 kr booked with zero VAT instead of 800.54 + 200.14).
    // The fix drives the gate off the items themselves (itemsHaveVat), so the
    // header field can never again suppress a correct posting.
    const invoice = makeSupplierInvoice({
      subtotal: 800.54,
      vat_amount: 0, // stale header: never reconciled against the customized line
      total: 1001,
    })
    const items = [
      makeItem({ line_total: 800.54, account_number: '6540', vat_rate: 0.25, vat_amount: 200.14 }),
    ]

    await createSupplierInvoiceRegistrationEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'swedish_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]

    const debit6540 = findByAccount(input.lines, '6540')
    expect(debit6540[0].debit_amount).toBe(800.54)

    const debit2641 = findByAccount(input.lines, '2641')
    expect(debit2641).toHaveLength(1)
    expect(debit2641[0].debit_amount).toBe(200.14)

    // 2440 must reflect the TRUE gross total (800.54 + 200.14), not the stale
    // header total: the engine derives it as totalDebits - totalCredits.
    const credit2440 = findByAccount(input.lines, '2440')
    expect(credit2440[0].credit_amount).toBe(1000.68)

    assertBalanced(input)
  })

  it('aggregates manual VAT overrides per rate group on mixed-rate invoice', async () => {
    // Restaurangkvitto med två olika momsöverskridningar pga representation-
    // tak och egen avrundning. 25%-raden får manuell 100 kr, 12%-raden får
    // manuell 50 kr.
    const invoice = makeSupplierInvoice({
      subtotal: 1000,
      vat_amount: 150,
      total: 1150,
    })
    const items = [
      makeItem({ id: 'item-1', line_total: 400, account_number: '6071', vat_rate: 0.25, vat_amount: 100 }),
      makeItem({ id: 'item-2', line_total: 600, account_number: '6071', vat_rate: 0.12, vat_amount: 50 }),
    ]

    await createSupplierInvoiceRegistrationEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'swedish_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    const vat2641 = findByAccount(input.lines, '2641')
    expect(vat2641).toHaveLength(2)
    expect(vat2641.find((l) => l.line_description?.includes('25%'))?.debit_amount).toBe(100)
    expect(vat2641.find((l) => l.line_description?.includes('12%'))?.debit_amount).toBe(50)

    assertBalanced(input)
  })

  it('reverse charge ignores manual vat_amount and uses statutory base × rate', async () => {
    // RC: fiktiv moms beräknas alltid på basbeloppet med lagstadgad sats:
    // ett manuellt vat_amount på posten är meningslöst (köparen redovisar
    // själv) och får inte påverka 2645/2614.
    const invoice = makeSupplierInvoice({
      subtotal: 10000,
      vat_amount: 0,
      total: 10000,
      reverse_charge: true,
    })
    const items = [
      makeItem({
        line_total: 10000,
        account_number: '6540',
        vat_rate: 0.25,
        vat_amount: 999, // ska ignoreras
      }),
    ]

    await createSupplierInvoiceRegistrationEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'eu_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(findByAccount(input.lines, '2645')[0].debit_amount).toBe(2500)
    expect(findByAccount(input.lines, '2614')[0].credit_amount).toBe(2500)
    assertBalanced(input)
  })

  it('creates domestic entry with zero VAT (no 2641 line)', async () => {
    const invoice = makeSupplierInvoice({
      subtotal: 5000,
      vat_amount: 0,
      total: 5000,
    })
    const items = [makeItem({ line_total: 5000, account_number: '5410', vat_rate: 0 })]

    await createSupplierInvoiceRegistrationEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'swedish_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]

    const debit5410 = findByAccount(input.lines, '5410')
    expect(debit5410).toHaveLength(1)
    expect(debit5410[0].debit_amount).toBe(5000)

    const credit2440 = findByAccount(input.lines, '2440')
    expect(credit2440[0].credit_amount).toBe(5000)

    expect(findByAccount(input.lines, '2641')).toHaveLength(0)

    assertBalanced(input)
  })

  it('creates EU reverse charge entry at 25% with basbelopp on 4535 (ruta 21)', async () => {
    const invoice = makeSupplierInvoice({
      subtotal: 10000,
      vat_amount: 0,
      total: 10000,
      reverse_charge: true,
    })
    const items = [makeItem({ line_total: 10000, account_number: '6540', vat_rate: 0.25 })]

    await createSupplierInvoiceRegistrationEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'eu_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]

    const debit6540 = findByAccount(input.lines, '6540')
    expect(debit6540[0].debit_amount).toBe(10000)

    const debit2645 = findByAccount(input.lines, '2645')
    expect(debit2645).toHaveLength(1)
    expect(debit2645[0].debit_amount).toBe(2500) // 10000 * 0.25

    const credit2614 = findByAccount(input.lines, '2614')
    expect(credit2614).toHaveLength(1)
    expect(credit2614[0].credit_amount).toBe(2500)

    // Basbeloppsrader för ruta 21 (EU tjänster huvudregeln): utan dessa
    // avvisar Skatteverket deklarationen med FK004.
    const debit4535 = findByAccount(input.lines, '4535')
    expect(debit4535).toHaveLength(1)
    expect(debit4535[0].debit_amount).toBe(10000)

    const credit4598 = findByAccount(input.lines, '4598')
    expect(credit4598).toHaveLength(1)
    expect(credit4598[0].credit_amount).toBe(10000)

    const credit2440 = findByAccount(input.lines, '2440')
    // 2440 = totalDebits - totalCredits.
    // Debit:  6540 (10 000) + 2645 (2 500) + 4535 (10 000) = 22 500
    // Credit: 2614 (2 500) + 4598 (10 000)               = 12 500
    // 2440  = 22 500 - 12 500 = 10 000 (faktisk leverantörsskuld)
    expect(credit2440[0].credit_amount).toBe(10000)

    assertBalanced(input)
  })

  // crm#1096: an item on a cost account whose momskod in the kontoplan is a
  // reverse-charge purchase already reports ruta 20-24 itself (the
  // declaration reads the chart's momskoder), so a 45xx/4598 pair on top of it
  // counted the purchase twice and broke the per-rate basis/moms identity.
  it('books no basis pair for an item on an account whose momskod reports ruta 20-24 (crm#1096)', async () => {
    mockFetchChartVatTreatments.mockResolvedValueOnce(momskoder({ '4056': 'reverse_charge_eu_goods' }))
    const invoice = makeSupplierInvoice({ subtotal: 10000, vat_amount: 0, total: 10000, reverse_charge: true })
    const items = [makeItem({ line_total: 10000, account_number: '4056', vat_rate: 0 })]

    await createSupplierInvoiceRegistrationEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'eu_business'
    )

    expect(mockFetchChartVatTreatments).toHaveBeenCalledWith(null, 'company-1')
    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.lines.map((l: CreateJournalEntryLineInput) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['4056', 10000, 0],
      ['2645', 2500, 0],
      ['2614', 0, 2500],
      ['2440', 0, 10000],
    ])
    assertBalanced(input)
  })

  it('books the basis pair only for the items on accounts that report nothing themselves (crm#1096)', async () => {
    mockFetchChartVatTreatments.mockResolvedValueOnce(momskoder({ '4056': 'reverse_charge_eu_goods' }))
    const invoice = makeSupplierInvoice({ subtotal: 10000, vat_amount: 0, total: 10000, reverse_charge: true })
    const items = [
      makeItem({ id: 'i1', line_total: 6000, account_number: '4056', vat_rate: 0 }),
      makeItem({ id: 'i2', line_total: 4000, account_number: '6540', vat_rate: 0 }),
    ]

    await createSupplierInvoiceRegistrationEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'eu_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    // Fiktiv moms on the whole purchase, basis pair on the 6540 part only:
    // ruta 20 gets 6 000 from 4056, ruta 21 gets 4 000 from 4535.
    expect(findByAccount(input.lines, '2645')[0].debit_amount).toBe(2500)
    expect(findByAccount(input.lines, '2614')[0].credit_amount).toBe(2500)
    expect(findByAccount(input.lines, '4535')[0].debit_amount).toBe(4000)
    expect(findByAccount(input.lines, '4598')[0].credit_amount).toBe(4000)
    expect(findByAccount(input.lines, '2440')[0].credit_amount).toBe(10000)
    assertBalanced(input)
  })

  it('self-assesses an item on an account at 12 % at that sats, where the declaration buckets its basis (crm#1096)', async () => {
    mockFetchChartVatTreatments.mockResolvedValueOnce(momskoder({ '4057': ['reverse_charge_eu_goods', 0.12] }))
    const invoice = makeSupplierInvoice({ subtotal: 10000, vat_amount: 0, total: 10000, reverse_charge: true })
    const items = [
      // The form's reverse-charge rate defaults to 25 %; the account says 12 %.
      makeItem({ id: 'i1', line_total: 6000, account_number: '4057', vat_rate: 0, reverse_charge_rate: 0.25 }),
      makeItem({ id: 'i2', line_total: 4000, account_number: '6540', vat_rate: 0 }),
    ]

    await createSupplierInvoiceRegistrationEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'eu_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.lines.map((l: CreateJournalEntryLineInput) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['4057', 6000, 0],
      ['6540', 4000, 0],
      ['2645', 720, 0],
      ['2624', 0, 720],
      ['2645', 1000, 0],
      ['2614', 0, 1000],
      ['4535', 4000, 0],
      ['4598', 0, 4000],
      ['2440', 0, 10000],
    ])
    assertBalanced(input)
  })

  it('keeps the basis pair for a periodiserad item, whose net sits on the 17xx interim account (crm#1096)', async () => {
    mockFetchChartVatTreatments.mockResolvedValueOnce(momskoder({ '6540': 'reverse_charge_eu_services' }))
    const invoice = makeSupplierInvoice({ subtotal: 12000, vat_amount: 0, total: 12000, reverse_charge: true })
    const items = [makeItem({
      line_total: 12000, account_number: '6540', vat_rate: 0,
      accrual_period_start: '2024-07-01', accrual_period_end: '2025-06-30', accrual_balance_account: '1790',
    })]

    await createSupplierInvoiceRegistrationEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'eu_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.lines.map((l: CreateJournalEntryLineInput) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['1790', 12000, 0],
      ['2645', 3000, 0],
      ['2614', 0, 3000],
      ['4535', 12000, 0],
      ['4598', 0, 12000],
      ['2440', 0, 12000],
    ])
    assertBalanced(input)
  })

  it('reads no momskoder for an invoice without reverse charge', async () => {
    const invoice = makeSupplierInvoice()
    await createSupplierInvoiceRegistrationEntry(
      null as never, 'company-1', 'user-1', invoice, [makeItem()], 'swedish_business'
    )
    expect(mockFetchChartVatTreatments).not.toHaveBeenCalled()
  })

  it('books reverse charge VAT for a 0%-rate line item: defaults to 25% huvudregeln (regression)', async () => {
    // The exact reported bug: a Finnish (EU) supplier invoice entered with the
    // line at 0% momssats (the supplier charges no VAT) must still self-assess
    // at 25%. Before the fix the `rate > 0` guard skipped ALL VAT lines, so the
    // verifikat was just expense + 2440: the user had to add VAT lines by hand.
    const invoice = makeSupplierInvoice({
      subtotal: 12000,
      vat_amount: 0,
      total: 12000,
      reverse_charge: true,
    })
    const items = [makeItem({ line_total: 12000, account_number: '5910', vat_rate: 0, reverse_charge_rate: null })]

    await createSupplierInvoiceRegistrationEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'eu_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(findByAccount(input.lines, '5910')[0].debit_amount).toBe(12000)
    // Fiktiv moms self-assessed at the 25% huvudregel default (ruta 30 / 48).
    expect(findByAccount(input.lines, '2645')[0].debit_amount).toBe(3000)
    expect(findByAccount(input.lines, '2614')[0].credit_amount).toBe(3000)
    // Basbeloppsrader for ruta 21 (EU services): required or SKV rejects FK004.
    expect(findByAccount(input.lines, '4535')[0].debit_amount).toBe(12000)
    expect(findByAccount(input.lines, '4598')[0].credit_amount).toBe(12000)
    // Leverantörsskuld is the net (no VAT rolls into the payable under RC).
    expect(findByAccount(input.lines, '2440')[0].credit_amount).toBe(12000)
    assertBalanced(input)
  })

  it('honours an explicit reverse_charge_rate (12%) on a 0%-rate line item', async () => {
    const invoice = makeSupplierInvoice({
      subtotal: 10000, vat_amount: 0, total: 10000, reverse_charge: true,
    })
    const items = [makeItem({ line_total: 10000, account_number: '6540', vat_rate: 0, reverse_charge_rate: 0.12 })]

    await createSupplierInvoiceRegistrationEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'eu_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(findByAccount(input.lines, '2645')[0].debit_amount).toBe(1200) // 10000 * 0.12
    expect(findByAccount(input.lines, '2624')[0].credit_amount).toBe(1200) // ruta 31
    expect(findByAccount(input.lines, '4536')[0].debit_amount).toBe(10000) // ruta 21 @ 12%
    // 25% accounts must NOT appear when the self-assessed rate is 12%.
    expect(findByAccount(input.lines, '2614')).toHaveLength(0)
    expect(findByAccount(input.lines, '4535')).toHaveLength(0)
    assertBalanced(input)
  })

  it('honours an explicit reverse_charge_rate (6%) on a 0%-rate line item', async () => {
    const invoice = makeSupplierInvoice({
      subtotal: 10000, vat_amount: 0, total: 10000, reverse_charge: true,
    })
    const items = [makeItem({ line_total: 10000, account_number: '6540', vat_rate: 0, reverse_charge_rate: 0.06 })]

    await createSupplierInvoiceRegistrationEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'eu_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(findByAccount(input.lines, '2645')[0].debit_amount).toBe(600) // 10000 * 0.06
    expect(findByAccount(input.lines, '2634')[0].credit_amount).toBe(600) // ruta 32
    expect(findByAccount(input.lines, '4537')[0].debit_amount).toBe(10000) // ruta 21 @ 6%
    // Higher-rate accounts must NOT appear when the self-assessed rate is 6%.
    expect(findByAccount(input.lines, '2614')).toHaveLength(0)
    expect(findByAccount(input.lines, '2624')).toHaveLength(0)
    expect(findByAccount(input.lines, '4535')).toHaveLength(0)
    expect(findByAccount(input.lines, '4536')).toHaveLength(0)
    assertBalanced(input)
  })

  it('books non-EU services to 4531 (ruta 22) and motkonto 4598', async () => {
    const invoice = makeSupplierInvoice({
      subtotal: 8000,
      vat_amount: 0,
      total: 8000,
      reverse_charge: true,
    })
    const items = [makeItem({ line_total: 8000, account_number: '6540', vat_rate: 0.25 })]

    await createSupplierInvoiceRegistrationEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'non_eu_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]

    expect(findByAccount(input.lines, '4531')[0].debit_amount).toBe(8000)
    expect(findByAccount(input.lines, '4598')[0].credit_amount).toBe(8000)
    // No EU-services account when supplier is non-EU
    expect(findByAccount(input.lines, '4535')).toHaveLength(0)

    assertBalanced(input)
  })

  it('books domestic RC services to 4425 (ruta 24) and motkonto 4598', async () => {
    const invoice = makeSupplierInvoice({
      subtotal: 20000,
      vat_amount: 0,
      total: 20000,
      reverse_charge: true,
    })
    const items = [makeItem({ line_total: 20000, account_number: '4170', vat_rate: 0.25 })]

    await createSupplierInvoiceRegistrationEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'swedish_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]

    expect(findByAccount(input.lines, '4425')[0].debit_amount).toBe(20000)
    expect(findByAccount(input.lines, '4598')[0].credit_amount).toBe(20000)
    // Domestic RC uses 2647, not 2645
    expect(findByAccount(input.lines, '2647')[0].debit_amount).toBe(5000)
    expect(findByAccount(input.lines, '2614')[0].credit_amount).toBe(5000)
    expect(findByAccount(input.lines, '4535')).toHaveLength(0)

    assertBalanced(input)
  })

  it('creates EU reverse charge entry at reduced 12%', async () => {
    const invoice = makeSupplierInvoice({
      subtotal: 5000,
      vat_amount: 0,
      total: 5000,
      reverse_charge: true,
    })
    const items = [makeItem({ line_total: 5000, account_number: '6540', vat_rate: 0.12 })]

    await createSupplierInvoiceRegistrationEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'eu_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]

    const debit2645 = findByAccount(input.lines, '2645')
    expect(debit2645[0].debit_amount).toBe(600) // 5000 * 0.12

    const credit2624 = findByAccount(input.lines, '2624')
    expect(credit2624).toHaveLength(1)
    expect(credit2624[0].credit_amount).toBe(600)

    // 12%-raden går till 4536 (EU tjänster 12%)
    expect(findByAccount(input.lines, '4536')[0].debit_amount).toBe(5000)
    expect(findByAccount(input.lines, '4598')[0].credit_amount).toBe(5000)

    assertBalanced(input)
  })

  it('handles multi-item with different accounts', async () => {
    const invoice = makeSupplierInvoice({
      subtotal: 8000,
      vat_amount: 2000,
      total: 10000,
    })
    const items = [
      makeItem({ id: 'item-1', line_total: 3000, account_number: '5410', vat_rate: 0.25 }),
      makeItem({ id: 'item-2', line_total: 5000, account_number: '6200', vat_rate: 0.25 }),
    ]

    await createSupplierInvoiceRegistrationEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'swedish_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]

    const debit5410 = findByAccount(input.lines, '5410')
    expect(debit5410[0].debit_amount).toBe(3000)

    const debit6200 = findByAccount(input.lines, '6200')
    expect(debit6200[0].debit_amount).toBe(5000)

    const debit2641 = findByAccount(input.lines, '2641')
    expect(debit2641[0].debit_amount).toBe(2000) // (3000 + 5000) * 0.25

    assertBalanced(input)
  })

  it('aggregates multi-item with same account', async () => {
    const invoice = makeSupplierInvoice({
      subtotal: 5000,
      vat_amount: 1250,
      total: 6250,
    })
    const items = [
      makeItem({ id: 'item-1', line_total: 3000, account_number: '6200', vat_rate: 0.25 }),
      makeItem({ id: 'item-2', line_total: 2000, account_number: '6200', vat_rate: 0.25 }),
    ]

    await createSupplierInvoiceRegistrationEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'swedish_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]

    const lines6200 = findByAccount(input.lines, '6200')
    expect(lines6200).toHaveLength(1)
    expect(lines6200[0].debit_amount).toBe(5000) // 3000 + 2000

    assertBalanced(input)
  })

  it('creates per-rate 2641 lines for mixed-rate domestic invoice', async () => {
    const invoice = makeSupplierInvoice({
      subtotal: 18000,
      vat_amount: 3280,
      total: 21280,
    })
    const items = [
      makeItem({ id: 'item-1', account_number: '4010', line_total: 10000, vat_rate: 0.25 }),
      makeItem({ id: 'item-2', account_number: '5410', line_total: 5000, vat_rate: 0.12 }),
      makeItem({ id: 'item-3', account_number: '6200', line_total: 3000, vat_rate: 0.06 }),
    ]

    await createSupplierInvoiceRegistrationEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'swedish_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    const vat2641 = findByAccount(input.lines, '2641')
    expect(vat2641).toHaveLength(3)

    // 25%: 10000 * 0.25 = 2500
    expect(vat2641.find((l) => l.line_description?.includes('25%'))?.debit_amount).toBe(2500)
    // 12%: 5000 * 0.12 = 600
    expect(vat2641.find((l) => l.line_description?.includes('12%'))?.debit_amount).toBe(600)
    // 6%: 3000 * 0.06 = 180
    expect(vat2641.find((l) => l.line_description?.includes('6%'))?.debit_amount).toBe(180)

    assertBalanced(input)
  })

  it('adds foreign currency metadata on 2440 line', async () => {
    const invoice = makeSupplierInvoice({
      currency: 'EUR',
      exchange_rate: 11.50,
      subtotal: 800,
      vat_amount: 0,
      total: 800,
    })
    const items = [makeItem({ line_total: 800, account_number: '6200', vat_rate: 0 })]

    await createSupplierInvoiceRegistrationEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'swedish_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    const credit2440 = findByAccount(input.lines, '2440')[0]
    expect(credit2440.currency).toBe('EUR')
    expect(credit2440.amount_in_currency).toBe(800)
    expect(credit2440.exchange_rate).toBe(11.50)
  })

  it('sets source_type to supplier_invoice_registered', async () => {
    const invoice = makeSupplierInvoice({ id: 'si-xyz' })
    const items = [makeItem()]

    await createSupplierInvoiceRegistrationEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'swedish_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.source_type).toBe('supplier_invoice_registered')
    expect(input.source_id).toBe('si-xyz')
  })

  it('description includes invoice number and arrival number', async () => {
    const invoice = makeSupplierInvoice({
      supplier_invoice_number: 'LF-999',
      arrival_number: 42,
    })
    const items = [makeItem()]

    await createSupplierInvoiceRegistrationEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'swedish_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.description).toContain('LF-999')
    expect(input.description).toContain('42')
  })

  it('description includes supplier name when provided', async () => {
    const invoice = makeSupplierInvoice({
      supplier_invoice_number: 'LF-100',
      arrival_number: 5,
    })
    const items = [makeItem()]

    await createSupplierInvoiceRegistrationEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'swedish_business', 'Leverantör AB'
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.description).toBe('Leverantörsfaktura LF-100, Leverantör AB (ankomstnr 5)')
  })

  it('description falls back without supplier name', async () => {
    const invoice = makeSupplierInvoice({
      supplier_invoice_number: 'LF-100',
      arrival_number: 5,
    })
    const items = [makeItem()]

    await createSupplierInvoiceRegistrationEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'swedish_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.description).toBe('Leverantörsfaktura LF-100 (ankomstnr 5)')
  })

  it('leaves a missing supplier number out of the verifikat text (crm#1039)', async () => {
    const invoice = makeSupplierInvoice({ supplier_invoice_number: null, arrival_number: 5 })
    const items = [makeItem()]

    await createSupplierInvoiceRegistrationEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'swedish_business', 'Leverantör AB'
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.description).toBe('Leverantörsfaktura, Leverantör AB (ankomstnr 5)')
    expect(input.description).not.toContain('null')
  })

  it('handles non-EU reverse charge (services)', async () => {
    const invoice = makeSupplierInvoice({
      subtotal: 5000,
      vat_amount: 0,
      total: 5000,
      reverse_charge: true,
    })
    const items = [makeItem({ line_total: 5000, vat_rate: 0.25, account_number: '6540' })]

    await createSupplierInvoiceRegistrationEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'non_eu_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]

    expect(findByAccount(input.lines, '2645')).toHaveLength(1)
    expect(findByAccount(input.lines, '2614')).toHaveLength(1)
    expect(findByAccount(input.lines, '2641')).toHaveLength(0)

    assertBalanced(input)
  })

  it('creates domestic reverse charge entry using 2647 (byggtjänster etc.)', async () => {
    const invoice = makeSupplierInvoice({
      subtotal: 20000,
      vat_amount: 0,
      total: 20000,
      reverse_charge: true,
    })
    const items = [makeItem({ line_total: 20000, vat_rate: 0.25, account_number: '4425' })]

    await createSupplierInvoiceRegistrationEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'swedish_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]

    // Domestic RC uses 2647 (not 2645) for input VAT
    const debit2647 = findByAccount(input.lines, '2647')
    expect(debit2647).toHaveLength(1)
    expect(debit2647[0].debit_amount).toBe(5000) // 20000 * 0.25

    const credit2614 = findByAccount(input.lines, '2614')
    expect(credit2614).toHaveLength(1)
    expect(credit2614[0].credit_amount).toBe(5000)

    // No EU reverse charge account used
    expect(findByAccount(input.lines, '2645')).toHaveLength(0)
    // No regular input VAT
    expect(findByAccount(input.lines, '2641')).toHaveLength(0)

    // User picked 4425 directly as the expense account, so the engine must
    // not add parallel basbeloppsrader on 4425/4598: that would double the
    // basis. Exactly one 4425 line (the user's expense) and zero 4598.
    expect(findByAccount(input.lines, '4425')).toHaveLength(1)
    expect(findByAccount(input.lines, '4425')[0].debit_amount).toBe(20000)
    expect(findByAccount(input.lines, '4598')).toHaveLength(0)

    // 2440 = expense only (RC is offsetting)
    const credit2440 = findByAccount(input.lines, '2440')
    expect(credit2440[0].credit_amount).toBe(20000)

    assertBalanced(input)
  })

  it('does NOT create RC entry for swedish_business when reverse_charge is false', async () => {
    const invoice = makeSupplierInvoice({
      subtotal: 8000,
      vat_amount: 2000,
      total: 10000,
      reverse_charge: false,
    })
    const items = [makeItem({ line_total: 8000, vat_rate: 0.25, account_number: '4010' })]

    await createSupplierInvoiceRegistrationEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'swedish_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]

    // Should use standard domestic path with 2641
    expect(findByAccount(input.lines, '2641')).toHaveLength(1)
    expect(findByAccount(input.lines, '2647')).toHaveLength(0)
    expect(findByAccount(input.lines, '2645')).toHaveLength(0)
    expect(findByAccount(input.lines, '2614')).toHaveLength(0)

    assertBalanced(input)
  })

  it('creates per-rate 2645/26x4 pairs for mixed-rate reverse charge', async () => {
    const invoice = makeSupplierInvoice({
      subtotal: 15000,
      vat_amount: 0,
      total: 15000,
      reverse_charge: true,
    })
    const items = [
      makeItem({ line_total: 10000, vat_rate: 0.25, account_number: '6540' }),
      makeItem({ id: 'item-2', line_total: 5000, vat_rate: 0.12, account_number: '5410' }),
    ]

    await createSupplierInvoiceRegistrationEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'eu_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]

    const vat2645 = findByAccount(input.lines, '2645')
    expect(vat2645).toHaveLength(2)

    // 25%: 2614
    expect(findByAccount(input.lines, '2614')[0].credit_amount).toBe(2500)
    // 12%: 2624
    expect(findByAccount(input.lines, '2624')[0].credit_amount).toBe(600)

    assertBalanced(input)
  })
})

// ============================================================
// Foreign currency without an exchange rate: must fail loudly
// ============================================================

describe('supplier invoice booking: foreign currency without an exchange rate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedFindFiscalPeriod.mockResolvedValue('period-1')
  })

  // The 99% path: a SEK invoice never touches the FX guard.
  it('SEK reverse-charge invoice is unaffected (no rate needed)', async () => {
    const invoice = makeSupplierInvoice({
      subtotal: 10000, vat_amount: 0, total: 10000,
      currency: 'SEK', exchange_rate: null, reverse_charge: true,
    })
    const items = [makeItem({ line_total: 10000, vat_rate: 0.25, account_number: '6540' })]

    await createSupplierInvoiceRegistrationEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'eu_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(findByAccount(input.lines, '2645')[0].debit_amount).toBe(2500)
    expect(findByAccount(input.lines, '2614')[0].credit_amount).toBe(2500)
    assertBalanced(input)
  })

  // 1000 EUR at 11,50 SEK/EUR: fiktiv moms is 11 500 × 25% = 2 875,00 kr on
  // 2614 (ruta 30) / 2645 (ruta 48), and the basbelopp on 4535 is 11 500
  // (ruta 21). Not 250,00 kr and 1 000.
  it('EUR reverse-charge invoice WITH a rate books fiktiv moms in SEK', async () => {
    const invoice = makeSupplierInvoice({
      subtotal: 1000, vat_amount: 0, total: 1000,
      currency: 'EUR', exchange_rate: 11.50, reverse_charge: true,
    })
    const items = [makeItem({ line_total: 1000, vat_rate: 0.25, account_number: '6540' })]

    await createSupplierInvoiceRegistrationEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'eu_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(findByAccount(input.lines, '6540')[0].debit_amount).toBe(11500)
    expect(findByAccount(input.lines, '2645')[0].debit_amount).toBe(2875)
    expect(findByAccount(input.lines, '2614')[0].credit_amount).toBe(2875)
    expect(findByAccount(input.lines, '4535')[0].debit_amount).toBe(11500)
    expect(findByAccount(input.lines, '2440')[0].credit_amount).toBe(11500)
    assertBalanced(input)
  })

  it('EUR reverse-charge invoice WITHOUT a rate throws instead of booking 1:1', async () => {
    const invoice = makeSupplierInvoice({
      subtotal: 1000, vat_amount: 0, total: 1000,
      currency: 'EUR', exchange_rate: null, reverse_charge: true,
    })
    const items = [makeItem({ line_total: 1000, vat_rate: 0.25, account_number: '6540' })]

    await expect(
      createSupplierInvoiceRegistrationEntry(
        null as never, 'company-1', 'user-1', invoice, items, 'eu_business'
      )
    ).rejects.toThrow(SupplierInvoiceFxRateMissingError)

    // No verifikat at all: a wrong one would balance and pass every trigger.
    expect(mockedCreateEntry).not.toHaveBeenCalled()
  })

  it('the thrown error carries the structured code and the currency', async () => {
    const invoice = makeSupplierInvoice({
      subtotal: 1000, vat_amount: 0, total: 1000,
      currency: 'EUR', exchange_rate: null, reverse_charge: true,
    })
    const items = [makeItem({ line_total: 1000, vat_rate: 0.25, account_number: '6540' })]

    const err = await createSupplierInvoiceRegistrationEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'eu_business'
    ).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(SupplierInvoiceFxRateMissingError)
    const fxErr = err as { code?: string; currency?: string }
    expect(fxErr.code).toBe('SI_FX_RATE_MISSING')
    expect(fxErr.currency).toBe('EUR')
    // Registered in the canonical registry so routes/MCP render Swedish.
    expect(getErrorEntry('SI_FX_RATE_MISSING')?.httpStatus).toBe(400)
    expect(getErrorMessage(err)).toMatch(/saknar växelkurs/i)
  })

  // Domestic-VAT path (2641 / ruta 48) has the same exposure.
  it('EUR domestic-VAT invoice WITHOUT a rate throws instead of booking 1:1', async () => {
    const invoice = makeSupplierInvoice({
      subtotal: 1000, vat_amount: 250, total: 1250,
      currency: 'EUR', exchange_rate: null,
    })
    const items = [makeItem({ line_total: 1000, vat_rate: 0.25, account_number: '6200' })]

    await expect(
      createSupplierInvoiceRegistrationEntry(
        null as never, 'company-1', 'user-1', invoice, items, 'swedish_business'
      )
    ).rejects.toThrow(SupplierInvoiceFxRateMissingError)
    expect(mockedCreateEntry).not.toHaveBeenCalled()
  })

  it('kontantmetoden without a rate throws, but a settlement-derived rate still books', async () => {
    const invoice = makeSupplierInvoice({
      subtotal: 1000, vat_amount: 0, total: 1000,
      currency: 'EUR', exchange_rate: null, reverse_charge: true,
    })
    const items = [makeItem({ line_total: 1000, vat_rate: 0.25, account_number: '6540' })]

    await expect(
      createSupplierInvoiceCashEntry(
        null as never, 'company-1', 'user-1', invoice, items, '2024-07-01', 'eu_business'
      , undefined, '1930')
    ).rejects.toThrow(SupplierInvoiceFxRateMissingError)
    expect(mockedCreateEntry).not.toHaveBeenCalled()

    // settledBankSek pins the payment-date rate (11 500 / 1 000 = 11.50),
    // so the same invoice books correctly through the cash path.
    await createSupplierInvoiceCashEntry(
      null as never, 'company-1', 'user-1', invoice, items, '2024-07-01', 'eu_business',
      undefined, '1930', 11500
    )
    const input = mockedCreateEntry.mock.calls[0][3]
    expect(findByAccount(input.lines, '2614')[0].credit_amount).toBe(2875)
    assertBalanced(input)
  })

  it('credit note in EUR WITHOUT a rate throws instead of reversing 1:1', async () => {
    const creditNote = makeSupplierInvoice({
      subtotal: 1000, vat_amount: 0, total: 1000,
      currency: 'EUR', exchange_rate: null, reverse_charge: true, is_credit_note: true,
    })
    const items = [makeItem({ line_total: 1000, vat_rate: 0.25, account_number: '6540' })]

    await expect(
      createSupplierCreditNoteEntry(
        null as never, 'company-1', 'user-1', creditNote, items, 'eu_business'
      )
    ).rejects.toThrow(SupplierInvoiceFxRateMissingError)
    expect(mockedCreateEntry).not.toHaveBeenCalled()
  })
})

// ============================================================
// createSupplierInvoicePaymentEntry
// ============================================================

describe('createSupplierInvoicePaymentEntry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedFindFiscalPeriod.mockResolvedValue('period-1')
  })

  it('returns null when no fiscal period found', async () => {
    mockedFindFiscalPeriod.mockResolvedValue(null)
    const invoice = makeSupplierInvoice()

    const result = await createSupplierInvoicePaymentEntry(
      null as never, 'company-1', 'user-1', invoice, 10000, '2024-07-01'
    , undefined, undefined, '1930')

    expect(result).toBeNull()
    expect(mockedCreateEntry).not.toHaveBeenCalled()
  })

  it('creates standard SEK payment (2 lines)', async () => {
    const invoice = makeSupplierInvoice({ total: 10000 })

    await createSupplierInvoicePaymentEntry(
      null as never, 'company-1', 'user-1', invoice, 10000, '2024-07-01'
    , undefined, undefined, '1930')

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.lines).toHaveLength(2)

    const debit2440 = findByAccount(input.lines, '2440')[0]
    expect(debit2440.debit_amount).toBe(10000)

    const credit1930 = findByAccount(input.lines, '1930')[0]
    expect(credit1930.credit_amount).toBe(10000)

    assertBalanced(input)
  })

  it('creates entry with FX gain (credit 3960)', async () => {
    const invoice = makeSupplierInvoice({ total: 11500, currency: 'EUR' })

    // paymentAmount = original SEK amount, exchangeRateDifference > 0 = gain
    await createSupplierInvoicePaymentEntry(
      null as never, 'company-1', 'user-1', invoice, 11500, '2024-07-15', 500
    , undefined, '1930')

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.lines).toHaveLength(3)

    const debit2440 = findByAccount(input.lines, '2440')[0]
    expect(debit2440.debit_amount).toBe(11500)

    const credit1930 = findByAccount(input.lines, '1930')[0]
    expect(credit1930.credit_amount).toBe(11000) // 11500 - 500

    const credit3960 = findByAccount(input.lines, '3960')[0]
    expect(credit3960.credit_amount).toBe(500)

    assertBalanced(input)
  })

  it('creates entry with FX loss (debit 7960)', async () => {
    const invoice = makeSupplierInvoice({ total: 11500, currency: 'EUR' })

    // exchangeRateDifference < 0 = loss
    await createSupplierInvoicePaymentEntry(
      null as never, 'company-1', 'user-1', invoice, 11500, '2024-07-15', -300
    , undefined, '1930')

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.lines).toHaveLength(3)

    const debit2440 = findByAccount(input.lines, '2440')[0]
    expect(debit2440.debit_amount).toBe(11500)

    const credit1930 = findByAccount(input.lines, '1930')[0]
    expect(credit1930.credit_amount).toBe(11800) // 11500 - (-300)

    const debit7960 = findByAccount(input.lines, '7960')[0]
    expect(debit7960.debit_amount).toBe(300)

    assertBalanced(input)
  })

  it('exchangeRateDifference=0 creates standard 2-line entry', async () => {
    const invoice = makeSupplierInvoice()

    await createSupplierInvoicePaymentEntry(
      null as never, 'company-1', 'user-1', invoice, 10000, '2024-07-01', 0
    , undefined, '1930')

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.lines).toHaveLength(2)

    expect(findByAccount(input.lines, '3960')).toHaveLength(0)
    expect(findByAccount(input.lines, '7960')).toHaveLength(0)

    assertBalanced(input)
  })

  it('rounds amounts to 2 decimal places', async () => {
    const invoice = makeSupplierInvoice()

    await createSupplierInvoicePaymentEntry(
      null as never, 'company-1', 'user-1', invoice, 10000.555, '2024-07-01'
    , undefined, undefined, '1930')

    const input = mockedCreateEntry.mock.calls[0][3]
    for (const line of input.lines) {
      if (line.debit_amount > 0) {
        expect(line.debit_amount).toBe(Math.round(10000.555 * 100) / 100)
      }
      if (line.credit_amount > 0) {
        expect(line.credit_amount).toBe(Math.round(10000.555 * 100) / 100)
      }
    }
  })

  it('sets source_type to supplier_invoice_paid', async () => {
    const invoice = makeSupplierInvoice({ id: 'si-pay-1' })

    await createSupplierInvoicePaymentEntry(
      null as never, 'company-1', 'user-1', invoice, 10000, '2024-07-01'
    , undefined, undefined, '1930')

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.source_type).toBe('supplier_invoice_paid')
    expect(input.source_id).toBe('si-pay-1')
  })

  it('description includes supplier name when provided', async () => {
    const invoice = makeSupplierInvoice({
      supplier_invoice_number: 'LF-200',
      arrival_number: 10,
    })

    await createSupplierInvoicePaymentEntry(
      null as never, 'company-1', 'user-1', invoice, 10000, '2024-07-01', undefined, 'Leverantör AB'
    , '1930')

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.description).toBe('Utbetalning leverantörsfaktura LF-200, Leverantör AB (ankomstnr 10)')
  })

  it('credits the provided paymentAccount instead of 1930', async () => {
    const invoice = makeSupplierInvoice()

    await createSupplierInvoicePaymentEntry(
      null as never, 'company-1', 'user-1', invoice, 10000, '2024-07-01',
      undefined, undefined, '1940'
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(findByAccount(input.lines, '1930')).toHaveLength(0)
    expect(findByAccount(input.lines, '1940')[0].credit_amount).toBe(10000)
  })

  it('falls back to 1930 when paymentAccount is undefined', async () => {
    const invoice = makeSupplierInvoice()

    await createSupplierInvoicePaymentEntry(
      null as never, 'company-1', 'user-1', invoice, 10000, '2024-07-01'
    , undefined, undefined, '1930')

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(findByAccount(input.lines, '1930')[0].credit_amount).toBe(10000)
  })

  it('uses paymentAccount on the FX-difference branch too', async () => {
    const invoice = makeSupplierInvoice({ total: 11500, currency: 'EUR' })

    await createSupplierInvoicePaymentEntry(
      null as never, 'company-1', 'user-1', invoice, 11500, '2024-07-15',
      500, undefined, '2018'
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(findByAccount(input.lines, '1930')).toHaveLength(0)
    expect(findByAccount(input.lines, '2018')[0].credit_amount).toBe(11000)
  })

  it('uses paymentDate not invoice_date as entry_date', async () => {
    const invoice = makeSupplierInvoice({ invoice_date: '2024-06-01' })

    await createSupplierInvoicePaymentEntry(
      null as never, 'company-1', 'user-1', invoice, 10000, '2024-08-15'
    , undefined, undefined, '1930')

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.entry_date).toBe('2024-08-15')
  })

  describe('SEK clearing of a matched bank row (sekClearingDebt)', () => {
    const BAG = { '6': 'P1', '1': 'KS1' }

    it('books the match preview builder lines: 2440 cleared in full, the öre on 3740, every leg tagged', async () => {
      const invoice = makeSupplierInvoice({ total: 11231.25, default_dimensions: BAG })

      await createSupplierInvoicePaymentEntry(
        null as never, 'company-1', 'user-1', invoice, 11231, '2024-07-01',
        undefined, undefined, '1930', undefined, undefined, 11231.25,
      )

      const input = mockedCreateEntry.mock.calls[0][3]
      const preview = buildSupplierPaymentClearingLines({
        apSek: 11231.25, bankSek: 11231, paymentAccount: '1930',
      }).lines
      expect(input.lines).toEqual(preview.map((line) => ({ ...line, dimensions: BAG })))
      expect(findByAccount(input.lines, '3740')[0].credit_amount).toBe(0.25)
      assertBalanced(input)
      // One bag object per line: a shared object would let one line's edit
      // leak into every other line.
      expect(new Set(input.lines.map((line) => line.dimensions)).size).toBe(input.lines.length)
    })

    it('books a bank fee exactly once, tagged like the rest', async () => {
      const invoice = makeSupplierInvoice({ total: 1000, default_dimensions: BAG })

      await createSupplierInvoicePaymentEntry(
        null as never, 'company-1', 'user-1', invoice, 1000, '2024-07-01',
        undefined, undefined, '1930', undefined, 50, 1000,
      )

      const input = mockedCreateEntry.mock.calls[0][3]
      expect(input.lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount, l.dimensions])).toEqual([
        ['2440', 1000, 0, BAG],
        ['1930', 0, 1050, BAG],
        ['6570', 50, 0, BAG],
      ])
      assertBalanced(input)
    })

    it('leaves the lines untagged for an untagged invoice', async () => {
      const invoice = makeSupplierInvoice({ total: 1000 })

      await createSupplierInvoicePaymentEntry(
        null as never, 'company-1', 'user-1', invoice, 400, '2024-07-01',
        undefined, undefined, '1930', undefined, undefined, 1000,
      )

      const input = mockedCreateEntry.mock.calls[0][3]
      // A 600 kr short partial is not öresavrundning: it clears what moved.
      expect(input.lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
        ['2440', 400, 0],
        ['1930', 0, 400],
      ])
      for (const line of input.lines) expect(line.dimensions).toBeUndefined()
    })

    it('refuses an exchange rate difference: a SEK clearing has none', async () => {
      const invoice = makeSupplierInvoice()

      await expect(
        createSupplierInvoicePaymentEntry(
          null as never, 'company-1', 'user-1', invoice, 1000, '2024-07-01',
          20, undefined, '1930', undefined, undefined, 1000,
        ),
      ).rejects.toThrow('a SEK clearing has no exchange rate difference')
      expect(mockedCreateEntry).not.toHaveBeenCalled()
    })
  })
})

// ============================================================
// createSupplierInvoiceCashEntry
// ============================================================

describe('createSupplierInvoiceCashEntry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedFindFiscalPeriod.mockResolvedValue('period-1')
  })

  it('returns null when no fiscal period found', async () => {
    mockedFindFiscalPeriod.mockResolvedValue(null)
    const invoice = makeSupplierInvoice()
    const items = [makeItem()]

    const result = await createSupplierInvoiceCashEntry(
      null as never, 'company-1', 'user-1', invoice, items, '2024-07-01', 'swedish_business'
    , undefined, '1930')

    expect(result).toBeNull()
    expect(mockedCreateEntry).not.toHaveBeenCalled()
  })

  it('domestic with VAT: credits 1930 (not 2440)', async () => {
    const invoice = makeSupplierInvoice({
      subtotal: 8000,
      vat_amount: 2000,
      total: 10000,
    })
    const items = [makeItem({ line_total: 8000, account_number: '6200', vat_rate: 0.25 })]

    await createSupplierInvoiceCashEntry(
      null as never, 'company-1', 'user-1', invoice, items, '2024-07-01', 'swedish_business'
    , undefined, '1930')

    const input = mockedCreateEntry.mock.calls[0][3]

    expect(findByAccount(input.lines, '6200')[0].debit_amount).toBe(8000)
    expect(findByAccount(input.lines, '2641')[0].debit_amount).toBe(2000)

    const credit1930 = findByAccount(input.lines, '1930')
    expect(credit1930).toHaveLength(1)
    expect(credit1930[0].credit_amount).toBe(10000)

    assertBalanced(input)
  })

  it('credits the provided paymentAccount instead of 1930', async () => {
    const invoice = makeSupplierInvoice({
      subtotal: 8000, vat_amount: 2000, total: 10000,
    })
    const items = [makeItem({ line_total: 8000, account_number: '6200', vat_rate: 0.25 })]

    await createSupplierInvoiceCashEntry(
      null as never, 'company-1', 'user-1', invoice, items, '2024-07-01', 'swedish_business',
      undefined, '2018'
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(findByAccount(input.lines, '1930')).toHaveLength(0)
    expect(findByAccount(input.lines, '2018')[0].credit_amount).toBe(10000)
    assertBalanced(input)
  })

  it('domestic zero VAT', async () => {
    const invoice = makeSupplierInvoice({
      subtotal: 5000,
      vat_amount: 0,
      total: 5000,
    })
    const items = [makeItem({ line_total: 5000, account_number: '5410', vat_rate: 0 })]

    await createSupplierInvoiceCashEntry(
      null as never, 'company-1', 'user-1', invoice, items, '2024-07-01', 'swedish_business'
    , undefined, '1930')

    const input = mockedCreateEntry.mock.calls[0][3]

    expect(findByAccount(input.lines, '5410')[0].debit_amount).toBe(5000)
    expect(findByAccount(input.lines, '1930')[0].credit_amount).toBe(5000)
    expect(findByAccount(input.lines, '2641')).toHaveLength(0)

    assertBalanced(input)
  })

  it('EU goods under kontantmetoden: the basis pair lands on 4515/4598, ruta 20 (crm#1323)', async () => {
    const invoice = makeSupplierInvoice({
      subtotal: 1000, vat_amount: 0, total: 1000, reverse_charge: true, reverse_charge_kind: 'eu_goods',
    })
    const items = [makeItem({ line_total: 1000, account_number: '4010', vat_rate: 0 })]

    await createSupplierInvoiceCashEntry(
      null as never, 'company-1', 'user-1', invoice, items, '2024-07-01', 'eu_business'
    , undefined, '1930')

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(findByAccount(input.lines, '4515')[0].debit_amount).toBe(1000)
    expect(findByAccount(input.lines, '4598')[0].credit_amount).toBe(1000)
    expect(findByAccount(input.lines, '4535')).toHaveLength(0)
    assertBalanced(input)
  })

  it('EU reverse charge: credits 1930', async () => {
    const invoice = makeSupplierInvoice({
      subtotal: 10000,
      vat_amount: 0,
      total: 10000,
      reverse_charge: true,
    })
    const items = [makeItem({ line_total: 10000, account_number: '6540', vat_rate: 0.25 })]

    await createSupplierInvoiceCashEntry(
      null as never, 'company-1', 'user-1', invoice, items, '2024-07-01', 'eu_business'
    , undefined, '1930')

    const input = mockedCreateEntry.mock.calls[0][3]

    expect(findByAccount(input.lines, '2645')[0].debit_amount).toBe(2500)
    expect(findByAccount(input.lines, '2614')[0].credit_amount).toBe(2500)

    const credit1930 = findByAccount(input.lines, '1930')
    expect(credit1930).toHaveLength(1)
    // 1930 = totalDebits - totalCredits = (10000 + 2500) - 2500 = 10000
    // Fiktiv moms entries are offsetting; bank payment equals actual invoice amount
    expect(credit1930[0].credit_amount).toBe(10000)

    assertBalanced(input)
  })

  it('books no basis pair at payment for an item whose account reports ruta 20-24 itself (crm#1096)', async () => {
    mockFetchChartVatTreatments.mockResolvedValueOnce(momskoder({ '6540': 'reverse_charge_eu_services' }))
    const invoice = makeSupplierInvoice({ subtotal: 10000, vat_amount: 0, total: 10000, reverse_charge: true })
    const items = [makeItem({ line_total: 10000, account_number: '6540', vat_rate: 0 })]

    await createSupplierInvoiceCashEntry(
      null as never, 'company-1', 'user-1', invoice, items, '2024-07-01', 'eu_business'
    , undefined, '1930')

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(findByAccount(input.lines, '2645')[0].debit_amount).toBe(2500)
    expect(findByAccount(input.lines, '4535')).toHaveLength(0)
    expect(findByAccount(input.lines, '4598')).toHaveLength(0)
    expect(findByAccount(input.lines, '1930')[0].credit_amount).toBe(10000)
    assertBalanced(input)
  })

  it('self-assesses an item on an account at 12 % at that sats on 2624, without a basis pair, at payment (crm#1096)', async () => {
    mockFetchChartVatTreatments.mockResolvedValueOnce(momskoder({ '4057': ['reverse_charge_eu_goods', 0.12] }))
    const invoice = makeSupplierInvoice({ subtotal: 10000, vat_amount: 0, total: 10000, reverse_charge: true })
    const items = [
      // The form's reverse-charge rate defaults to 25 %; the account says 12 %.
      makeItem({ id: 'i1', line_total: 6000, account_number: '4057', vat_rate: 0, reverse_charge_rate: 0.25 }),
      makeItem({ id: 'i2', line_total: 4000, account_number: '6540', vat_rate: 0 }),
    ]

    await createSupplierInvoiceCashEntry(
      null as never, 'company-1', 'user-1', invoice, items, '2024-07-01', 'eu_business'
    , undefined, '1930')

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.lines.map((l: CreateJournalEntryLineInput) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['4057', 6000, 0],
      ['6540', 4000, 0],
      ['2645', 720, 0],
      ['2624', 0, 720],
      ['2645', 1000, 0],
      ['2614', 0, 1000],
      ['4535', 4000, 0],
      ['4598', 0, 4000],
      ['1930', 0, 10000],
    ])
    assertBalanced(input)
  })

  it('EU reverse charge with a 0%-rate line item self-assesses at 25% (regression)', async () => {
    const invoice = makeSupplierInvoice({
      subtotal: 12000, vat_amount: 0, total: 12000, reverse_charge: true,
    })
    const items = [makeItem({ line_total: 12000, account_number: '5910', vat_rate: 0, reverse_charge_rate: null })]

    await createSupplierInvoiceCashEntry(
      null as never, 'company-1', 'user-1', invoice, items, '2024-07-01', 'eu_business'
    , undefined, '1930')

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(findByAccount(input.lines, '2645')[0].debit_amount).toBe(3000)
    expect(findByAccount(input.lines, '2614')[0].credit_amount).toBe(3000)
    expect(findByAccount(input.lines, '4535')[0].debit_amount).toBe(12000)
    expect(findByAccount(input.lines, '1930')[0].credit_amount).toBe(12000)
    assertBalanced(input)
  })

  it('has no 2440 line', async () => {
    const invoice = makeSupplierInvoice()
    const items = [makeItem()]

    await createSupplierInvoiceCashEntry(
      null as never, 'company-1', 'user-1', invoice, items, '2024-07-01', 'swedish_business'
    , undefined, '1930')

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(findByAccount(input.lines, '2440')).toHaveLength(0)
  })

  it('creates per-rate 2641 lines for mixed-rate domestic cash entry', async () => {
    const invoice = makeSupplierInvoice({ vat_amount: 2680, total: 15680 })
    const items = [
      makeItem({ line_total: 10000, vat_rate: 0.25 }),
      makeItem({ id: 'item-2', line_total: 3000, vat_rate: 0.06, account_number: '5410' }),
    ]

    await createSupplierInvoiceCashEntry(
      null as never, 'company-1', 'user-1', invoice, items, '2024-06-01', 'swedish_business'
    , undefined, '1930')

    const input = mockedCreateEntry.mock.calls[0][3]
    const vat2641 = findByAccount(input.lines, '2641')
    expect(vat2641).toHaveLength(2)
    expect(vat2641.find((l) => l.line_description?.includes('25%'))?.debit_amount).toBe(2500)
    expect(vat2641.find((l) => l.line_description?.includes('6%'))?.debit_amount).toBe(180)

    assertBalanced(input)
  })

  it('sets source_type to supplier_invoice_cash_payment', async () => {
    const invoice = makeSupplierInvoice({ id: 'si-cash-1' })
    const items = [makeItem()]

    await createSupplierInvoiceCashEntry(
      null as never, 'company-1', 'user-1', invoice, items, '2024-07-01', 'swedish_business'
    , undefined, '1930')

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.source_type).toBe('supplier_invoice_cash_payment')
    expect(input.source_id).toBe('si-cash-1')
  })

  it('description includes supplier name when provided', async () => {
    const invoice = makeSupplierInvoice({ supplier_invoice_number: 'LF-300' })
    const items = [makeItem()]

    await createSupplierInvoiceCashEntry(
      null as never, 'company-1', 'user-1', invoice, items, '2024-07-01', 'swedish_business', 'Leverantör AB'
    , '1930')

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.description).toBe('Kontantbetalning leverantörsfaktura LF-300, Leverantör AB')
  })

  it('description falls back without supplier name', async () => {
    const invoice = makeSupplierInvoice({ supplier_invoice_number: 'LF-300' })
    const items = [makeItem()]

    await createSupplierInvoiceCashEntry(
      null as never, 'company-1', 'user-1', invoice, items, '2024-07-01', 'swedish_business'
    , undefined, '1930')

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.description).toBe('Kontantbetalning leverantörsfaktura LF-300')
  })

  it('names a number-less invoice by its ankomstnummer (crm#1039)', async () => {
    const invoice = makeSupplierInvoice({ supplier_invoice_number: null, arrival_number: 12 })
    const items = [makeItem()]

    await createSupplierInvoiceCashEntry(
      null as never, 'company-1', 'user-1', invoice, items, '2024-07-01', 'swedish_business', 'Leverantör AB'
    , '1930')

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.description).toBe('Kontantbetalning leverantörsfaktura ankomstnr 12, Leverantör AB')
  })

  it('carries the invoice dimensions onto every leg, the bank fee and the öre included', async () => {
    // A matched bank row paying 10 012 kr for a 10 012,40 kr invoice plus a
    // 25 kr fee on top: expense + moms, the bank credit, 3740 and 6570 all
    // belong to this one invoice's payment.
    const BAG = { '6': 'P1', '1': 'KS1' }
    const invoice = makeSupplierInvoice({
      subtotal: 8009.92,
      vat_amount: 2002.48,
      total: 10012.4,
      default_dimensions: BAG,
    })
    const items = [makeItem({ line_total: 8009.92, account_number: '6200', vat_rate: 0.25 })]

    await createSupplierInvoiceCashEntry(
      null as never, 'company-1', 'user-1', invoice, items, '2024-07-01', 'swedish_business',
      undefined, '1930', 10012, undefined, 25,
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.lines.map((l) => l.account_number)).toEqual(['6200', '2641', '1930', '3740', '6570'])
    for (const line of input.lines) expect(line.dimensions).toEqual(BAG)
    expect(findByAccount(input.lines, '1930')[0].credit_amount).toBe(10037)
    assertBalanced(input)
  })
})

// ============================================================
// createSupplierInvoiceCashEntry: foreign-currency settlement
// (kontantmetoden books the expense at the PAYMENT-date rate; the
//  payment-account credit must equal the SEK that left the bank)
// ============================================================

describe('createSupplierInvoiceCashEntry: foreign-currency settlement', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedFindFiscalPeriod.mockResolvedValue('period-1')
  })

  it('books a no-VAT foreign invoice at the payment-date rate, not the invoice rate (the reported bug)', async () => {
    // 19 USD invoice. The invoice was captured at rate 9.20 (→ 174.80 SEK),
    // but the bank actually paid 175.28 SEK at the payment-date rate. Under
    // kontantmetoden the expense belongs at the payment rate, so 1930 must
    // equal the bank movement exactly, and there is NO kursdifferens.
    const invoice = makeSupplierInvoice({
      currency: 'USD', exchange_rate: 9.20, subtotal: 19, vat_amount: 0, total: 19,
    })
    const items = [makeItem({ line_total: 19, account_number: '4000', vat_rate: 0, vat_amount: 0 })]

    await createSupplierInvoiceCashEntry(
      null as never, 'company-1', 'user-1', invoice, items, '2026-01-19', 'non_eu_business',
      undefined, '1930', 175.28,
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    // Payment-date rate (175.28 / 19), NOT the invoice's 9.20 (which would give 174.80).
    expect(findByAccount(input.lines, '4000')[0].debit_amount).toBe(175.28)
    expect(findByAccount(input.lines, '1930')[0].credit_amount).toBe(175.28)
    // No kursvinst/kursförlust under the cash method.
    expect(findByAccount(input.lines, '7960')).toHaveLength(0)
    expect(findByAccount(input.lines, '3960')).toHaveLength(0)
    expect(findByAccount(input.lines, '2641')).toHaveLength(0)
    assertBalanced(input)
  })

  it('translates a foreign reverse-charge invoice (fiktiv moms base) at the payment rate', async () => {
    // 100 USD EU-service invoice, reverse charge. Bank paid 922.50 SEK.
    const invoice = makeSupplierInvoice({
      currency: 'USD', exchange_rate: 9.20, subtotal: 100, vat_amount: 0, total: 100, reverse_charge: true,
    })
    const items = [makeItem({ line_total: 100, account_number: '6540', vat_rate: 0.25, vat_amount: 0 })]

    await createSupplierInvoiceCashEntry(
      null as never, 'company-1', 'user-1', invoice, items, '2026-01-19', 'eu_business',
      undefined, '1930', 922.50,
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(findByAccount(input.lines, '6540')[0].debit_amount).toBe(922.50)
    // Fiktiv moms on the payment-rate base (922.50 × 25%), and it nets out so
    // 1930 still equals the bank movement.
    expect(findByAccount(input.lines, '2645')[0].debit_amount).toBeCloseTo(230.63, 2)
    expect(findByAccount(input.lines, '2614')[0].credit_amount).toBeCloseTo(230.63, 2)
    expect(findByAccount(input.lines, '1930')[0].credit_amount).toBe(922.50)
    assertBalanced(input)
  })

  it('folds a sub-öre rounding residual into the largest expense line so 1930 = bank SEK', async () => {
    // Two expense lines whose per-line payment-rate rounding sums to 175.29,
    // one öre over the 175.28 that actually left the bank. The residual is
    // folded into the larger line so the bank credit lands exactly on 175.28.
    const invoice = makeSupplierInvoice({
      currency: 'USD', exchange_rate: 1.75, subtotal: 100, vat_amount: 0, total: 100,
    })
    const items = [
      makeItem({ id: 'a', line_total: 33.33, account_number: '4000', vat_rate: 0, vat_amount: 0 }),
      makeItem({ id: 'b', line_total: 66.67, account_number: '5000', vat_rate: 0, vat_amount: 0 }),
    ]

    await createSupplierInvoiceCashEntry(
      null as never, 'company-1', 'user-1', invoice, items, '2026-01-19', 'swedish_business',
      undefined, '1930', 175.28,
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    const debitSum = input.lines
      .filter((l) => l.debit_amount > 0)
      .reduce((s, l) => s + l.debit_amount, 0)
    expect(Math.round(debitSum * 100) / 100).toBe(175.28)
    expect(findByAccount(input.lines, '1930')[0].credit_amount).toBe(175.28)
    assertBalanced(input)
  })

  it('ignores settledBankSek for a SEK invoice (behaviour unchanged)', async () => {
    const invoice = makeSupplierInvoice({
      currency: 'SEK', subtotal: 8000, vat_amount: 2000, total: 10000,
    })
    const items = [makeItem({ line_total: 8000, account_number: '6200', vat_rate: 0.25 })]

    await createSupplierInvoiceCashEntry(
      null as never, 'company-1', 'user-1', invoice, items, '2024-07-01', 'swedish_business',
      undefined, '1930', 9999, // bogus settlement SEK must be ignored for a SEK invoice
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(findByAccount(input.lines, '6200')[0].debit_amount).toBe(8000)
    expect(findByAccount(input.lines, '2641')[0].debit_amount).toBe(2000)
    expect(findByAccount(input.lines, '1930')[0].credit_amount).toBe(10000)
    assertBalanced(input)
  })
})

// ============================================================
// createSupplierCreditNoteEntry
// ============================================================

describe('createSupplierCreditNoteEntry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedFindFiscalPeriod.mockResolvedValue('period-1')
  })

  it('returns null when no fiscal period found', async () => {
    mockedFindFiscalPeriod.mockResolvedValue(null)
    const creditNote = makeSupplierInvoice({ is_credit_note: true })
    const items = [makeItem()]

    const result = await createSupplierCreditNoteEntry(
      null as never, 'company-1', 'user-1', creditNote, items, 'swedish_business'
    )

    expect(result).toBeNull()
    expect(mockedCreateEntry).not.toHaveBeenCalled()
  })

  it('domestic: D 2440, C expense, C 2641', async () => {
    const creditNote = makeSupplierInvoice({
      is_credit_note: true,
      subtotal: 8000,
      vat_amount: 2000,
      total: 10000,
    })
    // The ORIGINAL invoice's rows, as lib/supplier-invoices/credit.ts passes them.
    const items = [makeItem({ line_total: 8000, account_number: '6200', vat_rate: 0.25 })]

    await createSupplierCreditNoteEntry(
      null as never, 'company-1', 'user-1', creditNote, items, 'swedish_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]

    const debit2440 = findByAccount(input.lines, '2440')[0]
    expect(debit2440.debit_amount).toBe(10000)
    expect(debit2440.credit_amount).toBe(0)

    const credit6200 = findByAccount(input.lines, '6200')[0]
    expect(credit6200.credit_amount).toBe(8000)
    expect(credit6200.debit_amount).toBe(0)

    const credit2641 = findByAccount(input.lines, '2641')[0]
    expect(credit2641.credit_amount).toBe(2000) // 8000 * 0.25
    expect(credit2641.debit_amount).toBe(0)

    assertBalanced(input)
  })

  it('domestic zero VAT', async () => {
    const creditNote = makeSupplierInvoice({
      is_credit_note: true,
      subtotal: 5000,
      vat_amount: 0,
      total: 5000,
    })
    const items = [makeItem({ line_total: 5000, account_number: '6200', vat_rate: 0 })]

    await createSupplierCreditNoteEntry(
      null as never, 'company-1', 'user-1', creditNote, items, 'swedish_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]

    expect(findByAccount(input.lines, '2440')[0].debit_amount).toBe(5000)
    expect(findByAccount(input.lines, '6200')[0].credit_amount).toBe(5000)
    expect(findByAccount(input.lines, '2641')).toHaveLength(0)

    assertBalanced(input)
  })

  it('reverses no basis pair for an item whose account reports ruta 20-24 itself, as registration booked none (crm#1096)', async () => {
    mockFetchChartVatTreatments.mockResolvedValueOnce(momskoder({ '4056': 'reverse_charge_eu_goods' }))
    const creditNote = makeSupplierInvoice({
      subtotal: -10000, vat_amount: 0, total: -10000, reverse_charge: true, is_credit_note: true,
    })
    const items = [
      makeItem({ id: 'i1', line_total: 6000, account_number: '4056', vat_rate: 0 }),
      makeItem({ id: 'i2', line_total: 4000, account_number: '6540', vat_rate: 0 }),
    ]

    await createSupplierCreditNoteEntry(
      null as never, 'company-1', 'user-1', creditNote, items, 'eu_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(findByAccount(input.lines, '2645')[0].credit_amount).toBe(2500)
    expect(findByAccount(input.lines, '2614')[0].debit_amount).toBe(2500)
    // Only the 6540 part had a basis pair at registration.
    expect(findByAccount(input.lines, '4535')[0].credit_amount).toBe(4000)
    expect(findByAccount(input.lines, '4598')[0].debit_amount).toBe(4000)
    assertBalanced(input)
  })

  it('reverses an EU goods purchase on 4515/4598, the box its registration booked (crm#1323)', async () => {
    const creditNote = makeSupplierInvoice({
      subtotal: -1000, vat_amount: 0, total: -1000, reverse_charge: true, reverse_charge_kind: 'eu_goods', is_credit_note: true,
    })
    const items = [makeItem({ line_total: 1000, account_number: '4010', vat_rate: 0 })]

    await createSupplierCreditNoteEntry(
      null as never, 'company-1', 'user-1', creditNote, items, 'eu_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(findByAccount(input.lines, '4515')[0].credit_amount).toBe(1000)
    expect(findByAccount(input.lines, '4598')[0].debit_amount).toBe(1000)
    expect(findByAccount(input.lines, '4535')).toHaveLength(0)
    expect(findByAccount(input.lines, '2645')[0].credit_amount).toBe(250)
    assertBalanced(input)
  })

  it('reverses the basis pair of a periodiserad item, as registration booked it on the interim account (crm#1096)', async () => {
    mockFetchChartVatTreatments.mockResolvedValueOnce(momskoder({ '6540': 'reverse_charge_eu_services' }))
    const creditNote = makeSupplierInvoice({
      subtotal: -12000, vat_amount: 0, total: -12000, reverse_charge: true, is_credit_note: true,
    })
    const items = [makeItem({
      line_total: 12000, account_number: '6540', vat_rate: 0,
      accrual_period_start: '2024-07-01', accrual_period_end: '2025-06-30', accrual_balance_account: '1790',
    })]

    await createSupplierCreditNoteEntry(
      null as never, 'company-1', 'user-1', creditNote, items, 'eu_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(findByAccount(input.lines, '1790')[0].credit_amount).toBe(12000)
    expect(findByAccount(input.lines, '4535')[0].credit_amount).toBe(12000)
    expect(findByAccount(input.lines, '4598')[0].debit_amount).toBe(12000)
    assertBalanced(input)
  })

  it('EU reverse charge reversal (C 2645, D 2614, reverses 4535/4598 basis)', async () => {
    const creditNote = makeSupplierInvoice({
      is_credit_note: true,
      subtotal: 10000,
      vat_amount: 0,
      total: 10000,
      reverse_charge: true,
    })
    const items = [makeItem({ line_total: 10000, account_number: '6540', vat_rate: 0.25 })]

    await createSupplierCreditNoteEntry(
      null as never, 'company-1', 'user-1', creditNote, items, 'eu_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]

    // Reversed fiktiv moms
    const credit2645 = findByAccount(input.lines, '2645')[0]
    expect(credit2645.credit_amount).toBe(2500) // 10000 * 0.25
    expect(credit2645.debit_amount).toBe(0)

    const debit2614 = findByAccount(input.lines, '2614')[0]
    expect(debit2614.debit_amount).toBe(2500)
    expect(debit2614.credit_amount).toBe(0)

    const credit6540 = findByAccount(input.lines, '6540')[0]
    expect(credit6540.credit_amount).toBe(10000)

    // Reverserade basbeloppsrader: 4535 ska krediteras och 4598 debiteras med
    // samma belopp så att kreditfakturan nollställer ruta 21 från originalet.
    const credit4535 = findByAccount(input.lines, '4535')[0]
    expect(credit4535.credit_amount).toBe(10000)
    expect(credit4535.debit_amount).toBe(0)

    const debit4598 = findByAccount(input.lines, '4598')[0]
    expect(debit4598.debit_amount).toBe(10000)
    expect(debit4598.credit_amount).toBe(0)

    const debit2440 = findByAccount(input.lines, '2440')[0]
    // totalCredits - totalDebits = (2500 + 10000 + 10000) - (2500 + 10000) = 10000
    expect(debit2440.debit_amount).toBe(10000)

    assertBalanced(input)
  })

  it('reverses a 0%-rate reverse charge credit note at the 25% default (regression)', async () => {
    // A credit note for the buggy 0%-rate RC invoice must reverse the same
    // self-assessed VAT the registration booked, or it leaves ruta 21/30/48
    // half-cancelled. The credit-note path resolves the same 25% default.
    const creditNote = makeSupplierInvoice({
      is_credit_note: true,
      subtotal: 12000,
      vat_amount: 0,
      total: 12000,
      reverse_charge: true,
    })
    const items = [makeItem({ line_total: 12000, account_number: '5910', vat_rate: 0, reverse_charge_rate: null })]

    await createSupplierCreditNoteEntry(
      null as never, 'company-1', 'user-1', creditNote, items, 'eu_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(findByAccount(input.lines, '2645')[0].credit_amount).toBe(3000)
    expect(findByAccount(input.lines, '2614')[0].debit_amount).toBe(3000)
    expect(findByAccount(input.lines, '4535')[0].credit_amount).toBe(12000)
    expect(findByAccount(input.lines, '4598')[0].debit_amount).toBe(12000)
    expect(findByAccount(input.lines, '2440')[0].debit_amount).toBe(12000)
    assertBalanced(input)
  })

  const sidesOf = (lines: CreateJournalEntryLineInput[]) =>
    lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])

  it('debits a row the original credits (öresavrundning downwards), and 2440 by what the original credited', async () => {
    const creditNote = makeSupplierInvoice({ is_credit_note: true, subtotal: 799.1, vat_amount: 199.9, total: 999 })
    const items = [
      makeItem({ id: 'i1', line_total: 799.6, account_number: '6110', vat_rate: 0.25 }),
      makeItem({ id: 'i2', line_total: -0.5, account_number: '3740', vat_rate: 0, vat_amount: 0 }),
    ]

    await createSupplierCreditNoteEntry(
      null as never, 'company-1', 'user-1', creditNote, items, 'swedish_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    // Registration: 6110 D 799.60, 3740 K 0.50, 2641 D 199.90, 2440 K 999.00.
    expect(sidesOf(input.lines)).toEqual([
      ['2440', 999, 0],
      ['6110', 0, 799.6],
      ['3740', 0.5, 0],
      ['2641', 0, 199.9],
    ])
    assertBalanced(input)
  })

  it('reverses a rabatt row and its moms netted on their account and rate, as the registration booked them', async () => {
    const creditNote = makeSupplierInvoice({ is_credit_note: true, subtotal: 450, vat_amount: 112.5, total: 562.5 })
    const items = [
      makeItem({ id: 'i1', line_total: 500, account_number: '6212', vat_rate: 0.25 }),
      makeItem({ id: 'i2', line_total: -50, account_number: '6212', vat_rate: 0.25 }),
    ]

    await createSupplierCreditNoteEntry(
      null as never, 'company-1', 'user-1', creditNote, items, 'swedish_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(sidesOf(input.lines)).toEqual([
      ['2440', 562.5, 0],
      ['6212', 0, 450],
      ['2641', 0, 112.5],
    ])
  })

  it('reverses a reverse charge stored as the verifikat\'s own rows row by row, the output side on the debit', async () => {
    // The provider migration (and the register-booked tool) store the
    // verifikat's rows with reverse_charge off: 2614 and 4598 are rows that
    // net to a credit, so rutor 21, 30 and 48 fall back only if each row
    // returns on its own other side.
    const creditNote = makeSupplierInvoice({ is_credit_note: true, subtotal: 4000, vat_amount: 0, total: 4000 })
    const items = [
      makeItem({ id: 'i1', line_total: 4000, account_number: '6540', vat_rate: 0, vat_amount: 0 }),
      makeItem({ id: 'i2', line_total: 1000, account_number: '2645', vat_rate: 0, vat_amount: 0 }),
      makeItem({ id: 'i3', line_total: -1000, account_number: '2614', vat_rate: 0, vat_amount: 0 }),
      makeItem({ id: 'i4', line_total: 4000, account_number: '4535', vat_rate: 0, vat_amount: 0 }),
      makeItem({ id: 'i5', line_total: -4000, account_number: '4598', vat_rate: 0, vat_amount: 0 }),
    ]

    await createSupplierCreditNoteEntry(
      null as never, 'company-1', 'user-1', creditNote, items, 'eu_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(sidesOf(input.lines)).toEqual([
      ['2440', 4000, 0],
      ['6540', 0, 4000],
      ['2645', 0, 1000],
      ['2614', 1000, 0],
      ['4535', 0, 4000],
      ['4598', 4000, 0],
    ])
    expect(mockFetchChartVatTreatments).not.toHaveBeenCalled()
  })

  it('self-assesses a reverse-charge rabatt row the way the registration did: on the net base', async () => {
    const creditNote = makeSupplierInvoice({
      is_credit_note: true, subtotal: 9000, vat_amount: 0, total: 9000, reverse_charge: true, vat_treatment: 'reverse_charge',
    })
    const items = [
      makeItem({ id: 'i1', line_total: 10000, account_number: '6540', vat_rate: 0 }),
      makeItem({ id: 'i2', line_total: -1000, account_number: '6540', vat_rate: 0 }),
    ]

    await createSupplierCreditNoteEntry(
      null as never, 'company-1', 'user-1', creditNote, items, 'eu_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(sidesOf(input.lines)).toEqual([
      ['2440', 9000, 0],
      ['6540', 0, 9000],
      ['2645', 0, 2250],
      ['2614', 2250, 0],
      ['4535', 0, 9000],
      ['4598', 9000, 0],
    ])
  })

  it('credits 2440 for an original whose rows net below zero, which the registration debited', async () => {
    const creditNote = makeSupplierInvoice({ is_credit_note: true, subtotal: -800, vat_amount: 0, total: -800 })
    const items = [makeItem({ line_total: -800, account_number: '4010', vat_rate: 0, vat_amount: 0 })]

    await createSupplierCreditNoteEntry(
      null as never, 'company-1', 'user-1', creditNote, items, 'swedish_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(sidesOf(input.lines)).toEqual([
      ['2440', 0, 800],
      ['4010', 800, 0],
    ])
  })

  describe('rows that do not add up to the invoice payable are refused before anything is posted (crm#1094)', () => {
    it.each<[string, SupplierInvoiceItem[], number, number]>([
      [
        'a row signed against its invoice',
        [makeItem({ line_total: -500, account_number: '4000', vat_rate: 0, vat_amount: 0 })],
        125,
        -500,
      ],
      [
        'duplicated rows',
        [
          makeItem({ id: 'i1', line_total: 800.4, account_number: '4000', vat_rate: 0, vat_amount: 0 }),
          makeItem({ id: 'i2', line_total: 800.4, account_number: '4000', vat_rate: 0, vat_amount: 0 }),
          makeItem({ id: 'i3', line_total: -0.4, account_number: '3740', vat_rate: 0, vat_amount: 0 }),
        ],
        800,
        1600.4,
      ],
      // A header without rows, as a migration leaves some: nothing to reverse.
      ['no rows at all', [], 1250, 0],
    ])('%s', async (_label, items, invoicePayableSek, rowsPayableSek) => {
      const creditNote = makeSupplierInvoice({ is_credit_note: true, vat_treatment: 'exempt', total: invoicePayableSek })

      const credit = createSupplierCreditNoteEntry(
        null as never, 'company-1', 'user-1', creditNote, items, 'swedish_business', undefined, invoicePayableSek
      )

      await expect(credit).rejects.toBeInstanceOf(SupplierCreditNoteRowsMismatchError)
      await expect(credit).rejects.toMatchObject({ rowsPayableSek, invoicePayableSek })
      expect(mockedCreateEntry).not.toHaveBeenCalled()

      // The service asks the same rule of the ORIGINAL before it draws an
      // ankomstnummer: the same refusal, the same figures, nothing looked up
      // or posted.
      vi.clearAllMocks()
      const original = makeSupplierInvoice({ vat_treatment: 'exempt', total: invoicePayableSek })
      const asked = assertSupplierCreditNoteRowsMatchPayable(
        null as never, 'company-1', original, items, 'swedish_business', invoicePayableSek
      )
      await expect(asked).rejects.toBeInstanceOf(SupplierCreditNoteRowsMismatchError)
      await expect(asked).rejects.toMatchObject({ rowsPayableSek, invoicePayableSek })
      expect(mockedFindFiscalPeriod).not.toHaveBeenCalled()
      expect(mockedCreateEntry).not.toHaveBeenCalled()
    })

    it('answers the service for rows that fit, and reads the momskoder of a reverse charge as the builder does', async () => {
      const items = [makeItem({ line_total: 4000, account_number: '6540', vat_rate: 0 })]
      const original = makeSupplierInvoice({ subtotal: 4000, vat_amount: 0, total: 4000, reverse_charge: true, vat_treatment: 'reverse_charge' })

      await expect(assertSupplierCreditNoteRowsMatchPayable(
        null as never, 'company-1', original, items, 'eu_business', 4000
      )).resolves.toBeUndefined()
      // The fiktiv moms and the basis pair net to zero: 244x moves by the net.
      await expect(assertSupplierCreditNoteRowsMatchPayable(
        null as never, 'company-1', original, items, 'eu_business', 5000
      )).rejects.toMatchObject({ rowsPayableSek: 4000, invoicePayableSek: 5000 })

      expect(mockFetchChartVatTreatments).toHaveBeenCalledTimes(2)
      expect(mockedFindFiscalPeriod).not.toHaveBeenCalled()
      expect(mockedCreateEntry).not.toHaveBeenCalled()
    })

    // The tolerance is the registration's own (supplierInvoiceTotalsTolerance:
    // 0.50 plus half an öre per line, capped at 2.00, in the invoice's
    // currency), at the invoice's rate and never under 1 kr: what the
    // registration accepts as rounding, the credit note accepts too.
    const manyRows = (count: number) => Array.from({ length: count }, (_, i) =>
      makeItem({ id: `i${i}`, line_total: 10, account_number: '4010', vat_rate: 0, vat_amount: 0 }))
    it.each<[string, Partial<SupplierInvoice>, SupplierInvoiceItem[], number, boolean]>([
      ['one SEK row 1.00 kr off: the floor', {}, manyRows(1), 11, true],
      ['one SEK row 1.01 kr off', {}, manyRows(1), 11.01, false],
      ['200 SEK rows 1.50 kr off: 0.50 plus half an öre per row', {}, manyRows(200), 2001.5, true],
      ['200 SEK rows 1.51 kr off', {}, manyRows(200), 2001.51, false],
      ['400 SEK rows 2.01 kr off: the cap', {}, manyRows(400), 4002.01, false],
      // 0.30 EUR between the document total and its lines: 3.45 kr at 11.50.
      ['a euro row 0.30 EUR off at 11.50', { currency: 'EUR', exchange_rate: 11.5 }, manyRows(1), 118.45, true],
      // The rule gives one row 0.505 EUR, 5.81 kr at 11.50; 0.60 EUR is 6.90 kr.
      ['a euro row 0.60 EUR off at 11.50', { currency: 'EUR', exchange_rate: 11.5 }, manyRows(1), 121.9, false],
    ])('%s', async (_label, header, items, invoicePayableSek, taken) => {
      const creditNote = makeSupplierInvoice({ is_credit_note: true, vat_treatment: 'exempt', ...header })

      const credit = createSupplierCreditNoteEntry(
        null as never, 'company-1', 'user-1', creditNote, items, 'swedish_business', undefined, invoicePayableSek
      )

      if (taken) {
        await expect(credit).resolves.toBeTruthy()
        expect(mockedCreateEntry).toHaveBeenCalledTimes(1)
      } else {
        await expect(credit).rejects.toBeInstanceOf(SupplierCreditNoteRowsMismatchError)
        expect(mockedCreateEntry).not.toHaveBeenCalled()
      }
    })

    it('posts rows within 1 kr of the payable: a display-only öresavrundning', async () => {
      const creditNote = makeSupplierInvoice({ is_credit_note: true, subtotal: 425, vat_amount: 106.25, total: 531 })
      const items = [makeItem({ line_total: 425, account_number: '4010', vat_rate: 0.25 })]

      await createSupplierCreditNoteEntry(
        null as never, 'company-1', 'user-1', creditNote, items, 'swedish_business', undefined, 531
      )

      const input = mockedCreateEntry.mock.calls[0][3]
      expect(sidesOf(input.lines)).toEqual([
        ['2440', 531.25, 0],
        ['4010', 0, 425],
        ['2641', 0, 106.25],
      ])
    })

    it('counts a 244x row toward the payable and books no skuld line of 0 beside it', async () => {
      // A migrated shape: the skuld stored as a row, so the rows net to zero.
      const creditNote = makeSupplierInvoice({ is_credit_note: true, subtotal: 1000, vat_amount: 250, total: 1250 })
      const items = [
        makeItem({ id: 'i1', line_total: -1250, account_number: '2440', vat_rate: 0 }),
        makeItem({ id: 'i2', line_total: 250, account_number: '2641', vat_rate: 0 }),
        makeItem({ id: 'i3', line_total: 1000, account_number: '6110', vat_rate: 0 }),
      ]

      await createSupplierCreditNoteEntry(
        null as never, 'company-1', 'user-1', creditNote, items, 'swedish_business', undefined, 1250
      )

      const input = mockedCreateEntry.mock.calls[0][3]
      expect(sidesOf(input.lines)).toEqual([
        ['2440', 1250, 0],
        ['2641', 0, 250],
        ['6110', 0, 1000],
      ])
      assertBalanced(input)
    })
  })

  it('reverses an item on an account at 12 % on 2624, without a basis pair, as the registration self-assessed it (crm#1096)', async () => {
    mockFetchChartVatTreatments.mockResolvedValueOnce(momskoder({ '4057': ['reverse_charge_eu_goods', 0.12] }))
    const creditNote = makeSupplierInvoice({
      is_credit_note: true, subtotal: 10000, vat_amount: 0, total: 10000, reverse_charge: true,
    })
    const items = [
      // The form's reverse-charge rate defaults to 25 %; the account says 12 %.
      makeItem({ id: 'i1', line_total: 6000, account_number: '4057', vat_rate: 0, reverse_charge_rate: 0.25 }),
      makeItem({ id: 'i2', line_total: 4000, account_number: '6540', vat_rate: 0 }),
    ]

    await createSupplierCreditNoteEntry(
      null as never, 'company-1', 'user-1', creditNote, items, 'eu_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    // The registration test above, every line on its other side: ruta 31 and
    // 48 fall back by 720, ruta 20 (4057's momskod) by 6 000, and only the
    // 6540 part had a 4535/4598 pair to reverse.
    expect(sidesOf(input.lines)).toEqual([
      ['2440', 10000, 0],
      ['4057', 0, 6000],
      ['6540', 0, 4000],
      ['2645', 0, 720],
      ['2624', 720, 0],
      ['2645', 0, 1000],
      ['2614', 1000, 0],
      ['4535', 0, 4000],
      ['4598', 4000, 0],
    ])
    assertBalanced(input)
  })

  describe('an invoice and its full credit note net to zero on every account and dimension cell', () => {
    /** Net debit per account and dimensions bag, to the öre. */
    function netByCell(lines: CreateJournalEntryLineInput[]): Map<string, number> {
      const cells = new Map<string, number>()
      for (const line of lines) {
        const key = `${line.account_number} ${JSON.stringify(Object.entries(line.dimensions ?? {}).sort())}`
        cells.set(key, Math.round(((cells.get(key) ?? 0) + line.debit_amount - line.credit_amount) * 100) / 100)
      }
      return cells
    }
    const periodiserad = { accrual_period_start: '2024-07-01', accrual_period_end: '2025-06-30', accrual_balance_account: '1790' }

    it.each<[string, Partial<SupplierInvoice>, SupplierInvoiceItem[], string, Momskoder?]>([
      [
        'tagged rows at two rates, a rabatt on an account of its own and an öresavrundning downwards',
        { default_dimensions: { '1': 'KS01' } },
        [
          makeItem({ id: 'i1', line_total: 1000, account_number: '4010', vat_rate: 0.25, dimensions: { '6': 'P001' } }),
          makeItem({ id: 'i2', line_total: 500, account_number: '4010', vat_rate: 0.12 }),
          makeItem({ id: 'i3', line_total: -100, account_number: '4730', vat_rate: 0.25 }),
          makeItem({ id: 'i4', line_total: -0.4, account_number: '3740', vat_rate: 0, vat_amount: 0 }),
        ],
        'swedish_business',
      ],
      [
        'a reverse charge with a rabatt row beside an account at 12 %',
        { reverse_charge: true, vat_treatment: 'reverse_charge', vat_amount: 0 },
        [
          makeItem({ id: 'i1', line_total: 6000, account_number: '4057', vat_rate: 0 }),
          makeItem({ id: 'i2', line_total: 4000, account_number: '6540', vat_rate: 0 }),
          makeItem({ id: 'i3', line_total: -500, account_number: '6540', vat_rate: 0 }),
        ],
        'eu_business',
        momskoder({ '4057': ['reverse_charge_eu_goods', 0.12] }),
      ],
      [
        'a byggtjänst under omvänd betalningsskyldighet with a credit row',
        { reverse_charge: true, vat_treatment: 'reverse_charge', vat_amount: 0 },
        [
          makeItem({ id: 'i1', line_total: 8000, account_number: '4600', vat_rate: 0 }),
          makeItem({ id: 'i2', line_total: -800, account_number: '4600', vat_rate: 0 }),
        ],
        'swedish_business',
      ],
      [
        'a reverse charge stored as the verifikat\'s rows, in euro',
        { currency: 'EUR', exchange_rate: 11.5, vat_amount: 0 },
        [
          makeItem({ id: 'i1', line_total: 200, account_number: '4056', vat_rate: 0, vat_amount: 0 }),
          makeItem({ id: 'i2', line_total: 50, account_number: '2645', vat_rate: 0, vat_amount: 0 }),
          makeItem({ id: 'i3', line_total: -50, account_number: '2614', vat_rate: 0, vat_amount: 0 }),
        ],
        'eu_business',
      ],
      [
        'an SLP premium with a rebate',
        { vat_amount: 0 },
        [
          makeItem({ id: 'i1', line_total: 10000, account_number: '7412', vat_rate: 0, apply_slp: true }),
          makeItem({ id: 'i2', line_total: -2000, account_number: '7412', vat_rate: 0, apply_slp: true }),
        ],
        'swedish_business',
      ],
      [
        'a periodiserad row beside an öresavrundning downwards',
        {},
        [
          makeItem({ id: 'i1', line_total: 600, account_number: '5420', vat_rate: 0.25, ...periodiserad }),
          makeItem({ id: 'i2', line_total: -0.25, account_number: '3740', vat_rate: 0, vat_amount: 0 }),
        ],
        'swedish_business',
      ],
    ])('%s', async (_label, header, items, supplierType, chart) => {
      // The registration and the credit note each read the momskoder once.
      if (chart) mockFetchChartVatTreatments.mockResolvedValueOnce(chart).mockResolvedValueOnce(chart)
      const invoice = makeSupplierInvoice(header)
      await createSupplierInvoiceRegistrationEntry(
        null as never, 'company-1', 'user-1', invoice, items, supplierType
      )
      // What creditSupplierInvoice books: a credit note row with the
      // original's header (buildSupplierCreditNoteRow) and the original's rows.
      const creditNote = { ...invoice, id: 'si-cn-1', is_credit_note: true, credited_invoice_id: invoice.id, invoice_date: '2024-07-15' }
      await createSupplierCreditNoteEntry(
        null as never, 'company-1', 'user-1', creditNote, items, supplierType
      )

      const [registration, credit] = mockedCreateEntry.mock.calls.map((call) => call[3] as CreateJournalEntryInput)
      assertBalanced(credit)
      for (const line of credit.lines) {
        expect(line.debit_amount >= 0 && line.credit_amount >= 0 && !(line.debit_amount > 0 && line.credit_amount > 0)).toBe(true)
      }
      const booked = netByCell(registration.lines)
      const reversed = netByCell(credit.lines)
      expect([...reversed.keys()].sort()).toEqual([...booked.keys()].sort())
      const together = netByCell([...registration.lines, ...credit.lines])
      expect([...together].filter(([, net]) => net !== 0)).toEqual([])
    })
  })

  it('2440 line is first (unshift)', async () => {
    const creditNote = makeSupplierInvoice({
      is_credit_note: true,
      total: 10000,
      vat_amount: 2000,
    })
    const items = [makeItem({ line_total: 8000, account_number: '6200', vat_rate: 0.25 })]

    await createSupplierCreditNoteEntry(
      null as never, 'company-1', 'user-1', creditNote, items, 'swedish_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.lines[0].account_number).toBe('2440')
  })

  it('description includes supplier name when provided', async () => {
    const creditNote = makeSupplierInvoice({
      is_credit_note: true,
      supplier_invoice_number: 'LF-400',
      arrival_number: 7,
      total: 10000,
      vat_amount: 2000,
    })
    const items = [makeItem({ line_total: 8000, account_number: '6200', vat_rate: 0.25 })]

    await createSupplierCreditNoteEntry(
      null as never, 'company-1', 'user-1', creditNote, items, 'swedish_business', 'Leverantör AB'
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.description).toBe('Kreditfaktura leverantör LF-400, Leverantör AB (ankomstnr 7)')
  })

  it('leaves a missing number out of the credit note verifikat text (crm#1039)', async () => {
    const creditNote = makeSupplierInvoice({
      is_credit_note: true,
      supplier_invoice_number: null,
      arrival_number: 7,
      total: 10000,
      vat_amount: 2000,
    })
    const items = [makeItem({ line_total: 8000, account_number: '6200', vat_rate: 0.25 })]

    await createSupplierCreditNoteEntry(
      null as never, 'company-1', 'user-1', creditNote, items, 'swedish_business', 'Leverantör AB'
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.description).toBe('Kreditfaktura leverantör, Leverantör AB (ankomstnr 7)')
  })

  it('sets source_type to supplier_credit_note', async () => {
    const creditNote = makeSupplierInvoice({ id: 'si-cn-1', is_credit_note: true })
    const items = [makeItem()]

    await createSupplierCreditNoteEntry(
      null as never, 'company-1', 'user-1', creditNote, items, 'swedish_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.source_type).toBe('supplier_credit_note')
    expect(input.source_id).toBe('si-cn-1')
  })

  it('reverses mixed-rate reverse charge with correct per-rate accounts', async () => {
    const creditNote = makeSupplierInvoice({
      is_credit_note: true,
      vat_amount: 0,
      total: 15000,
      reverse_charge: true,
    })
    const items = [
      makeItem({ line_total: 10000, vat_rate: 0.25, account_number: '6540' }),
      makeItem({ id: 'item-2', line_total: 5000, vat_rate: 0.12, account_number: '5410' }),
    ]

    await createSupplierCreditNoteEntry(
      null as never, 'company-1', 'user-1', creditNote, items, 'eu_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]

    // 2645 credit lines: 2 (one per rate)
    const vat2645 = findByAccount(input.lines, '2645')
    expect(vat2645).toHaveLength(2)

    // 2614 debit (25%): 10000 * 0.25 = 2500
    expect(findByAccount(input.lines, '2614')[0].debit_amount).toBe(2500)
    // 2624 debit (12%): 5000 * 0.12 = 600
    expect(findByAccount(input.lines, '2624')[0].debit_amount).toBe(600)

    assertBalanced(input)
  })
})

// ============================================================
// buildSupplierInvoicePrivatelyPaidLines: utlägg (a person paid)
// ============================================================

type ClaimLine = ReturnType<typeof buildSupplierInvoicePrivatelyPaidLines>[number]

function claimLinesByAccount(lines: ClaimLine[], account: string) {
  return lines.filter((l) => l.account_number === account)
}

function assertClaimLinesBalanced(lines: ClaimLine[]) {
  const debits = lines.reduce((s, l) => s + l.debit_amount, 0)
  const credits = lines.reduce((s, l) => s + l.credit_amount, 0)
  expect(Math.round(debits * 100)).toBe(Math.round(credits * 100))
  for (const l of lines) {
    // Exactly one side per line: the claims service refuses anything else.
    expect(l.debit_amount >= 0 && l.credit_amount >= 0).toBe(true)
    expect((l.debit_amount > 0) !== (l.credit_amount > 0)).toBe(true)
  }
}

const DESC = 'Faktura LF-001, Pressbyrån (ankomstnr 1)'

describe('buildSupplierInvoicePrivatelyPaidLines', () => {
  it('AB owner: D expense + D 2641, C 2893 with the total; no 2440, no 1930', () => {
    const invoice = makeSupplierInvoice({ subtotal: 400, vat_amount: 100, total: 500 })
    const items = [makeItem({ line_total: 400, account_number: '6110', vat_rate: 0.25 })]

    const lines = buildSupplierInvoicePrivatelyPaidLines(invoice, items, '2893', DESC)

    expect(claimLinesByAccount(lines, '6110')).toHaveLength(1)
    expect(claimLinesByAccount(lines, '6110')[0].debit_amount).toBe(400)
    expect(claimLinesByAccount(lines, '6110')[0].line_description).toBe(DESC)
    expect(claimLinesByAccount(lines, '2641')).toHaveLength(1)
    expect(claimLinesByAccount(lines, '2641')[0].debit_amount).toBe(100)
    expect(claimLinesByAccount(lines, '2641')[0].line_description).toContain('Ingående moms 25%')
    // The liability credit is what the claims service checks against the
    // claim total and what the payout later reimburses.
    expect(claimLinesByAccount(lines, '2893')).toHaveLength(1)
    expect(claimLinesByAccount(lines, '2893')[0].credit_amount).toBe(500)
    // AP account 2440 must NOT appear: an utlägg bypasses AP entirely.
    expect(claimLinesByAccount(lines, '2440')).toHaveLength(0)
    // Bank account 1930 must NOT appear: the person paid, not the company.
    expect(claimLinesByAccount(lines, '1930')).toHaveLength(0)
    expect(claimLinesByAccount(lines, '2018')).toHaveLength(0)
    assertClaimLinesBalanced(lines)
  })

  it('credits whatever liability the caller resolved: 2018 for an EF owner, 2820 for an employee', () => {
    const invoice = makeSupplierInvoice({ subtotal: 400, vat_amount: 100, total: 500 })
    const items = [makeItem({ line_total: 400, account_number: '6110', vat_rate: 0.25 })]

    const ef = buildSupplierInvoicePrivatelyPaidLines(invoice, items, '2018', DESC)
    expect(claimLinesByAccount(ef, '2018')[0].credit_amount).toBe(500)
    expect(claimLinesByAccount(ef, '2893')).toHaveLength(0)

    const employee = buildSupplierInvoicePrivatelyPaidLines(invoice, items, '2820', DESC)
    expect(claimLinesByAccount(employee, '2820')[0].credit_amount).toBe(500)
    expect(claimLinesByAccount(employee, '2893')).toHaveLength(0)
    assertClaimLinesBalanced(employee)
  })

  it('skips the 2641 line when the invoice has zero VAT', () => {
    const invoice = makeSupplierInvoice({ subtotal: 500, vat_amount: 0, total: 500 })
    const items = [makeItem({ line_total: 500, account_number: '5460', vat_rate: 0 })]

    const lines = buildSupplierInvoicePrivatelyPaidLines(invoice, items, '2893', DESC)

    expect(claimLinesByAccount(lines, '5460')[0].debit_amount).toBe(500)
    expect(claimLinesByAccount(lines, '2641')).toHaveLength(0)
    expect(claimLinesByAccount(lines, '2893')[0].credit_amount).toBe(500)
    assertClaimLinesBalanced(lines)
  })

  it('mixed-rate kvitto: one 2641 line per rate, liability = sum of debits', () => {
    // Lunch (12%) + parking (25%) on the same kvitto
    const invoice = makeSupplierInvoice({ subtotal: 200, vat_amount: 37, total: 237 })
    const items = [
      makeItem({ line_total: 100, account_number: '5810', vat_rate: 0.12 }),
      makeItem({ line_total: 100, account_number: '5611', vat_rate: 0.25 }),
    ]

    const lines = buildSupplierInvoicePrivatelyPaidLines(invoice, items, '2893', DESC)

    expect(claimLinesByAccount(lines, '2641')).toHaveLength(2)
    expect(claimLinesByAccount(lines, '2893')[0].credit_amount).toBe(237)
    assertClaimLinesBalanced(lines)
  })

  it('a stored VAT override wins over line_total x rate', () => {
    // Bilförmån: 25 % charged, only half deductible.
    const invoice = makeSupplierInvoice({ subtotal: 10000, vat_amount: 1250, total: 11250 })
    const items = [makeItem({ line_total: 10000, account_number: '5611', vat_rate: 0.25, vat_amount: 1250 })]

    const lines = buildSupplierInvoicePrivatelyPaidLines(invoice, items, '2893', DESC)

    expect(claimLinesByAccount(lines, '2641')[0].debit_amount).toBe(1250)
    expect(claimLinesByAccount(lines, '2893')[0].credit_amount).toBe(11250)
  })

  it('aggregates items on the same account into one line', () => {
    const invoice = makeSupplierInvoice({ subtotal: 600, vat_amount: 150, total: 750 })
    const items = [
      makeItem({ line_total: 300, account_number: '6110', vat_rate: 0.25 }),
      makeItem({ line_total: 300, account_number: '6110', vat_rate: 0.25 }),
    ]

    const lines = buildSupplierInvoicePrivatelyPaidLines(invoice, items, '2893', DESC)

    expect(claimLinesByAccount(lines, '6110')).toHaveLength(1)
    expect(claimLinesByAccount(lines, '6110')[0].debit_amount).toBe(600)
  })

  it('keeps invoice-currency amounts: the claims service converts at the claim rate', () => {
    const invoice = makeSupplierInvoice({
      subtotal: 1000, vat_amount: 250, total: 1250, currency: 'EUR', exchange_rate: 11.5,
    })
    const items = [makeItem({ line_total: 1000, account_number: '6200', vat_rate: 0.25 })]

    const lines = buildSupplierInvoicePrivatelyPaidLines(invoice, items, '2893', DESC)

    expect(claimLinesByAccount(lines, '6200')[0].debit_amount).toBe(1000)
    expect(claimLinesByAccount(lines, '2641')[0].debit_amount).toBe(250)
    expect(claimLinesByAccount(lines, '2893')[0].credit_amount).toBe(1250)
  })

  it('a discount row that nets an account below zero becomes a credit and lowers the liability', () => {
    const invoice = makeSupplierInvoice({ subtotal: 900, vat_amount: 0, total: 900 })
    const items = [
      makeItem({ line_total: 1000, account_number: '4010', vat_rate: 0 }),
      makeItem({ line_total: -100, account_number: '3730', vat_rate: 0 }),
    ]

    const lines = buildSupplierInvoicePrivatelyPaidLines(invoice, items, '2893', DESC)

    expect(claimLinesByAccount(lines, '3730')[0].credit_amount).toBe(100)
    expect(claimLinesByAccount(lines, '3730')[0].debit_amount).toBe(0)
    expect(claimLinesByAccount(lines, '2893')[0].credit_amount).toBe(900)
    assertClaimLinesBalanced(lines)
  })

  it('drops a bucket that nets to zero instead of posting a 0/0 line', () => {
    const invoice = makeSupplierInvoice({ subtotal: 500, vat_amount: 0, total: 500 })
    const items = [
      makeItem({ line_total: 500, account_number: '6110', vat_rate: 0 }),
      makeItem({ line_total: 200, account_number: '6250', vat_rate: 0 }),
      makeItem({ line_total: -200, account_number: '6250', vat_rate: 0 }),
    ]

    const lines = buildSupplierInvoicePrivatelyPaidLines(invoice, items, '2893', DESC)

    expect(claimLinesByAccount(lines, '6250')).toHaveLength(0)
    expect(claimLinesByAccount(lines, '2893')[0].credit_amount).toBe(500)
    assertClaimLinesBalanced(lines)
  })
})

describe('negative item rows (öresavrundning, rabatt) keep one non-negative side', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedFindFiscalPeriod.mockResolvedValue('period-1')
  })

  // A real case: 16 000 + 45 at 25 % = 20 056,25; the supplier bills 20 056,00
  // and the user adds a -0,25 avrundning row on 3740. The old generator
  // booked 3740 as debit -0,25, which the verifikat page hid.
  const roundingItems = [
    makeItem({ id: 'i1', line_total: 16000, account_number: '6110', vat_rate: 0.25, vat_amount: 4000 }),
    makeItem({ id: 'i2', line_total: 45, account_number: '3540', vat_rate: 0.25, vat_amount: 11.25 }),
    makeItem({ id: 'i3', line_total: -0.25, account_number: '3740', vat_rate: 0, vat_amount: 0 }),
  ]

  it('registration entry books the -0,25 row as credit 0,25 on 3740 and 2440 at the billed total', async () => {
    const invoice = makeSupplierInvoice({ subtotal: 16044.75, vat_amount: 4011.25, total: 20056 })

    await createSupplierInvoiceRegistrationEntry(null as never, 'company-1', 'user-1', invoice, roundingItems, 'swedish_business')

    const input = mockedCreateEntry.mock.calls[0][3]
    const rounding = findByAccount(input.lines, '3740')
    expect(rounding).toHaveLength(1)
    expect(rounding[0].debit_amount).toBe(0)
    expect(rounding[0].credit_amount).toBe(0.25)
    expect(findByAccount(input.lines, '2641')[0].debit_amount).toBe(4011.25)
    expect(findByAccount(input.lines, '2440')[0].credit_amount).toBe(20056)
    for (const l of input.lines) {
      expect(l.debit_amount).toBeGreaterThanOrEqual(0)
      expect(l.credit_amount).toBeGreaterThanOrEqual(0)
    }
    assertBalanced(input)
  })

  it('cash-method entry books the -0,25 row as a credit and 1930 at the billed total', async () => {
    const invoice = makeSupplierInvoice({ subtotal: 16044.75, vat_amount: 4011.25, total: 20056 })

    await createSupplierInvoiceCashEntry(null as never, 'company-1', 'user-1', invoice, roundingItems, '2026-06-10', 'swedish_business', undefined, '1930')

    const input = mockedCreateEntry.mock.calls[0][3]
    const rounding = findByAccount(input.lines, '3740')
    expect(rounding[0].debit_amount).toBe(0)
    expect(rounding[0].credit_amount).toBe(0.25)
    expect(findByAccount(input.lines, '1930')[0].credit_amount).toBe(20056)
    for (const l of input.lines) {
      expect(l.debit_amount).toBeGreaterThanOrEqual(0)
      expect(l.credit_amount).toBeGreaterThanOrEqual(0)
    }
    assertBalanced(input)
  })
})

describe('a supplier invoice that nets below zero books its anchor on the debit side', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedFindFiscalPeriod.mockResolvedValue('period-1')
  })

  const items = [
    makeItem({ id: 'i1', line_total: 100, account_number: '6110', vat_rate: 0, vat_amount: 0 }),
    makeItem({ id: 'i2', line_total: -400, account_number: '6110', vat_rate: 0, vat_amount: 0 }),
  ]

  it('registration: 6110 K 300 / 2440 D 300', async () => {
    const invoice = makeSupplierInvoice({ subtotal: -300, vat_amount: 0, total: -300 })
    await createSupplierInvoiceRegistrationEntry(null as never, 'company-1', 'user-1', invoice, items, 'swedish_business')
    const input = mockedCreateEntry.mock.calls[0][3]
    expect(findByAccount(input.lines, '6110')[0]).toMatchObject({ debit_amount: 0, credit_amount: 300 })
    expect(findByAccount(input.lines, '2440')[0]).toMatchObject({ debit_amount: 300, credit_amount: 0 })
    assertBalanced(input)
  })

  it('cash method: 1930 D 300', async () => {
    const invoice = makeSupplierInvoice({ subtotal: -300, vat_amount: 0, total: -300 })
    await createSupplierInvoiceCashEntry(null as never, 'company-1', 'user-1', invoice, items, '2026-06-10', 'swedish_business', undefined, '1930')
    const input = mockedCreateEntry.mock.calls[0][3]
    expect(findByAccount(input.lines, '1930')[0]).toMatchObject({ debit_amount: 300, credit_amount: 0 })
    assertBalanced(input)
  })

  it('privately paid: liability D 300', () => {
    const invoice = makeSupplierInvoice({ subtotal: -300, vat_amount: 0, total: -300 })
    const lines = buildSupplierInvoicePrivatelyPaidLines(invoice, items, '2893', 'Utlägg')
    const liability = lines.filter((l) => l.account_number === '2893')
    expect(liability[0]).toMatchObject({ debit_amount: 300, credit_amount: 0 })
    const totalDebit = lines.reduce((s, l) => s + l.debit_amount, 0)
    const totalCredit = lines.reduce((s, l) => s + l.credit_amount, 0)
    expect(Math.round(totalDebit * 100)).toBe(Math.round(totalCredit * 100))
  })
})

// crm#1190: the moms of rows below zero. A rate whose rows net to less moms
// than nothing used to be skipped by every builder (and an invoice of only
// negative rows got no moms at all), so 2641 kept the moms the rabatter
// cancel and the 2440 balance line absorbed it: the skuld no longer matched
// the invoice total. Each rate now books one 2641 line on its own side.
describe('ingående moms of rows below zero is booked per rate on its own side (crm#1190)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedFindFiscalPeriod.mockResolvedValue('period-1')
  })

  // 25 %: 800 - 200 nets +150 moms; 12 %: 300 - 500 nets -24 moms.
  const mixed = [
    makeItem({ id: 'i1', line_total: 800, account_number: '6110', vat_rate: 0.25 }),
    makeItem({ id: 'i2', line_total: -200, account_number: '6110', vat_rate: 0.25 }),
    makeItem({ id: 'i3', line_total: 300, account_number: '4010', vat_rate: 0.12 }),
    makeItem({ id: 'i4', line_total: -500, account_number: '4010', vat_rate: 0.12 }),
  ]
  const mixedInvoice = () => makeSupplierInvoice({ subtotal: 400, vat_amount: 126, total: 526 })
  // Only negative rows (a leverantörskreditfaktura keyed in as an invoice).
  const negativeOnly = [
    makeItem({ id: 'i1', line_total: -800, account_number: '5410', vat_rate: 0.25 }),
    makeItem({ id: 'i2', line_total: -100, account_number: '6212', vat_rate: 0.25 }),
  ]
  const negativeInvoice = () => makeSupplierInvoice({ subtotal: -900, vat_amount: -225, total: -1125 })

  it('registration: a rate that nets below zero credits 2641, and 2440 is the invoice total', async () => {
    await createSupplierInvoiceRegistrationEntry(null as never, 'company-1', 'user-1', mixedInvoice(), mixed, 'swedish_business')
    const input = mockedCreateEntry.mock.calls[0][3]
    expect(findByAccount(input.lines, '2641').map((l) => [l.debit_amount, l.credit_amount])).toEqual([[150, 0], [0, 24]])
    expect(findByAccount(input.lines, '2440')[0]).toMatchObject({ debit_amount: 0, credit_amount: 526 })
    assertBalanced(input)
  })

  it('registration: an invoice of only negative rows credits 2641 and debits 2440 by the total', async () => {
    await createSupplierInvoiceRegistrationEntry(null as never, 'company-1', 'user-1', negativeInvoice(), negativeOnly, 'swedish_business')
    const input = mockedCreateEntry.mock.calls[0][3]
    expect(findByAccount(input.lines, '2641')).toEqual([expect.objectContaining({ debit_amount: 0, credit_amount: 225 })])
    expect(findByAccount(input.lines, '2440')[0]).toMatchObject({ debit_amount: 1125, credit_amount: 0 })
    assertBalanced(input)
  })

  it('registration: a stored moms override on a rabatt row wins, as the invoice total counts it', async () => {
    // A rabatt on a 50 % deductible cost: -100 at 25 %, of which -12,50 is the deductible moms.
    const items = [
      makeItem({ id: 'i1', line_total: 1000, account_number: '5611', vat_rate: 0.25, vat_amount: 125 }),
      makeItem({ id: 'i2', line_total: -100, account_number: '5611', vat_rate: 0.25, vat_amount: -12.5 }),
    ]
    const invoice = makeSupplierInvoice({ subtotal: 900, vat_amount: 112.5, total: 1012.5 })
    await createSupplierInvoiceRegistrationEntry(null as never, 'company-1', 'user-1', invoice, items, 'swedish_business')
    const input = mockedCreateEntry.mock.calls[0][3]
    expect(findByAccount(input.lines, '2641')[0]).toMatchObject({ debit_amount: 112.5, credit_amount: 0 })
    expect(findByAccount(input.lines, '2440')[0]).toMatchObject({ credit_amount: 1012.5 })
    assertBalanced(input)
  })

  it('cash method: the same 2641 lines, and the bank leg is the invoice total', async () => {
    await createSupplierInvoiceCashEntry(null as never, 'company-1', 'user-1', mixedInvoice(), mixed, '2026-06-10', 'swedish_business', undefined, '1930')
    const input = mockedCreateEntry.mock.calls[0][3]
    expect(findByAccount(input.lines, '2641').map((l) => [l.debit_amount, l.credit_amount])).toEqual([[150, 0], [0, 24]])
    expect(findByAccount(input.lines, '1930')[0]).toMatchObject({ debit_amount: 0, credit_amount: 526 })
    assertBalanced(input)
  })

  it('privately paid: the same 2641 lines, and the liability is the invoice total', () => {
    const lines = buildSupplierInvoicePrivatelyPaidLines(negativeInvoice(), negativeOnly, '2893', 'Utlägg')
    expect(lines.filter((l) => l.account_number === '2641')).toEqual([expect.objectContaining({ debit_amount: 0, credit_amount: 225 })])
    expect(lines.filter((l) => l.account_number === '2893')[0]).toMatchObject({ debit_amount: 1125, credit_amount: 0 })
    const totalDebit = lines.reduce((s, l) => s + l.debit_amount, 0)
    const totalCredit = lines.reduce((s, l) => s + l.credit_amount, 0)
    expect(Math.round(totalDebit * 100)).toBe(Math.round(totalCredit * 100))
  })

  it('a full credit note of such an invoice nets 2641 and 2440 to zero', async () => {
    const invoice = mixedInvoice()
    await createSupplierInvoiceRegistrationEntry(null as never, 'company-1', 'user-1', invoice, mixed, 'swedish_business')
    const creditNote = { ...invoice, id: 'si-cn-1', is_credit_note: true, credited_invoice_id: invoice.id }
    await createSupplierCreditNoteEntry(null as never, 'company-1', 'user-1', creditNote, mixed, 'swedish_business', undefined, 526)
    const [registration, credit] = mockedCreateEntry.mock.calls.map((call) => call[3] as CreateJournalEntryInput)
    const net = (account: string) => Math.round(
      [...registration.lines, ...credit.lines]
        .filter((l) => l.account_number === account)
        .reduce((sum, l) => sum + l.debit_amount - l.credit_amount, 0) * 100,
    ) / 100
    expect(findByAccount(credit.lines, '2641').map((l) => [l.debit_amount, l.credit_amount])).toEqual([[0, 150], [24, 0]])
    expect(net('2641')).toBe(0)
    expect(net('2440')).toBe(0)
    assertBalanced(credit)
  })
})

describe('largestExpenseAccount', () => {
  it('picks the account of the largest line by magnitude, first line on a tie', () => {
    const items = [
      makeItem({ line_total: 300, account_number: '6110' }),
      makeItem({ line_total: 1200, account_number: '5410' }),
      makeItem({ line_total: 1200, account_number: '6250' }),
    ]
    expect(largestExpenseAccount(items)).toBe('5410')
    expect(largestExpenseAccount([makeItem({ line_total: -50, account_number: '3730' }), makeItem({ line_total: 20, account_number: '6110' })])).toBe('3730')
  })

  it('returns an empty string for no items', () => {
    expect(largestExpenseAccount([])).toBe('')
  })
})

// ============================================================
// dimensions propagation (PR7)
// ============================================================

describe('dimensions propagation (PR7): createSupplierInvoiceRegistrationEntry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedFindFiscalPeriod.mockResolvedValue('period-1')
  })

  it('expense lines carry merged item-over-default bags; 2641 and 2440 carry the default', async () => {
    const invoice = makeSupplierInvoice({
      subtotal: 8000,
      vat_amount: 2000,
      total: 10000,
      default_dimensions: { '1': 'KS01' },
    })
    const items = [
      makeItem({ id: 'si-item-1', line_total: 5000, account_number: '6200', vat_rate: 0.25, dimensions: { '6': 'P001' } }),
      makeItem({ id: 'si-item-2', line_total: 3000, account_number: '6200', vat_rate: 0.25, dimensions: { '1': 'KS02' } }),
    ]

    await createSupplierInvoiceRegistrationEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'swedish_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]

    // Same account, DIFFERENT bags → two separate expense lines
    // (aggregation identity = account + bag).
    const debit6200 = findByAccount(input.lines, '6200')
    expect(debit6200).toHaveLength(2)
    expect(debit6200[0].debit_amount).toBe(5000)
    expect(debit6200[0].dimensions).toEqual({ '1': 'KS01', '6': 'P001' })
    expect(debit6200[1].debit_amount).toBe(3000)
    // The item bag wins per key over the invoice default.
    expect(debit6200[1].dimensions).toEqual({ '1': 'KS02' })

    // VAT and AP legs carry the default only.
    expect(findByAccount(input.lines, '2641')[0].dimensions).toEqual({ '1': 'KS01' })
    expect(findByAccount(input.lines, '2440')[0].dimensions).toEqual({ '1': 'KS01' })

    assertBalanced(input)
  })

  it('items with the identical merged bag still aggregate into one expense line', async () => {
    const invoice = makeSupplierInvoice({
      subtotal: 8000,
      vat_amount: 2000,
      total: 10000,
      default_dimensions: { '1': 'KS01' },
    })
    const items = [
      makeItem({ id: 'si-item-1', line_total: 5000, account_number: '6200', vat_rate: 0.25, dimensions: { '6': 'P001' } }),
      makeItem({ id: 'si-item-2', line_total: 3000, account_number: '6200', vat_rate: 0.25, dimensions: { '6': 'P001' } }),
    ]

    await createSupplierInvoiceRegistrationEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'swedish_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    const debit6200 = findByAccount(input.lines, '6200')
    expect(debit6200).toHaveLength(1)
    expect(debit6200[0].debit_amount).toBe(8000)
    expect(debit6200[0].dimensions).toEqual({ '1': 'KS01', '6': 'P001' })
  })

  it('reverse charge: fiktiv moms + basbelopp lines carry the default; expense keeps the merged bag', async () => {
    const invoice = makeSupplierInvoice({
      subtotal: 10000,
      vat_amount: 0,
      total: 10000,
      reverse_charge: true,
      default_dimensions: { '1': 'KS01' },
    })
    const items = [
      makeItem({ line_total: 10000, account_number: '6540', vat_rate: 0.25, dimensions: { '6': 'P001' } }),
    ]

    await createSupplierInvoiceRegistrationEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'eu_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]

    expect(findByAccount(input.lines, '6540')[0].dimensions).toEqual({ '1': 'KS01', '6': 'P001' })
    // RC fiktiv moms pair + basis pair carry the default only.
    expect(findByAccount(input.lines, '2645')[0].dimensions).toEqual({ '1': 'KS01' })
    expect(findByAccount(input.lines, '2614')[0].dimensions).toEqual({ '1': 'KS01' })
    expect(findByAccount(input.lines, '4535')[0].dimensions).toEqual({ '1': 'KS01' })
    expect(findByAccount(input.lines, '4598')[0].dimensions).toEqual({ '1': 'KS01' })
    expect(findByAccount(input.lines, '2440')[0].dimensions).toEqual({ '1': 'KS01' })

    assertBalanced(input)
  })

  it('no default and no item bags → line.dimensions stays undefined', async () => {
    const invoice = makeSupplierInvoice({ subtotal: 8000, vat_amount: 2000, total: 10000 })
    const items = [makeItem({ line_total: 8000, account_number: '6200', vat_rate: 0.25 })]

    await createSupplierInvoiceRegistrationEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'swedish_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]

    const debit6200 = findByAccount(input.lines, '6200')[0]
    // toEqual ignores undefined-valued keys: the line shape is unchanged.
    expect(debit6200).toEqual({
      account_number: '6200',
      debit_amount: 8000,
      credit_amount: 0,
      line_description: 'Leverantörsfaktura LF-001 (ankomstnr 1)',
    })
    expect(debit6200.dimensions).toBeUndefined()
    expect(findByAccount(input.lines, '2641')[0].dimensions).toBeUndefined()
    expect(findByAccount(input.lines, '2440')[0].dimensions).toBeUndefined()
  })
})

describe('dimensions propagation (PR7): createSupplierInvoicePaymentEntry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedFindFiscalPeriod.mockResolvedValue('period-1')
  })

  it('standard payment: both 2440 and payment-account lines carry the default', async () => {
    const invoice = makeSupplierInvoice({ default_dimensions: { '1': 'KS01', '6': 'P001' } })

    await createSupplierInvoicePaymentEntry(
      null as never, 'company-1', 'user-1', invoice, 10000, '2024-07-01'
    , undefined, undefined, '1930')

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.lines).toHaveLength(2)
    for (const line of input.lines) {
      expect(line.dimensions).toEqual({ '1': 'KS01', '6': 'P001' })
    }
  })

  it('FX payment: the 3960/7960 result lines carry the default too', async () => {
    const invoice = makeSupplierInvoice({ default_dimensions: { '6': 'P001' } })

    // Gain: paid less SEK than booked → credit 3960.
    await createSupplierInvoicePaymentEntry(
      null as never, 'company-1', 'user-1', invoice, 10000, '2024-07-01', 200
    , undefined, '1930')
    let input = mockedCreateEntry.mock.calls[0][3]
    expect(findByAccount(input.lines, '3960')[0].dimensions).toEqual({ '6': 'P001' })
    expect(findByAccount(input.lines, '2440')[0].dimensions).toEqual({ '6': 'P001' })
    expect(findByAccount(input.lines, '1930')[0].dimensions).toEqual({ '6': 'P001' })

    // Loss: debit 7960.
    await createSupplierInvoicePaymentEntry(
      null as never, 'company-1', 'user-1', invoice, 10000, '2024-07-01', -300
    , undefined, '1930')
    input = mockedCreateEntry.mock.calls[1][3]
    expect(findByAccount(input.lines, '7960')[0].dimensions).toEqual({ '6': 'P001' })
  })

  it('no default bag → payment lines carry no dimensions', async () => {
    const invoice = makeSupplierInvoice()

    await createSupplierInvoicePaymentEntry(
      null as never, 'company-1', 'user-1', invoice, 10000, '2024-07-01'
    , undefined, undefined, '1930')

    const input = mockedCreateEntry.mock.calls[0][3]
    for (const line of input.lines) {
      expect(line.dimensions).toBeUndefined()
    }
  })
})

describe('dimensions propagation (PR7): createSupplierInvoiceCashEntry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedFindFiscalPeriod.mockResolvedValue('period-1')
  })

  it('expense lines carry merged bags; 2641 and payment account carry the default', async () => {
    const invoice = makeSupplierInvoice({
      subtotal: 8000,
      vat_amount: 2000,
      total: 10000,
      default_dimensions: { '1': 'KS01' },
    })
    const items = [
      makeItem({ line_total: 8000, account_number: '6200', vat_rate: 0.25, dimensions: { '6': 'P001' } }),
    ]

    await createSupplierInvoiceCashEntry(
      null as never, 'company-1', 'user-1', invoice, items, '2024-07-01', 'swedish_business'
    , undefined, '1930')

    const input = mockedCreateEntry.mock.calls[0][3]

    expect(findByAccount(input.lines, '6200')[0].dimensions).toEqual({ '1': 'KS01', '6': 'P001' })
    expect(findByAccount(input.lines, '2641')[0].dimensions).toEqual({ '1': 'KS01' })
    expect(findByAccount(input.lines, '1930')[0].dimensions).toEqual({ '1': 'KS01' })
    expect(findByAccount(input.lines, '2440')).toHaveLength(0)

    assertBalanced(input)
  })
})

// crm#1377: a reverse-charge invoice someone paid privately (an EU SaaS on
// the owner's card). The company still reports the moms, so the utlägg books
// the reverse-charge sets of the registration verifikat instead of 2641, and
// the person is owed the net.
describe('buildSupplierInvoicePrivatelyPaidLines: reverse charge', () => {
  const NO_MOMSKODER: Momskoder = new Map()
  const rcInvoice = (overrides: Partial<SupplierInvoice> = {}) =>
    makeSupplierInvoice({
      subtotal: 100,
      vat_amount: 0,
      total: 100,
      currency: 'EUR',
      exchange_rate: 11.123,
      reverse_charge: true,
      vat_treatment: 'reverse_charge',
      ...overrides,
    })
  const rcItem = (overrides: Partial<SupplierInvoiceItem> = {}) =>
    makeItem({ line_total: 100, account_number: '6540', vat_rate: 0, vat_amount: 0, reverse_charge_rate: 0.25, ...overrides })

  it('EU service on an ordinary cost account: fiktiv moms and the ruta 21 basis pair, in the invoice currency', () => {
    const lines = buildSupplierInvoicePrivatelyPaidLines(rcInvoice(), [rcItem()], '2893', DESC, {
      supplierType: 'eu_business',
      chartVatTreatments: NO_MOMSKODER,
    })

    expect(claimLinesByAccount(lines, '6540')[0].debit_amount).toBe(100)
    expect(claimLinesByAccount(lines, '2645')[0].debit_amount).toBe(25)
    expect(claimLinesByAccount(lines, '2614')[0].credit_amount).toBe(25)
    expect(claimLinesByAccount(lines, '4535')[0].debit_amount).toBe(100)
    expect(claimLinesByAccount(lines, '4598')[0].credit_amount).toBe(100)
    expect(claimLinesByAccount(lines, '2641')).toHaveLength(0)
    // The seller charged no moms: the liability is what the person paid.
    expect(claimLinesByAccount(lines, '2893')[0].credit_amount).toBe(100)
    assertClaimLinesBalanced(lines)
  })

  it('a cost on 4535 reports ruta 21 itself: fiktiv moms only, no basis pair', () => {
    const lines = buildSupplierInvoicePrivatelyPaidLines(
      rcInvoice({ subtotal: 180, total: 180 }),
      [rcItem({ line_total: 180, account_number: '4535' })],
      '2893',
      DESC,
      { supplierType: 'eu_business', chartVatTreatments: NO_MOMSKODER },
    )

    expect(lines.map((l) => l.account_number).sort()).toEqual(['2614', '2645', '2893', '4535'])
    expect(claimLinesByAccount(lines, '2645')[0].debit_amount).toBe(45)
    expect(claimLinesByAccount(lines, '2614')[0].credit_amount).toBe(45)
    expect(claimLinesByAccount(lines, '2893')[0].credit_amount).toBe(180)
    assertClaimLinesBalanced(lines)
  })

  it('books what the registration books: non-EU (ruta 22), EU goods (ruta 20) and one 26x4 per self-assessed rate', () => {
    const nonEu = buildSupplierInvoicePrivatelyPaidLines(rcInvoice(), [rcItem()], '2893', DESC, {
      supplierType: 'non_eu_business',
      chartVatTreatments: NO_MOMSKODER,
    })
    expect(claimLinesByAccount(nonEu, '4531')[0].debit_amount).toBe(100)
    expect(claimLinesByAccount(nonEu, '4535')).toHaveLength(0)

    const goods = buildSupplierInvoicePrivatelyPaidLines(
      rcInvoice({ reverse_charge_kind: 'eu_goods' }), [rcItem({ account_number: '4010' })], '2893', DESC,
      { supplierType: 'eu_business', chartVatTreatments: NO_MOMSKODER },
    )
    expect(claimLinesByAccount(goods, '4515')[0].debit_amount).toBe(100)

    const mixed = buildSupplierInvoicePrivatelyPaidLines(
      rcInvoice({ subtotal: 300, total: 300 }),
      [rcItem({ line_total: 200 }), rcItem({ line_total: 100, account_number: '6250', reverse_charge_rate: 0.12 })],
      '2893',
      DESC,
      { supplierType: 'eu_business', chartVatTreatments: NO_MOMSKODER },
    )
    expect(claimLinesByAccount(mixed, '2614')[0].credit_amount).toBe(50)
    expect(claimLinesByAccount(mixed, '2624')[0].credit_amount).toBe(12)
    expect(claimLinesByAccount(mixed, '2893')[0].credit_amount).toBe(300)
    assertClaimLinesBalanced(mixed)
  })

  it('refuses to guess the momskoder: a reverse-charge invoice without them throws', () => {
    expect(() =>
      buildSupplierInvoicePrivatelyPaidLines(rcInvoice(), [rcItem()], '2893', DESC, { supplierType: 'eu_business' }),
    ).toThrow(/momskoder/)
  })
})

describe('dimensions propagation (PR7): buildSupplierInvoicePrivatelyPaidLines', () => {
  it('expense lines carry merged bags; 2641 and the liability carry the default', () => {
    const invoice = makeSupplierInvoice({
      subtotal: 400,
      vat_amount: 100,
      total: 500,
      default_dimensions: { '1': 'KS01' },
    })
    const items = [
      makeItem({ line_total: 400, account_number: '6110', vat_rate: 0.25, dimensions: { '6': 'P001' } }),
    ]

    const lines = buildSupplierInvoicePrivatelyPaidLines(invoice, items, '2893', DESC)

    expect(claimLinesByAccount(lines, '6110')[0].dimensions).toEqual({ '1': 'KS01', '6': 'P001' })
    expect(claimLinesByAccount(lines, '2641')[0].dimensions).toEqual({ '1': 'KS01' })
    expect(claimLinesByAccount(lines, '2893')[0].dimensions).toEqual({ '1': 'KS01' })
    assertClaimLinesBalanced(lines)
  })

  it('two items on the same account with different bags stay on separate lines', () => {
    const invoice = makeSupplierInvoice({ subtotal: 600, vat_amount: 0, total: 600 })
    const items = [
      makeItem({ line_total: 300, account_number: '6110', vat_rate: 0, dimensions: { '6': 'P001' } }),
      makeItem({ line_total: 300, account_number: '6110', vat_rate: 0, dimensions: { '6': 'P002' } }),
    ]

    const lines = buildSupplierInvoicePrivatelyPaidLines(invoice, items, '2893', DESC)

    expect(claimLinesByAccount(lines, '6110')).toHaveLength(2)
    expect(claimLinesByAccount(lines, '2893')[0].credit_amount).toBe(600)
  })
})

describe('dimensions propagation (PR7): createSupplierCreditNoteEntry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedFindFiscalPeriod.mockResolvedValue('period-1')
  })

  it('expense credits keep the item bags; 2440 and 2641 carry the credit note default', async () => {
    const creditNote = makeSupplierInvoice({
      is_credit_note: true,
      subtotal: 8000,
      vat_amount: 2000,
      total: 10000,
      default_dimensions: { '1': 'KS01' },
    })
    const items = [
      makeItem({ id: 'si-item-1', line_total: 5000, account_number: '6200', vat_rate: 0.25, dimensions: { '6': 'P001' } }),
      makeItem({ id: 'si-item-2', line_total: 3000, account_number: '6200', vat_rate: 0.25, dimensions: { '6': 'P002' } }),
    ]

    await createSupplierCreditNoteEntry(
      null as never, 'company-1', 'user-1', creditNote, items, 'swedish_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]

    // Two credit lines on the same account, split by the item bags.
    const credit6200 = findByAccount(input.lines, '6200')
    expect(credit6200).toHaveLength(2)
    expect(credit6200[0].credit_amount).toBe(5000)
    expect(credit6200[0].dimensions).toEqual({ '1': 'KS01', '6': 'P001' })
    expect(credit6200[1].credit_amount).toBe(3000)
    expect(credit6200[1].dimensions).toEqual({ '1': 'KS01', '6': 'P002' })

    expect(findByAccount(input.lines, '2641')[0].dimensions).toEqual({ '1': 'KS01' })
    expect(findByAccount(input.lines, '2440')[0].dimensions).toEqual({ '1': 'KS01' })

    assertBalanced(input)
  })
})

// ============================================================
// Särskild löneskatt på pensionskostnader (SLP) pair injection
// ============================================================

describe('SLP pair injection (apply_slp)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedFindFiscalPeriod.mockResolvedValue('period-1')
  })

  // The customer case verbatim: Avanza tjänstepension, 10 000 kr premie.
  //   2440 K 10 000 / 7412 D 10 000 / 7533 D 2 426 / 2514 K 2 426.
  it('registration books the 4-line Avanza case: 7533/2514 nets to zero, payable untouched', async () => {
    const invoice = makeSupplierInvoice({
      subtotal: 10000,
      vat_amount: 0,
      total: 10000,
    })
    const items = [
      makeItem({ line_total: 10000, account_number: '7412', vat_rate: 0, apply_slp: true }),
    ]

    await createSupplierInvoiceRegistrationEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'swedish_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.lines).toHaveLength(4)

    expect(findByAccount(input.lines, '7412')[0].debit_amount).toBe(10000)
    expect(findByAccount(input.lines, '7533')[0].debit_amount).toBe(2426)
    expect(findByAccount(input.lines, '2514')[0].credit_amount).toBe(2426)
    // The pair nets to zero: 2440 stays at exactly the invoice total.
    expect(findByAccount(input.lines, '2440')[0].credit_amount).toBe(10000)

    assertBalanced(input)
  })

  it('multiple flagged 741x rows aggregate into ONE 7533/2514 pair', async () => {
    const invoice = makeSupplierInvoice({ subtotal: 15000, vat_amount: 0, total: 15000 })
    const items = [
      makeItem({ id: 'i1', line_total: 10000, account_number: '7412', vat_rate: 0, apply_slp: true }),
      makeItem({ id: 'i2', line_total: 5000, account_number: '7410', vat_rate: 0, apply_slp: true }),
    ]

    await createSupplierInvoiceRegistrationEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'swedish_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    const slpDebit = findByAccount(input.lines, '7533')
    expect(slpDebit).toHaveLength(1)
    // 15 000 × 0.2426 = 3 639
    expect(slpDebit[0].debit_amount).toBe(3639)
    expect(findByAccount(input.lines, '2514')[0].credit_amount).toBe(3639)
    expect(findByAccount(input.lines, '2440')[0].credit_amount).toBe(15000)
    assertBalanced(input)
  })

  it('rounds the pair to öre (base 1 000,01 → 242,60)', async () => {
    const invoice = makeSupplierInvoice({ subtotal: 1000.01, vat_amount: 0, total: 1000.01 })
    const items = [
      makeItem({ line_total: 1000.01, account_number: '7412', vat_rate: 0, apply_slp: true }),
    ]

    await createSupplierInvoiceRegistrationEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'swedish_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(findByAccount(input.lines, '7533')[0].debit_amount).toBe(242.6)
    expect(findByAccount(input.lines, '2514')[0].credit_amount).toBe(242.6)
    expect(findByAccount(input.lines, '2440')[0].credit_amount).toBe(1000.01)
    assertBalanced(input)
  })

  it('ignores apply_slp on a non-741x account (defense in depth behind the route guard)', async () => {
    const invoice = makeSupplierInvoice({ subtotal: 8000, vat_amount: 2000, total: 10000 })
    const items = [
      makeItem({ line_total: 8000, account_number: '6200', vat_rate: 0.25, apply_slp: true }),
    ]

    await createSupplierInvoiceRegistrationEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'swedish_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(findByAccount(input.lines, '7533')).toHaveLength(0)
    expect(findByAccount(input.lines, '2514')).toHaveLength(0)
    assertBalanced(input)
  })

  it('unflagged 741x rows book without the pair (opt-in, never automatic)', async () => {
    const invoice = makeSupplierInvoice({ subtotal: 10000, vat_amount: 0, total: 10000 })
    const items = [
      makeItem({ line_total: 10000, account_number: '7412', vat_rate: 0 }),
    ]

    await createSupplierInvoiceRegistrationEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'swedish_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(findByAccount(input.lines, '7533')).toHaveLength(0)
    expect(findByAccount(input.lines, '2514')).toHaveLength(0)
    expect(findByAccount(input.lines, '2440')[0].credit_amount).toBe(10000)
    assertBalanced(input)
  })

  it('SLP lines carry the invoice default dimensions like the RC pairs do', async () => {
    const invoice = makeSupplierInvoice({
      subtotal: 10000,
      vat_amount: 0,
      total: 10000,
      default_dimensions: { '1': 'KS01' },
    })
    const items = [
      makeItem({ line_total: 10000, account_number: '7412', vat_rate: 0, apply_slp: true }),
    ]

    await createSupplierInvoiceRegistrationEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'swedish_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(findByAccount(input.lines, '7533')[0].dimensions).toEqual({ '1': 'KS01' })
    expect(findByAccount(input.lines, '2514')[0].dimensions).toEqual({ '1': 'KS01' })
  })

  it('kontantmetoden: pair injected and the bank credit stays at the invoice total', async () => {
    const invoice = makeSupplierInvoice({ subtotal: 10000, vat_amount: 0, total: 10000 })
    const items = [
      makeItem({ line_total: 10000, account_number: '7412', vat_rate: 0, apply_slp: true }),
    ]

    await createSupplierInvoiceCashEntry(
      null as never, 'company-1', 'user-1', invoice, items, '2024-07-01', 'swedish_business'
    , undefined, '1930')

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(findByAccount(input.lines, '7533')[0].debit_amount).toBe(2426)
    expect(findByAccount(input.lines, '2514')[0].credit_amount).toBe(2426)
    // Payment guarantee: the bank movement equals the invoice total exactly.
    expect(findByAccount(input.lines, '1930')[0].credit_amount).toBe(10000)
    assertBalanced(input)
  })

  it('privately paid (utlägg): pair injected and the liability stays at the invoice total', () => {
    const invoice = makeSupplierInvoice({ subtotal: 10000, vat_amount: 0, total: 10000 })
    const items = [
      makeItem({ line_total: 10000, account_number: '7412', vat_rate: 0, apply_slp: true }),
    ]

    const lines = buildSupplierInvoicePrivatelyPaidLines(invoice, items, '2893', DESC)

    expect(claimLinesByAccount(lines, '7533')[0].debit_amount).toBe(2426)
    expect(claimLinesByAccount(lines, '2514')[0].credit_amount).toBe(2426)
    // The SLP pair must not inflate what the person is owed.
    expect(claimLinesByAccount(lines, '2893')[0].credit_amount).toBe(10000)
    assertClaimLinesBalanced(lines)
  })

  it('credit note reverses the pair (7533 K / 2514 D) and keeps 2440 at the invoice total', async () => {
    const creditNote = makeSupplierInvoice({
      is_credit_note: true,
      subtotal: -10000,
      vat_amount: 0,
      total: -10000,
    })
    // The caller passes the ORIGINAL invoice's items (positive line_total).
    const items = [
      makeItem({ line_total: 10000, account_number: '7412', vat_rate: 0, apply_slp: true }),
    ]

    await createSupplierCreditNoteEntry(
      null as never, 'company-1', 'user-1', creditNote, items, 'swedish_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    // Swapped sides vs registration.
    expect(findByAccount(input.lines, '7533')[0].credit_amount).toBe(2426)
    expect(findByAccount(input.lines, '7533')[0].debit_amount).toBe(0)
    expect(findByAccount(input.lines, '2514')[0].debit_amount).toBe(2426)
    expect(findByAccount(input.lines, '2514')[0].credit_amount).toBe(0)
    // Pair nets to zero: 2440 debit clears exactly the original payable.
    expect(findByAccount(input.lines, '2440')[0].debit_amount).toBe(10000)
    assertBalanced(input)
  })

  it('mixed-sign flagged original: credit note reverses SLP on the signed sum, not per-item abs', async () => {
    // Registration computed its SLP base as the SIGNED sum of flagged
    // line_totals: +10000 premium and -2000 rebate booked SLP on 8000
    // (1 940,80). Per-item abs on the credit note would reverse SLP on
    // 12000 (2 911,20), striking more 7533/2514 than was ever posted.
    const creditNote = makeSupplierInvoice({
      is_credit_note: true,
      subtotal: -8000,
      vat_amount: 0,
      total: -8000,
    })
    const items = [
      makeItem({ id: 'i1', line_total: 10000, account_number: '7412', vat_rate: 0, apply_slp: true }),
      makeItem({ id: 'i2', line_total: -2000, account_number: '7412', vat_rate: 0, apply_slp: true }),
    ]

    await createSupplierCreditNoteEntry(
      null as never, 'company-1', 'user-1', creditNote, items, 'swedish_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    // 8 000 × 0.2426 = 1 940,80: exactly what registration booked.
    expect(findByAccount(input.lines, '7533')[0].credit_amount).toBe(1940.8)
    expect(findByAccount(input.lines, '2514')[0].debit_amount).toBe(1940.8)
    // The premium nets with its rebate on 7412, as registered: 8 000, not 12 000.
    expect(findByAccount(input.lines, '7412')[0].credit_amount).toBe(8000)
    expect(findByAccount(input.lines, '2440')[0].debit_amount).toBe(8000)
    assertBalanced(input)
  })

  it('foreign-currency invoice books the pair in SEK at the invoice rate', async () => {
    const invoice = makeSupplierInvoice({
      subtotal: 1000, vat_amount: 0, total: 1000,
      currency: 'EUR', exchange_rate: 11.50,
    })
    const items = [
      makeItem({ line_total: 1000, account_number: '7412', vat_rate: 0, apply_slp: true }),
    ]

    await createSupplierInvoiceRegistrationEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'swedish_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    // 11 500 SEK × 0.2426 = 2 789.90
    expect(findByAccount(input.lines, '7533')[0].debit_amount).toBe(2789.9)
    expect(findByAccount(input.lines, '2514')[0].credit_amount).toBe(2789.9)
    expect(findByAccount(input.lines, '2440')[0].credit_amount).toBe(11500)
    assertBalanced(input)
  })
})

// ============================================================
// vat_treatment as a booking contract (issue #2553)
//
// An `exempt` purchase is undantagen (ML 10 kap) and an `export` purchase
// carries no Swedish moms either, so neither has debiterad ingående moms to
// deduct: no 2641 line at all, and the gross the supplier billed is the cost.
// The stored line rate cannot answer this on its own: supplier_invoice_items
// .vat_rate carries a NOT NULL DEFAULT 0.25 and every create path used to
// fill an omitted rate with 25 %, so the fixtures below deliberately keep a
// stale 25 % on the lines.
// ============================================================

describe('vat_treatment exempt/export books no input VAT', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedFindFiscalPeriod.mockResolvedValue('period-1')
  })

  for (const treatment of ['exempt', 'export'] as const) {
    it(`registration (${treatment}): no 2641, gross on the expense account`, async () => {
      const invoice = makeSupplierInvoice({
        vat_treatment: treatment,
        subtotal: 8000,
        vat_amount: 0,
        total: 8000,
      })
      // Stale stored 25 %: exactly what the DB default and the old route
      // fallback leave behind on an exempt invoice.
      const items = [makeItem({ line_total: 8000, account_number: '6310', vat_rate: 0.25, vat_amount: 2000 })]

      await createSupplierInvoiceRegistrationEntry(
        null as never, 'company-1', 'user-1', invoice, items, 'swedish_business'
      )

      const input = mockedCreateEntry.mock.calls[0][3]
      expect(findByAccount(input.lines, '2641')).toHaveLength(0)
      expect(findByAccount(input.lines, '6310')[0].debit_amount).toBe(8000)
      expect(findByAccount(input.lines, '2440')[0].credit_amount).toBe(8000)
      assertBalanced(input)
    })

    it(`kontantmetod (${treatment}): no 2641`, async () => {
      const invoice = makeSupplierInvoice({
        vat_treatment: treatment,
        subtotal: 8000,
        vat_amount: 0,
        total: 8000,
      })
      const items = [makeItem({ line_total: 8000, account_number: '6310', vat_rate: 0.25, vat_amount: 2000 })]

      await createSupplierInvoiceCashEntry(
        null as never, 'company-1', 'user-1', invoice, items, '2024-07-01', 'swedish_business'
      , undefined, '1930')

      const input = mockedCreateEntry.mock.calls[0][3]
      expect(findByAccount(input.lines, '2641')).toHaveLength(0)
      expect(findByAccount(input.lines, '6310')[0].debit_amount).toBe(8000)
      assertBalanced(input)
    })

    it(`credit note (${treatment}): no 2641 reversal`, async () => {
      const creditNote = makeSupplierInvoice({
        vat_treatment: treatment,
        is_credit_note: true,
        subtotal: 8000,
        vat_amount: 0,
        total: 8000,
      })
      const items = [makeItem({ line_total: 8000, account_number: '6310', vat_rate: 0.25, vat_amount: 2000 })]

      await createSupplierCreditNoteEntry(
        null as never, 'company-1', 'user-1', creditNote, items, 'swedish_business'
      )

      const input = mockedCreateEntry.mock.calls[0][3]
      expect(findByAccount(input.lines, '2641')).toHaveLength(0)
      expect(findByAccount(input.lines, '6310')[0].credit_amount).toBe(8000)
      expect(findByAccount(input.lines, '2440')[0].debit_amount).toBe(8000)
      assertBalanced(input)
    })

    it(`utlägg (${treatment}): no 2641, the person is owed the gross`, () => {
      const invoice = makeSupplierInvoice({ vat_treatment: treatment, subtotal: 400, vat_amount: 0, total: 400 })
      const items = [makeItem({ line_total: 400, account_number: '6310', vat_rate: 0.25, vat_amount: 100 })]

      const lines = buildSupplierInvoicePrivatelyPaidLines(invoice, items, '2893', DESC)

      expect(lines.filter((l) => l.account_number === '2641')).toHaveLength(0)
      expect(lines.find((l) => l.account_number === '6310')?.debit_amount).toBe(400)
      expect(lines.find((l) => l.account_number === '2893')?.credit_amount).toBe(400)
    })
  }

  it('standard_25 is untouched: 2641 still books', async () => {
    const invoice = makeSupplierInvoice({ vat_treatment: 'standard_25', subtotal: 8000, vat_amount: 2000, total: 10000 })
    const items = [makeItem({ line_total: 8000, account_number: '6310', vat_rate: 0.25 })]

    await createSupplierInvoiceRegistrationEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'swedish_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(findByAccount(input.lines, '2641')[0].debit_amount).toBe(2000)
    expect(findByAccount(input.lines, '2440')[0].credit_amount).toBe(10000)
    assertBalanced(input)
  })

  it('reverse charge is untouched: fiktiv 2645/2614 pair still books', async () => {
    const invoice = makeSupplierInvoice({
      vat_treatment: 'reverse_charge',
      reverse_charge: true,
      subtotal: 8000,
      vat_amount: 0,
      total: 8000,
    })
    const items = [makeItem({ line_total: 8000, account_number: '6540', vat_rate: 0, vat_amount: 0 })]

    await createSupplierInvoiceRegistrationEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'eu_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(findByAccount(input.lines, '2645')[0].debit_amount).toBe(2000)
    expect(findByAccount(input.lines, '2614')[0].credit_amount).toBe(2000)
    expect(findByAccount(input.lines, '2641')).toHaveLength(0)
    assertBalanced(input)
  })
})


describe('supplier payment bank origins', () => {
  it.each(['cash', 'accrual'])('preserves the bank source for %s payments', async kind => {
    vi.clearAllMocks()
    mockedFindFiscalPeriod.mockResolvedValue('period-1')
    const invoice = makeSupplierInvoice()
    const tx = { id: 'tx-source', cash_account_id: 'cash-source', date: '2024-06-15', amount: -10000, currency: 'SEK' as const }
    if (kind === 'cash') await createSupplierInvoiceCashEntry(null as never, 'company-1', 'user-1', invoice,
      [makeItem()], tx.date, 'swedish_business', undefined, '1940', undefined, tx)
    else await createSupplierInvoicePaymentEntry(null as never, 'company-1', 'user-1', invoice,
      10000, tx.date, undefined, undefined, '1940', tx)
    expect(mockedCreateEntry.mock.calls[0][3]).toMatchObject({ source_id: invoice.id, bank_booking_context: [{
      transaction_id: tx.id, cash_account_id: tx.cash_account_id, settlement_account: '1940',
      date: tx.date, amount: tx.amount, currency: tx.currency,
    }] })
  })
})

// ============================================================
// #73: an EU goods acquisition under kontantmetoden reports its moms in the
// invoice's period (ML 2023:200 7 kap. 26 and 40 §§), not at payment
// ============================================================

describe('kontantmetoden: EU goods registered in March and paid in May (#73)', () => {
  const kontant = { accounting_method: 'cash' }
  const vatAccounts = (lines: CreateJournalEntryLineInput[]) =>
    lines.filter((l) => /^26/.test(l.account_number) || /^45/.test(l.account_number)).map((l) => l.account_number).sort()

  beforeEach(() => {
    vi.clearAllMocks()
    mockedFindFiscalPeriod.mockResolvedValue('period-1')
  })

  it('books the reverse-charge moms on the March invoice date; the May payment only clears 2440', async () => {
    const { supplierInvoiceBooksOnRegistration } = await import('../booking-mode')
    const { planSupplierBankMatch } = await import('@/lib/invoices/apply-supplier-payment')
    const invoice = makeSupplierInvoice({
      invoice_date: '2026-03-10', due_date: '2026-05-20',
      subtotal: 1000, vat_amount: 0, total: 1000, remaining_amount: 1000,
      reverse_charge: true, reverse_charge_kind: 'eu_goods',
    })
    const items = [makeItem({ line_total: 1000, account_number: '4010', vat_rate: 0 })]

    // Registering it posts now, under kontantmetoden too.
    expect(supplierInvoiceBooksOnRegistration(kontant, invoice, 'eu_business')).toBe(true)
    const registration = await createSupplierInvoiceRegistrationEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'eu_business',
    )
    const reg = mockedCreateEntry.mock.calls[0][3]
    expect(reg.entry_date).toBe('2026-03-10')
    expect(mockedFindFiscalPeriod).toHaveBeenCalledWith(null, 'company-1', '2026-03-10')
    // Ruta 20 (4515), ruta 30 (2614) and ruta 48 (2645), all in March.
    expect(vatAccounts(reg.lines)).toEqual(['2614', '2645', '4515', '4598'])
    expect(findByAccount(reg.lines, '2614')[0].credit_amount).toBe(250)
    expect(findByAccount(reg.lines, '2645')[0].debit_amount).toBe(250)
    expect(findByAccount(reg.lines, '2440')[0].credit_amount).toBe(1000)
    assertBalanced(reg)

    // Every payment door routes on the registration link: a clearing, not
    // the kontantmetoden cash entry that would book the moms again in May.
    const planned = planSupplierBankMatch({
      invoice: { ...invoice, registration_journal_entry_id: registration!.id },
      transaction: { amount: -1000, currency: 'SEK' },
      accountingMethod: 'cash',
    })
    expect(planned.ok && planned.plan.booking.kind).toBe('clearing')

    await createSupplierInvoicePaymentEntry(null as never, 'company-1', 'user-1', invoice, 1000, '2026-05-20', undefined, undefined, '1930')
    const pay = mockedCreateEntry.mock.calls[1][3]
    expect(pay.entry_date).toBe('2026-05-20')
    expect(vatAccounts(pay.lines)).toEqual([])
    expect(findByAccount(pay.lines, '2440')[0].debit_amount).toBe(1000)
    expect(findByAccount(pay.lines, '1930')[0].credit_amount).toBe(1000)
    assertBalanced(pay)
  })

  it('an EU service stays at payment under kontantmetoden (7 kap. 16 § andra stycket, 34 §)', async () => {
    const { supplierInvoiceBooksOnRegistration } = await import('../booking-mode')
    const invoice = makeSupplierInvoice({
      invoice_date: '2026-03-10', subtotal: 1000, vat_amount: 0, total: 1000,
      reverse_charge: true, reverse_charge_kind: 'eu_services',
    })
    const items = [makeItem({ line_total: 1000, account_number: '6540', vat_rate: 0 })]

    expect(supplierInvoiceBooksOnRegistration(kontant, invoice, 'eu_business')).toBe(false)
    await createSupplierInvoiceCashEntry(null as never, 'company-1', 'user-1', invoice, items, '2026-05-20', 'eu_business', undefined, '1930')
    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.entry_date).toBe('2026-05-20')
    expect(vatAccounts(input.lines)).toEqual(['2614', '2645', '4535', '4598'])
    assertBalanced(input)
  })

  it('a domestic invoice stays at payment under kontantmetoden, with its 2641', async () => {
    const { supplierInvoiceBooksOnRegistration } = await import('../booking-mode')
    const invoice = makeSupplierInvoice({ invoice_date: '2026-03-10', subtotal: 1000, vat_amount: 250, total: 1250 })
    const items = [makeItem({ line_total: 1000, account_number: '4010', vat_rate: 0.25 })]

    expect(supplierInvoiceBooksOnRegistration(kontant, invoice, 'swedish_business')).toBe(false)
    await createSupplierInvoiceCashEntry(null as never, 'company-1', 'user-1', invoice, items, '2026-05-20', 'swedish_business', undefined, '1930')
    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.entry_date).toBe('2026-05-20')
    expect(findByAccount(input.lines, '2641')[0].debit_amount).toBe(250)
    expect(findByAccount(input.lines, '1930')[0].credit_amount).toBe(1250)
    assertBalanced(input)
  })

  it('faktureringsmetoden registers every supplier invoice, as before', async () => {
    const { supplierInvoiceBooksOnRegistration } = await import('../booking-mode')
    const accrual = { accounting_method: 'accrual' }
    expect(supplierInvoiceBooksOnRegistration(accrual, { reverse_charge: true, reverse_charge_kind: 'eu_goods' }, 'eu_business')).toBe(true)
    expect(supplierInvoiceBooksOnRegistration(accrual, { reverse_charge: true, reverse_charge_kind: 'eu_services' }, 'eu_business')).toBe(true)
    expect(supplierInvoiceBooksOnRegistration(accrual, { reverse_charge: false }, 'swedish_business')).toBe(true)
  })
})

// ============================================================
// #93: ML 2023:200 7 kap. 26 and 40 §§ report an EU goods acquisition's moms
// at the latest for the period holding the 15th of the month after the
// delivery month, so a late invoice's registration is dated on that 15th
// ============================================================

describe('EU goods registration: at the latest the 15th of the month after delivery (#93)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedFindFiscalPeriod.mockResolvedValue('period-1')
  })

  const items = [makeItem({ line_total: 1000, account_number: '4010', vat_rate: 0 })]
  const euGoods = (overrides: Partial<SupplierInvoice>) => makeSupplierInvoice({
    subtotal: 1000, vat_amount: 0, total: 1000, remaining_amount: 1000,
    reverse_charge: true, reverse_charge_kind: 'eu_goods', ...overrides,
  })

  it.each([
    ['kontantmetoden', { accounting_method: 'cash' }],
    ['faktureringsmetoden', { accounting_method: 'accrual' }],
  ])('dates a January delivery invoiced in March on 15 February under %s', async (_label, settings) => {
    const { supplierInvoiceBooksOnRegistration } = await import('../booking-mode')
    const invoice = euGoods({ invoice_date: '2026-03-05', delivery_date: '2026-01-10' })
    expect(supplierInvoiceBooksOnRegistration(settings, invoice, 'eu_business')).toBe(true)

    await createSupplierInvoiceRegistrationEntry(null as never, 'company-1', 'user-1', invoice, items, 'eu_business')
    const reg = mockedCreateEntry.mock.calls[0][3]
    expect(reg.entry_date).toBe('2026-02-15')
    expect(mockedFindFiscalPeriod).toHaveBeenCalledWith(null, 'company-1', '2026-02-15')
    // The same verifikat, only its date moves: ruta 20, 30 and 48 in February.
    expect(findByAccount(reg.lines, '4515')[0].debit_amount).toBe(1000)
    expect(findByAccount(reg.lines, '2614')[0].credit_amount).toBe(250)
    expect(findByAccount(reg.lines, '2645')[0].debit_amount).toBe(250)
    expect(findByAccount(reg.lines, '2440')[0].credit_amount).toBe(1000)
    assertBalanced(reg)
  })

  it('keeps the invoice date for an invoice issued by the 15th, and without a delivery date', async () => {
    await createSupplierInvoiceRegistrationEntry(
      null as never, 'company-1', 'user-1', euGoods({ invoice_date: '2026-02-10', delivery_date: '2026-01-10' }), items, 'eu_business',
    )
    await createSupplierInvoiceRegistrationEntry(
      null as never, 'company-1', 'user-1', euGoods({ invoice_date: '2026-03-05', delivery_date: null }), items, 'eu_business',
    )
    expect(mockedCreateEntry.mock.calls[0][3].entry_date).toBe('2026-02-10')
    expect(mockedCreateEntry.mock.calls[1][3].entry_date).toBe('2026-03-05')
  })

  it('keeps the invoice date of an EU service whatever its delivery date', async () => {
    const invoice = euGoods({ invoice_date: '2026-03-05', delivery_date: '2026-01-10', reverse_charge_kind: 'eu_services' })
    await createSupplierInvoiceRegistrationEntry(
      null as never, 'company-1', 'user-1', invoice, [makeItem({ line_total: 1000, account_number: '6540', vat_rate: 0 })], 'eu_business',
    )
    expect(mockedCreateEntry.mock.calls[0][3].entry_date).toBe('2026-03-05')
  })

  it('answers null (no fiscal period) when no year covers the registration date', async () => {
    mockedFindFiscalPeriod.mockResolvedValue(null)
    const input = await buildSupplierInvoiceRegistrationEntryInput(
      null as never, 'company-1', euGoods({ invoice_date: '2026-01-20', delivery_date: '2025-11-20' }), items, 'eu_business',
    )
    expect(input).toBeNull()
    expect(mockedFindFiscalPeriod).toHaveBeenCalledWith(null, 'company-1', '2025-12-15')
  })
})
