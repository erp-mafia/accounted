import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupplierInvoiceItem, CreateJournalEntryLineInput, CreateJournalEntryInput } from '@/types'
import { makeSupplierInvoice } from '@/tests/helpers'

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

// Mock vat-entries: keep the real pure helpers (resolveReverseChargeRate,
// isReverseChargeBasisAccount, RC_BASIS_ACCOUNTS) and stub only the two
// line-builders with simplified logic the assertions below rely on.
vi.mock('../vat-entries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../vat-entries')>()
  return {
    ...actual,
    generateReverseChargeLines: vi.fn().mockImplementation(
    (baseAmount: number, vatRate: number = 0.25, isDomestic: boolean = false) => {
      const vatAmount = Math.round(baseAmount * vatRate * 100) / 100
      const inputAccount = isDomestic ? '2647' : '2645'
      let outputAccount: string
      switch (vatRate) {
        case 0.12: outputAccount = '2624'; break
        case 0.06: outputAccount = '2634'; break
        default: outputAccount = '2614'; break
      }
      const context = isDomestic ? 'omvänd skattskyldighet i Sverige' : 'omvänd skattskyldighet'
      return [
        { account_number: inputAccount, debit_amount: vatAmount, credit_amount: 0, line_description: `Fiktiv ingående moms ${vatRate * 100}% (${context})` },
        { account_number: outputAccount, debit_amount: 0, credit_amount: vatAmount, line_description: `Fiktiv utgående moms ${vatRate * 100}% (${context})` },
      ]
    }
  ),
  generateReverseChargeBasisLines: vi.fn().mockImplementation(
    (baseAmount: number, vatRate: number = 0.25, supplierType: 'eu_business' | 'non_eu_business' | 'swedish_business') => {
      if (baseAmount <= 0) return []
      const rateIdx = vatRate === 0.25 ? 0 : vatRate === 0.12 ? 1 : vatRate === 0.06 ? 2 : -1
      if (rateIdx < 0) return []
      const accounts = {
        eu_business: ['4535', '4536', '4537'],
        non_eu_business: ['4531', '4532', '4533'],
        swedish_business: ['4425', '4426', '4427'],
      }[supplierType]
      const amount = Math.round(baseAmount * 100) / 100
      return [
        { account_number: accounts[rateIdx], debit_amount: amount, credit_amount: 0, line_description: `basbelopp ${vatRate * 100}%` },
        { account_number: '4598', debit_amount: 0, credit_amount: amount, line_description: `motkonto ${vatRate * 100}%` },
      ]
    }
  ),
  }
})

const { createJournalEntry, findFiscalPeriod } = await import('../engine')
const mockedCreateEntry = vi.mocked(createJournalEntry)
const mockedFindFiscalPeriod = vi.mocked(findFiscalPeriod)

const {
  createSupplierInvoiceRegistrationEntry,
  createSupplierInvoicePaymentEntry,
  createSupplierInvoiceCashEntry,
  createSupplierCreditNoteEntry,
  createSupplierInvoicePrivatelyPaidEntry,
} = await import('../supplier-invoice-entries')

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
    // Avgörande: 1 250 (manual) — INTE 2 500 (10 000 × 0.25).
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
    // RC: fiktiv moms beräknas alltid på basbeloppet med lagstadgad sats —
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

    // Basbeloppsrader för ruta 21 (EU tjänster huvudregeln) — utan dessa
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

  it('books reverse charge VAT for a 0%-rate line item — defaults to 25% huvudregeln (regression)', async () => {
    // The exact reported bug: a Finnish (EU) supplier invoice entered with the
    // line at 0% momssats (the supplier charges no VAT) must still self-assess
    // at 25%. Before the fix the `rate > 0` guard skipped ALL VAT lines, so the
    // verifikat was just expense + 2440 — the user had to add VAT lines by hand.
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
    // Basbeloppsrader for ruta 21 (EU services) — required or SKV rejects FK004.
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
    expect(input.description).toBe('Leverantörsfaktura LF-100, Leverantör AB (ankomst 5)')
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
    expect(input.description).toBe('Leverantörsfaktura LF-100 (ankomst 5)')
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
    // not add parallel basbeloppsrader on 4425/4598 — that would double the
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
    )

    expect(result).toBeNull()
    expect(mockedCreateEntry).not.toHaveBeenCalled()
  })

  it('creates standard SEK payment (2 lines)', async () => {
    const invoice = makeSupplierInvoice({ total: 10000 })

    await createSupplierInvoicePaymentEntry(
      null as never, 'company-1', 'user-1', invoice, 10000, '2024-07-01'
    )

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
    )

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
    )

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
    )

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
    )

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
    )

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
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.description).toBe('Utbetalning leverantörsfaktura LF-200, Leverantör AB (ankomst 10)')
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
    )

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
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.entry_date).toBe('2024-08-15')
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
    )

    expect(result).toBeNull()
    expect(mockedCreateEntry).not.toHaveBeenCalled()
  })

  it('domestic with VAT — credits 1930 (not 2440)', async () => {
    const invoice = makeSupplierInvoice({
      subtotal: 8000,
      vat_amount: 2000,
      total: 10000,
    })
    const items = [makeItem({ line_total: 8000, account_number: '6200', vat_rate: 0.25 })]

    await createSupplierInvoiceCashEntry(
      null as never, 'company-1', 'user-1', invoice, items, '2024-07-01', 'swedish_business'
    )

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
    )

    const input = mockedCreateEntry.mock.calls[0][3]

    expect(findByAccount(input.lines, '5410')[0].debit_amount).toBe(5000)
    expect(findByAccount(input.lines, '1930')[0].credit_amount).toBe(5000)
    expect(findByAccount(input.lines, '2641')).toHaveLength(0)

    assertBalanced(input)
  })

  it('EU reverse charge — credits 1930', async () => {
    const invoice = makeSupplierInvoice({
      subtotal: 10000,
      vat_amount: 0,
      total: 10000,
      reverse_charge: true,
    })
    const items = [makeItem({ line_total: 10000, account_number: '6540', vat_rate: 0.25 })]

    await createSupplierInvoiceCashEntry(
      null as never, 'company-1', 'user-1', invoice, items, '2024-07-01', 'eu_business'
    )

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

  it('EU reverse charge with a 0%-rate line item self-assesses at 25% (regression)', async () => {
    const invoice = makeSupplierInvoice({
      subtotal: 12000, vat_amount: 0, total: 12000, reverse_charge: true,
    })
    const items = [makeItem({ line_total: 12000, account_number: '5910', vat_rate: 0, reverse_charge_rate: null })]

    await createSupplierInvoiceCashEntry(
      null as never, 'company-1', 'user-1', invoice, items, '2024-07-01', 'eu_business'
    )

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
    )

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
    )

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
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.source_type).toBe('supplier_invoice_cash_payment')
    expect(input.source_id).toBe('si-cash-1')
  })

  it('description includes supplier name when provided', async () => {
    const invoice = makeSupplierInvoice({ supplier_invoice_number: 'LF-300' })
    const items = [makeItem()]

    await createSupplierInvoiceCashEntry(
      null as never, 'company-1', 'user-1', invoice, items, '2024-07-01', 'swedish_business', 'Leverantör AB'
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.description).toBe('Kontantbetalning leverantörsfaktura LF-300, Leverantör AB')
  })

  it('description falls back without supplier name', async () => {
    const invoice = makeSupplierInvoice({ supplier_invoice_number: 'LF-300' })
    const items = [makeItem()]

    await createSupplierInvoiceCashEntry(
      null as never, 'company-1', 'user-1', invoice, items, '2024-07-01', 'swedish_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.description).toBe('Kontantbetalning leverantörsfaktura LF-300')
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
      subtotal: -8000,
      vat_amount: -2000,
      total: -10000,
    })
    const items = [makeItem({ line_total: -8000, account_number: '6200', vat_rate: 0.25 })]

    await createSupplierCreditNoteEntry(
      null as never, 'company-1', 'user-1', creditNote, items, 'swedish_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]

    const debit2440 = findByAccount(input.lines, '2440')[0]
    expect(debit2440.debit_amount).toBe(10000) // abs
    expect(debit2440.credit_amount).toBe(0)

    const credit6200 = findByAccount(input.lines, '6200')[0]
    expect(credit6200.credit_amount).toBe(8000) // abs
    expect(credit6200.debit_amount).toBe(0)

    const credit2641 = findByAccount(input.lines, '2641')[0]
    expect(credit2641.credit_amount).toBe(2000) // abs(8000) * 0.25
    expect(credit2641.debit_amount).toBe(0)

    assertBalanced(input)
  })

  it('domestic zero VAT', async () => {
    const creditNote = makeSupplierInvoice({
      is_credit_note: true,
      subtotal: -5000,
      vat_amount: 0,
      total: -5000,
    })
    const items = [makeItem({ line_total: -5000, account_number: '6200', vat_rate: 0 })]

    await createSupplierCreditNoteEntry(
      null as never, 'company-1', 'user-1', creditNote, items, 'swedish_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]

    expect(findByAccount(input.lines, '2440')[0].debit_amount).toBe(5000)
    expect(findByAccount(input.lines, '6200')[0].credit_amount).toBe(5000)
    expect(findByAccount(input.lines, '2641')).toHaveLength(0)

    assertBalanced(input)
  })

  it('EU reverse charge reversal (C 2645, D 2614, reverses 4535/4598 basis)', async () => {
    const creditNote = makeSupplierInvoice({
      is_credit_note: true,
      subtotal: -10000,
      vat_amount: 0,
      total: -10000,
      reverse_charge: true,
    })
    const items = [makeItem({ line_total: -10000, account_number: '6540', vat_rate: 0.25 })]

    await createSupplierCreditNoteEntry(
      null as never, 'company-1', 'user-1', creditNote, items, 'eu_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]

    // Reversed fiktiv moms
    const credit2645 = findByAccount(input.lines, '2645')[0]
    expect(credit2645.credit_amount).toBe(2500) // abs(10000) * 0.25
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
      subtotal: -12000,
      vat_amount: 0,
      total: -12000,
      reverse_charge: true,
    })
    const items = [makeItem({ line_total: -12000, account_number: '5910', vat_rate: 0, reverse_charge_rate: null })]

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

  it('uses Math.abs for all amounts (negative inputs produce positive lines)', async () => {
    const creditNote = makeSupplierInvoice({
      is_credit_note: true,
      total: -7500,
      vat_amount: 0,
    })
    const items = [makeItem({ line_total: -7500, account_number: '6200', vat_rate: 0 })]

    await createSupplierCreditNoteEntry(
      null as never, 'company-1', 'user-1', creditNote, items, 'swedish_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    for (const line of input.lines) {
      expect(line.debit_amount).toBeGreaterThanOrEqual(0)
      expect(line.credit_amount).toBeGreaterThanOrEqual(0)
    }
  })

  it('2440 line is first (unshift)', async () => {
    const creditNote = makeSupplierInvoice({
      is_credit_note: true,
      total: -10000,
      vat_amount: -2000,
    })
    const items = [makeItem({ line_total: -8000, account_number: '6200', vat_rate: 0.25 })]

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
      total: -10000,
      vat_amount: -2000,
    })
    const items = [makeItem({ line_total: -8000, account_number: '6200', vat_rate: 0.25 })]

    await createSupplierCreditNoteEntry(
      null as never, 'company-1', 'user-1', creditNote, items, 'swedish_business', 'Leverantör AB'
    )

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.description).toBe('Kreditfaktura leverantör LF-400, Leverantör AB (ankomst 7)')
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
      total: -15000,
      reverse_charge: true,
    })
    const items = [
      makeItem({ line_total: -10000, vat_rate: 0.25, account_number: '6540' }),
      makeItem({ id: 'item-2', line_total: -5000, vat_rate: 0.12, account_number: '5410' }),
    ]

    await createSupplierCreditNoteEntry(
      null as never, 'company-1', 'user-1', creditNote, items, 'eu_business'
    )

    const input = mockedCreateEntry.mock.calls[0][3]

    // 2645 credit lines: 2 (one per rate)
    const vat2645 = findByAccount(input.lines, '2645')
    expect(vat2645).toHaveLength(2)

    // 2614 debit (25%): abs(10000) * 0.25 = 2500
    expect(findByAccount(input.lines, '2614')[0].debit_amount).toBe(2500)
    // 2624 debit (12%): abs(5000) * 0.12 = 600
    expect(findByAccount(input.lines, '2624')[0].debit_amount).toBe(600)

    assertBalanced(input)
  })
})

// ============================================================
// createSupplierInvoicePrivatelyPaidEntry — eget utlägg
// ============================================================

describe('createSupplierInvoicePrivatelyPaidEntry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedFindFiscalPeriod.mockResolvedValue('period-1')
  })

  it('returns null when no fiscal period found', async () => {
    mockedFindFiscalPeriod.mockResolvedValue(null)
    const invoice = makeSupplierInvoice()
    const items = [makeItem()]

    const result = await createSupplierInvoicePrivatelyPaidEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'aktiebolag'
    )

    expect(result).toBeNull()
    expect(mockedCreateEntry).not.toHaveBeenCalled()
  })

  it('AB: credits 2893 (D expense + D 2641 + C 2893)', async () => {
    const invoice = makeSupplierInvoice({
      subtotal: 400,
      vat_amount: 100,
      total: 500,
    })
    const items = [makeItem({ line_total: 400, account_number: '6110', vat_rate: 0.25 })]

    await createSupplierInvoicePrivatelyPaidEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'aktiebolag', 'Pressbyrån'
    )

    expect(mockedCreateEntry).toHaveBeenCalledOnce()
    const input = mockedCreateEntry.mock.calls[0][3]

    expect(input.source_type).toBe('supplier_invoice_privately_paid')

    const debit6110 = findByAccount(input.lines, '6110')
    expect(debit6110).toHaveLength(1)
    expect(debit6110[0].debit_amount).toBe(400)

    const debit2641 = findByAccount(input.lines, '2641')
    expect(debit2641).toHaveLength(1)
    expect(debit2641[0].debit_amount).toBe(100)

    const credit2893 = findByAccount(input.lines, '2893')
    expect(credit2893).toHaveLength(1)
    expect(credit2893[0].credit_amount).toBe(500)

    // AP account 2440 must NOT appear — privately-paid bypasses AP entirely.
    expect(findByAccount(input.lines, '2440')).toHaveLength(0)
    // Bank account 1930 must NOT appear — the owner paid, not the company.
    expect(findByAccount(input.lines, '1930')).toHaveLength(0)
    // EF owner account 2018 must NOT appear for AB.
    expect(findByAccount(input.lines, '2018')).toHaveLength(0)

    assertBalanced(input)
  })

  it('EF: credits 2018 instead of 2893', async () => {
    const invoice = makeSupplierInvoice({
      subtotal: 400,
      vat_amount: 100,
      total: 500,
    })
    const items = [makeItem({ line_total: 400, account_number: '6110', vat_rate: 0.25 })]

    await createSupplierInvoicePrivatelyPaidEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'enskild_firma', 'Pressbyrån'
    )

    const input = mockedCreateEntry.mock.calls[0][3]

    const credit2018 = findByAccount(input.lines, '2018')
    expect(credit2018).toHaveLength(1)
    expect(credit2018[0].credit_amount).toBe(500)

    expect(findByAccount(input.lines, '2893')).toHaveLength(0)
    expect(findByAccount(input.lines, '2440')).toHaveLength(0)

    assertBalanced(input)
  })

  it('skips 2641 line when invoice has zero VAT', async () => {
    const invoice = makeSupplierInvoice({
      subtotal: 500,
      vat_amount: 0,
      total: 500,
    })
    const items = [makeItem({ line_total: 500, account_number: '5460', vat_rate: 0 })]

    await createSupplierInvoicePrivatelyPaidEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'aktiebolag'
    )

    const input = mockedCreateEntry.mock.calls[0][3]

    expect(findByAccount(input.lines, '5460')[0].debit_amount).toBe(500)
    expect(findByAccount(input.lines, '2641')).toHaveLength(0)
    expect(findByAccount(input.lines, '2893')[0].credit_amount).toBe(500)

    assertBalanced(input)
  })

  it('handles mixed-rate kvitto with separate 2641 lines per rate', async () => {
    // Lunch (12%) + parking (25%) on the same kvitto
    const invoice = makeSupplierInvoice({
      subtotal: 200,
      vat_amount: 36, // 100*0.12 + 100*0.25 = 12 + 25 = 37; off-by-one from rounding
      total: 237,
    })
    const items = [
      makeItem({ line_total: 100, account_number: '5810', vat_rate: 0.12 }),
      makeItem({ line_total: 100, account_number: '5611', vat_rate: 0.25 }),
    ]

    await createSupplierInvoicePrivatelyPaidEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'aktiebolag'
    )

    const input = mockedCreateEntry.mock.calls[0][3]

    // One 2641 line per rate
    const vat2641 = findByAccount(input.lines, '2641')
    expect(vat2641).toHaveLength(2)

    // Credit 2893 = sum of all debits
    const totalDebits = input.lines.reduce((sum, l) => sum + l.debit_amount, 0)
    const credit2893 = findByAccount(input.lines, '2893')[0]
    expect(Math.round(credit2893.credit_amount * 100)).toBe(Math.round(totalDebits * 100))

    assertBalanced(input)
  })

  it('aggregates expense lines per account number', async () => {
    // Two items on the same expense account should collapse to one debit line
    const invoice = makeSupplierInvoice({
      subtotal: 600,
      vat_amount: 150,
      total: 750,
    })
    const items = [
      makeItem({ line_total: 300, account_number: '6110', vat_rate: 0.25 }),
      makeItem({ line_total: 300, account_number: '6110', vat_rate: 0.25 }),
    ]

    await createSupplierInvoicePrivatelyPaidEntry(
      null as never, 'company-1', 'user-1', invoice, items, 'aktiebolag'
    )

    const input = mockedCreateEntry.mock.calls[0][3]

    const debit6110 = findByAccount(input.lines, '6110')
    expect(debit6110).toHaveLength(1)
    expect(debit6110[0].debit_amount).toBe(600)
  })
})
