import { describe, expect, it } from 'vitest'
import type { SpendExpenseKind } from '@accounted/connect-contract'
import { roundOre } from '@/lib/money'
import { chartVatTreatmentsOf } from '@/lib/bookkeeping/vat-entries'
import type { CreateJournalEntryLineInput } from '@/types'
import {
  NO_ENTRY_KINDS,
  buildSpendItemEntry,
  evaluateSpendExpense,
  resolveWalletAccount,
  spendItemDescription,
  spendItemNotes,
  type SpendEntryContext,
  type SpendEvaluationContext,
} from '../evaluate'
import { DEFAULT_SPEND_SETTINGS } from '../settings'
import type { SpendExpenseModel } from '../types'
import { SIMPLIFIED_RECEIPT_VAT_LIMIT } from '../vat-codes'

const RECEIPT = {
  fileRef: 'file-1',
  name: 'kvitto.pdf',
  contentType: 'application/pdf',
  size: 48_213,
  sha256: 'a'.repeat(64),
  downloadUrl: 'https://files.example.test/file-1',
  downloadExpiresAt: '2026-10-17T12:00:00Z',
}

type Line = SpendExpenseModel['lines'][number]

function line(overrides: Partial<Line> = {}): Line {
  return {
    account: '5410',
    amount: 1250,
    vat: { code: 'SE25', type: 'standard', rate: 0.25, amount: 250 },
    dimensions: {},
    description: null,
    ...overrides,
  }
}

function expense(overrides: Partial<SpendExpenseModel> = {}): SpendExpenseModel {
  return {
    externalId: 'exp-1',
    batchRef: 'job-1',
    kind: 'card_purchase',
    subKind: null,
    date: '2026-10-14',
    currency: 'SEK',
    amount: 1250,
    original: null,
    walletAccount: '1940',
    lines: [line()],
    merchant: { name: 'Clas Ohlson', country: 'SE', taxId: null, categoryCode: null },
    person: { name: 'Anna Berg', ref: null },
    note: null,
    attendees: [],
    reference: 'P-1001',
    settles: [],
    files: [RECEIPT],
    providerUrl: null,
    issues: [],
    ...overrides,
  }
}

const BOOKABLE = new Set([
  '1610', '1685', '1910', '1930', '1940', '1941', '2013', '2820', '2893',
  '4010', '5410', '5460', '5800', '6071', '6540', '6570', '7331',
])

function ctx(overrides: Partial<SpendEvaluationContext> = {}): SpendEvaluationContext {
  return {
    isBookableAccount: (account) => BOOKABLE.has(account),
    vatRegistered: true,
    settings: DEFAULT_SPEND_SETTINGS,
    providerName: 'Pleo',
    period: { locked: false, hasFiscalPeriod: true },
    dimensionProblem: null,
    ...overrides,
  }
}

const EMPTY_CHART = chartVatTreatmentsOf([])

function entryCtx(overrides: Partial<SpendEntryContext> = {}): SpendEntryContext {
  return { settings: DEFAULT_SPEND_SETTINGS, vatRegistered: true, chart: EMPTY_CHART, ...overrides }
}

function sides(lines: CreateJournalEntryLineInput[]) {
  return lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])
}

const sum = (values: number[]) => roundOre(values.reduce((a, b) => a + b, 0))

/** sum(debit) === sum(credit) > 0, one side per line, every amount to the öre. */
function expectBalanced(lines: CreateJournalEntryLineInput[]) {
  const debit = sum(lines.map((l) => l.debit_amount))
  const credit = sum(lines.map((l) => l.credit_amount))
  expect(debit).toBe(credit)
  expect(debit).toBeGreaterThan(0)
  for (const l of lines) {
    expect(l.debit_amount).toBeGreaterThanOrEqual(0)
    expect(l.credit_amount).toBeGreaterThanOrEqual(0)
    expect(l.debit_amount === 0 || l.credit_amount === 0).toBe(true)
    expect(roundOre(l.debit_amount)).toBe(l.debit_amount)
    expect(roundOre(l.credit_amount)).toBe(l.credit_amount)
  }
}

describe('evaluateSpendExpense', () => {
  it('is ready for a coded card purchase with its receipt', () => {
    expect(evaluateSpendExpense(expense(), ctx())).toEqual({ status: 'ready', reasons: [], rejection: null })
  })

  it.each(['wallet_topup', 'wallet_unload', 'external_reimbursement'] as const)(
    '%s moves money between own accounts: no_entry, booked from the bank row',
    (kind) => {
      expect(NO_ENTRY_KINDS.has(kind)).toBe(true)
      // Nothing else is checked: not the currency, the wallet or the period.
      const evaluation = evaluateSpendExpense(
        expense({ kind, currency: 'EUR', walletAccount: null, lines: [] }),
        ctx({ period: { locked: true, hasFiscalPeriod: false } }),
      )
      expect(evaluation).toEqual({ status: 'no_entry', reasons: [], rejection: null })
    },
  )

  describe('sends back to the provider what cannot be booked here', () => {
    const cases: Array<[string, Partial<SpendExpenseModel>, Partial<SpendEvaluationContext>, string, Record<string, string | number>]> = [
      ['a supplier invoice', { kind: 'invoice' }, {}, 'kind_unsupported', { kind: 'invoice' }],
      ['an invoice payment', { kind: 'invoice_payment' }, {}, 'kind_unsupported', { kind: 'invoice_payment' }],
      ['a balance adjustment', { kind: 'balance_adjustment' }, {}, 'kind_unsupported', { kind: 'balance_adjustment' }],
      ['an unrecognised type', { kind: 'other' }, {}, 'kind_unsupported', { kind: 'other' }],
      ['a wallet in another currency', { currency: 'EUR' }, {}, 'currency_unsupported', { currency: 'EUR' }],
      ['no lines at all', { lines: [] }, {}, 'account_missing', {}],
      ['a line without an account', { lines: [line({ account: null })] }, {}, 'account_missing', {}],
      ['an account the company cannot book on', { lines: [line({ account: '9999' })] }, {}, 'account_unknown', { account: '9999' }],
      ['a line without VAT', { lines: [line({ vat: null })] }, {}, 'vat_code_missing', {}],
      [
        'a line with a VAT type but no code',
        { lines: [line({ vat: { code: null, type: 'standard', rate: 0.25, amount: 250 } })] },
        {},
        'vat_code_missing',
        {},
      ],
      [
        'a VAT code Accounted never published',
        { lines: [line({ vat: { code: 'DE19', type: 'standard', rate: 0.19, amount: 200 } })] },
        {},
        'vat_code_unknown',
        { vat_code: 'DE19' },
      ],
      ['lines that do not add up to the expense', { amount: 1300 }, {}, 'amounts_mismatch', { lines_total: 1250, amount: 1300 }],
      ['no account for the wallet anywhere', { walletAccount: null }, {}, 'wallet_account_unknown', {}],
      ['a wallet account the company cannot book on', { walletAccount: '1999' }, {}, 'account_unknown', { account: '1999' }],
      [
        'an utlägg account the company cannot book on',
        { kind: 'out_of_pocket' },
        { settings: { ...DEFAULT_SPEND_SETTINGS, out_of_pocket_account: '2899' } },
        'account_unknown',
        { account: '2899' },
      ],
      ['a locked period', {}, { period: { locked: true, hasFiscalPeriod: true } }, 'period_locked', { date: '2026-10-14' }],
      [
        'a dimension value the registry refuses',
        {},
        { dimensionProblem: { dimension: 'Kostnadsställe', value: 'K99' } },
        'dimension_unknown',
        { dimension: 'Kostnadsställe', value: 'K99' },
      ],
    ]

    it.each(cases)('%s', (_name, overrides, context, code, params) => {
      const evaluation = evaluateSpendExpense(expense(overrides), ctx(context))
      expect(evaluation.status).toBe('rejected')
      expect(evaluation.reasons).toEqual([{ code, params }])
      expect(evaluation.rejection?.code).toBe(code)
      // What the provider shows the person, in Swedish.
      expect(evaluation.rejection?.reasonSv.length).toBeGreaterThan(20)
    })

    it('names the kind, the account and the code in the sentence the provider shows', () => {
      expect(evaluateSpendExpense(expense({ kind: 'invoice' }), ctx()).rejection?.reasonSv).toBe(
        'Accounted tar ännu inte emot leverantörsfaktura härifrån. Bokför den direkt i Accounted.',
      )
      expect(evaluateSpendExpense(expense({ lines: [line({ account: '9999' })] }), ctx()).rejection?.reasonSv).toContain('Konto 9999')
      expect(
        evaluateSpendExpense(expense({ lines: [line({ vat: { code: 'DE19', type: 'standard', rate: 0.19, amount: 200 } })] }), ctx())
          .rejection?.reasonSv,
      ).toContain('Momskoden DE19')
      expect(evaluateSpendExpense(expense({ walletAccount: null }), ctx()).rejection?.reasonSv).toContain('Pleo')
    })

    it('rejects a VAT code a company that is not VAT registered never got', () => {
      const evaluation = evaluateSpendExpense(expense(), ctx({ vatRegistered: false }))
      expect(evaluation.reasons).toEqual([{ code: 'vat_code_unknown', params: { vat_code: 'SE25' } }])
    })

    it('matches a VAT code without regard to case, like the provider', () => {
      const lower = expense({ lines: [line({ vat: { code: 'se25', type: 'standard', rate: 0.25, amount: 250 } })] })
      expect(evaluateSpendExpense(lower, ctx()).status).toBe('ready')
    })
  })

  describe('waits for a person when the coding alone cannot decide', () => {
    it('Swedish VAT without a receipt', () => {
      const evaluation = evaluateSpendExpense(expense({ files: [] }), ctx())
      expect(evaluation.status).toBe('review')
      expect(evaluation.reasons).toEqual([{ code: 'vat_without_receipt', params: {} }])
      expect(evaluation.rejection).toBeNull()
    })

    it('reverse charge without a receipt, but not a VAT-free line without one', () => {
      const reverse = expense({
        files: [],
        merchant: { name: 'Figma', country: 'IE', taxId: 'IE1234567T', categoryCode: null },
        lines: [line({ account: '6540', amount: 1250, vat: { code: 'EUTJ', type: 'reverse', rate: 0.25, amount: 312.5 } })],
      })
      expect(evaluateSpendExpense(reverse, ctx()).reasons).toEqual([{ code: 'vat_without_receipt', params: {} }])

      const fee = expense({ kind: 'fee', amount: 49, files: [], lines: [line({ account: '6570', amount: 49, vat: { code: 'MOMSFRI', type: 'standard', rate: 0, amount: null } })] })
      expect(evaluateSpendExpense(fee, ctx()).status).toBe('ready')
    })

    it('Swedish VAT on more than a simplified receipt carries, refunds included', () => {
      const over = expense({ amount: 5000, lines: [line({ amount: 5000, vat: { code: 'SE25', type: 'standard', rate: 0.25, amount: 1000 } })] })
      expect(evaluateSpendExpense(over, ctx()).reasons).toEqual([
        { code: 'vat_over_simplified_limit', params: { amount_sek: 5000, limit_sek: SIMPLIFIED_RECEIPT_VAT_LIMIT } },
      ])

      const atLimit = expense({ amount: 4000, lines: [line({ amount: 4000, vat: { code: 'SE25', type: 'standard', rate: 0.25, amount: 800 } })] })
      expect(evaluateSpendExpense(atLimit, ctx()).status).toBe('ready')

      const refund = expense({ kind: 'refund', amount: -5000, lines: [line({ amount: -5000, vat: { code: 'SE25', type: 'standard', rate: 0.25, amount: -1000 } })] })
      expect(evaluateSpendExpense(refund, ctx()).reasons.map((r) => r.code)).toEqual(['vat_over_simplified_limit'])
    })

    it('representation, with the number of attendees', () => {
      const lunch = expense({
        amount: 1120,
        lines: [line({ account: '6071', amount: 1120, vat: { code: 'SE12', type: 'standard', rate: 0.12, amount: 120 } })],
        attendees: [
          { name: 'Anna Berg', company: null, internal: true },
          { name: 'Erik Lund', company: 'Kund AB', internal: false },
        ],
      })
      expect(evaluateSpendExpense(lunch, ctx()).reasons).toEqual([{ code: 'representation', params: { attendees: 2 } }])
    })

    it('Swedish VAT from a merchant abroad, but not foreign VAT coded as such', () => {
      const merchant = { name: 'Hotel Adlon', country: 'DE', taxId: null, categoryCode: '7011' }
      expect(evaluateSpendExpense(expense({ merchant }), ctx()).reasons).toEqual([
        { code: 'foreign_merchant_domestic_vat', params: { country: 'DE' } },
      ])
      const foreignVat = expense({ merchant, lines: [line({ vat: { code: 'UTLMOMS', type: 'standard', rate: 0, amount: null } })] })
      expect(evaluateSpendExpense(foreignVat, ctx()).status).toBe('ready')
    })

    it('a stated VAT more than a krona off the rate, but not one within it', () => {
      const off = expense({ lines: [line({ vat: { code: 'SE25', type: 'standard', rate: 0.25, amount: 200 } })] })
      expect(evaluateSpendExpense(off, ctx()).reasons).toEqual([{ code: 'vat_amount_mismatch', params: { stated_sek: 200, expected_sek: 250 } }])
      const close = expense({ lines: [line({ vat: { code: 'SE25', type: 'standard', rate: 0.25, amount: 249.5 } })] })
      expect(evaluateSpendExpense(close, ctx()).status).toBe('ready')
    })

    it.each(['mileage', 'per_diem'] as const)('%s belongs to payroll', (kind) => {
      const claim = expense({
        kind,
        amount: 750,
        walletAccount: null,
        lines: [line({ account: '7331', amount: 750, vat: { code: 'MOMSFRI', type: 'standard', rate: 0, amount: null } })],
      })
      expect(evaluateSpendExpense(claim, ctx())).toEqual({ status: 'review', reasons: [{ code: 'payroll_related', params: { kind } }], rejection: null })
    })

    it.each(['personal_spend', 'atm_withdrawal'] as const)('%s needs the person to choose the debit side', (kind) => {
      const evaluation = evaluateSpendExpense(expense({ kind, amount: 500, lines: [] }), ctx())
      expect(evaluation).toEqual({ status: 'review', reasons: [{ code: 'counter_account_needed', params: { kind } }], rejection: null })
    })

    it('a wallet account at the provider other than the one chosen here', () => {
      const evaluation = evaluateSpendExpense(
        expense({ walletAccount: '1941' }),
        ctx({ settings: { ...DEFAULT_SPEND_SETTINGS, wallet_account: '1940' } }),
      )
      expect(evaluation.reasons).toEqual([{ code: 'wallet_account_differs', params: { settings: '1940', provider: '1941' } }])
    })

    it('a date with no fiscal year yet', () => {
      const evaluation = evaluateSpendExpense(expense(), ctx({ period: { locked: false, hasFiscalPeriod: false } }))
      expect(evaluation.reasons).toEqual([{ code: 'no_fiscal_period', params: { date: '2026-10-14' } }])
    })

    it("an issue the provider reported, in the provider's own words", () => {
      const evaluation = evaluateSpendExpense(
        expense({ issues: [{ code: 'MISSING_CONTRA_ACCOUNTS', message: 'Kontokonto saknas för SEK' }] }),
        ctx(),
      )
      expect(evaluation.reasons).toEqual([
        { code: 'provider_issue', params: { code: 'MISSING_CONTRA_ACCOUNTS' }, message: 'Kontokonto saknas för SEK' },
      ])
    })

    it('collects every reason at once', () => {
      const evaluation = evaluateSpendExpense(
        expense({ files: [], merchant: { name: 'Hotel Adlon', country: 'DE', taxId: null, categoryCode: null } }),
        ctx({ period: { locked: false, hasFiscalPeriod: false } }),
      )
      expect(evaluation.status).toBe('review')
      expect(evaluation.reasons.map((r) => r.code)).toEqual(['no_fiscal_period', 'vat_without_receipt', 'foreign_merchant_domestic_vat'])
    })
  })

  it('needs no wallet for an utlägg and books no VAT question for a reimbursement', () => {
    const utlagg = expense({ kind: 'out_of_pocket', walletAccount: null })
    expect(evaluateSpendExpense(utlagg, ctx())).toEqual({ status: 'ready', reasons: [], rejection: null })
    const reimbursement = expense({ kind: 'reimbursement', lines: [], files: [] })
    expect(evaluateSpendExpense(reimbursement, ctx())).toEqual({ status: 'ready', reasons: [], rejection: null })
  })
})

describe('resolveWalletAccount', () => {
  it("takes the company's choice first, the provider's contra account second", () => {
    expect(resolveWalletAccount({ walletAccount: '1941' }, { ...DEFAULT_SPEND_SETTINGS, wallet_account: '1940' })).toBe('1940')
    expect(resolveWalletAccount({ walletAccount: '1941' }, DEFAULT_SPEND_SETTINGS)).toBe('1941')
    expect(resolveWalletAccount({ walletAccount: null }, DEFAULT_SPEND_SETTINGS)).toBeNull()
  })
})

describe('buildSpendItemEntry', () => {
  it('books Swedish VAT from the receipt on 2641 and the net on the cost account', () => {
    const entry = buildSpendItemEntry(expense(), entryCtx())
    expect(entry.problems).toEqual([])
    expect(entry.lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount, l.line_description])).toEqual([
      ['5410', 1000, 0, 'Clas Ohlson'],
      ['2641', 250, 0, 'Ingående moms 25 %'],
      ['1940', 0, 1250, 'Betalt med företagskort'],
    ])
    expectBalanced(entry.lines)
    expect(entry.deductibleVat).toBe(250)
    // Without the receipt nothing is deducted.
    expect(buildSpendItemEntry(expense({ files: [] }), entryCtx()).deductibleVat).toBe(0)
  })

  it.each([
    ['SE25', 0.25, 1250, 250, '25'],
    ['SE12', 0.12, 1120, 120, '12'],
    ['SE6', 0.06, 1060, 60, '6'],
  ] as const)('computes the VAT inside the gross at %s when the provider states none', (code, rate, gross, vat, label) => {
    const entry = buildSpendItemEntry(
      expense({ amount: gross, lines: [line({ amount: gross, vat: { code, type: 'standard', rate, amount: null } })] }),
      entryCtx(),
    )
    expect(entry.problems).toEqual([])
    expect(sides(entry.lines)).toEqual([
      ['5410', roundOre(gross - vat), 0],
      ['2641', vat, 0],
      ['1940', 0, gross],
    ])
    expect(entry.lines[1].line_description).toBe(`Ingående moms ${label} %`)
    expectBalanced(entry.lines)
  })

  it('rounds computed VAT to the öre and keeps the entry balanced', () => {
    const entry = buildSpendItemEntry(
      expense({ amount: 10.05, lines: [line({ amount: 10.05, vat: { code: 'SE12', type: 'standard', rate: 0.12, amount: null } })] }),
      entryCtx(),
    )
    expect(sides(entry.lines)).toEqual([
      ['5410', 8.97, 0],
      ['2641', 1.08, 0],
      ['1940', 0, 10.05],
    ])
    expectBalanced(entry.lines)
  })

  it('computes the VAT instead of trusting a stated VAT larger than the line', () => {
    const entry = buildSpendItemEntry(
      expense({ amount: 100, lines: [line({ amount: 100, vat: { code: 'SE25', type: 'standard', rate: 0.25, amount: 150 } })] }),
      entryCtx(),
    )
    expect(sides(entry.lines)).toEqual([
      ['5410', 80, 0],
      ['2641', 20, 0],
      ['1940', 0, 100],
    ])
  })

  it('books the gross as cost when the receipt is missing: no input VAT without a receipt', () => {
    const entry = buildSpendItemEntry(expense({ files: [] }), entryCtx())
    expect(entry.problems).toEqual([])
    expect(sides(entry.lines)).toEqual([
      ['5410', 1250, 0],
      ['1940', 0, 1250],
    ])
    expectBalanced(entry.lines)
  })

  it('books the gross for a company that is not VAT registered, which has EJMOMS in place of receipt VAT', () => {
    const entry = buildSpendItemEntry(
      expense({ lines: [line({ vat: { code: 'EJMOMS', type: 'standard', rate: 0, amount: null } })] }),
      entryCtx({ vatRegistered: false }),
    )
    expect(entry.problems).toEqual([])
    expect(sides(entry.lines)).toEqual([
      ['5410', 1250, 0],
      ['1940', 0, 1250],
    ])

    const domestic = buildSpendItemEntry(expense(), entryCtx({ vatRegistered: false }))
    expect(domestic).toEqual({ lines: [], problems: [{ code: 'vat_code_unknown', params: { vat_code: 'SE25' } }], deductibleVat: 0 })
  })

  it('books foreign VAT and VAT-free lines as gross cost with no ruta', () => {
    const entry = buildSpendItemEntry(
      expense({
        amount: 1700,
        merchant: { name: 'Hotel Adlon', country: 'DE', taxId: null, categoryCode: null },
        lines: [
          line({ account: '5800', amount: 1650, vat: { code: 'UTLMOMS', type: 'standard', rate: 0, amount: null } }),
          line({ account: '6570', amount: 50, vat: { code: 'MOMSFRI', type: 'standard', rate: 0, amount: null } }),
        ],
      }),
      entryCtx(),
    )
    expect(sides(entry.lines)).toEqual([
      ['5800', 1650, 0],
      ['6570', 50, 0],
      ['1940', 0, 1700],
    ])
  })

  describe('reverse charge through the sanctioned generator', () => {
    it.each([
      ['EUTJ', 'eu services (ruta 21)', '6540', '4535'],
      ['UTLTJ', 'non-EU services (ruta 22)', '6540', '4531'],
      ['EUVARA', 'EU goods (ruta 20)', '5460', '4515'],
    ] as const)('%s: %s books 2645 / 2614 and the basis pair beside the cost', (code, _name, cost, basis) => {
      const entry = buildSpendItemEntry(
        expense({
          amount: 1000,
          merchant: { name: 'Supplier Ltd', country: 'IE', taxId: null, categoryCode: null },
          lines: [line({ account: cost, amount: 1000, vat: { code, type: 'reverse', rate: 0.25, amount: 250 } })],
        }),
        entryCtx(),
      )
      expect(entry.problems).toEqual([])
      expect(sides(entry.lines)).toEqual([
        [cost, 1000, 0],
        ['2645', 250, 0],
        ['2614', 0, 250],
        [basis, 1000, 0],
        ['4598', 0, 1000],
        ['1940', 0, 1000],
      ])
      expectBalanced(entry.lines)
    })

    it('books reverse charge for a company that is not VAT registered too, like every other booking path', () => {
      const entry = buildSpendItemEntry(
        expense({ amount: 1000, lines: [line({ account: '6540', amount: 1000, vat: { code: 'EUTJ', type: 'reverse', rate: 0.25, amount: 250 } })] }),
        entryCtx({ vatRegistered: false }),
      )
      expect(entry.problems).toEqual([])
      expect(sides(entry.lines)).toEqual([
        ['6540', 1000, 0],
        ['2645', 250, 0],
        ['2614', 0, 250],
        ['4535', 1000, 0],
        ['4598', 0, 1000],
        ['1940', 0, 1000],
      ])
      expectBalanced(entry.lines)
    })

    it('adds no second basis pair on a cost account that reports ruta 21 itself', () => {
      const chart = chartVatTreatmentsOf([{ account_number: '6540', default_vat_treatment: 'reverse_charge_eu_services', default_vat_rate: 0.25 }])
      const entry = buildSpendItemEntry(
        expense({ amount: 1000, lines: [line({ account: '6540', amount: 1000, vat: { code: 'EUTJ', type: 'reverse', rate: 0.25, amount: 250 } })] }),
        entryCtx({ chart }),
      )
      expect(sides(entry.lines)).toEqual([
        ['6540', 1000, 0],
        ['2645', 250, 0],
        ['2614', 0, 250],
        ['1940', 0, 1000],
      ])
      expectBalanced(entry.lines)
    })

    it('books one set per rate group across lines of the same kind', () => {
      const entry = buildSpendItemEntry(
        expense({
          amount: 1500,
          lines: [
            line({ account: '6540', amount: 1000, vat: { code: 'EUTJ', type: 'reverse', rate: 0.25, amount: null } }),
            line({ account: '6212', amount: 500, vat: { code: 'EUTJ', type: 'reverse', rate: 0.25, amount: null } }),
          ],
        }),
        entryCtx(),
      )
      expect(sides(entry.lines)).toEqual([
        ['6540', 1000, 0],
        ['6212', 500, 0],
        ['2645', 375, 0],
        ['2614', 0, 375],
        ['4535', 1500, 0],
        ['4598', 0, 1500],
        ['1940', 0, 1500],
      ])
      expectBalanced(entry.lines)
    })
  })

  describe('a refund swaps every side', () => {
    it('with Swedish VAT', () => {
      const entry = buildSpendItemEntry(
        expense({ kind: 'refund', amount: -1250, lines: [line({ amount: -1250, vat: { code: 'SE25', type: 'standard', rate: 0.25, amount: -250 } })] }),
        entryCtx(),
      )
      expect(entry.problems).toEqual([])
      expect(sides(entry.lines)).toEqual([
        ['5410', 0, 1000],
        ['2641', 0, 250],
        ['1940', 1250, 0],
      ])
      expectBalanced(entry.lines)
    })

    it('with reverse charge, the whole set mirrored', () => {
      const entry = buildSpendItemEntry(
        expense({ kind: 'refund', amount: -1000, lines: [line({ account: '6540', amount: -1000, vat: { code: 'EUTJ', type: 'reverse', rate: 0.25, amount: -250 } })] }),
        entryCtx(),
      )
      expect(sides(entry.lines)).toEqual([
        ['6540', 0, 1000],
        ['2645', 0, 250],
        ['2614', 250, 0],
        ['4535', 0, 1000],
        ['4598', 1000, 0],
        ['1940', 1000, 0],
      ])
      expectBalanced(entry.lines)
    })
  })

  it('credits the utlägg account for what is owed to the person who paid', () => {
    const utlagg = expense({
      kind: 'out_of_pocket',
      walletAccount: null,
      amount: 212,
      merchant: { name: 'Taxi Stockholm', country: 'SE', taxId: null, categoryCode: null },
      lines: [line({ account: '5800', amount: 212, vat: { code: 'SE6', type: 'standard', rate: 0.06, amount: 12 } })],
    })
    const entry = buildSpendItemEntry(utlagg, entryCtx())
    expect(entry.lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount, l.line_description])).toEqual([
      ['5800', 200, 0, 'Taxi Stockholm'],
      ['2641', 12, 0, 'Ingående moms 6 %'],
      ['2820', 0, 212, 'Att betala till den som la ut'],
    ])
    expectBalanced(entry.lines)

    // An owner's own utlägg in an AB: the company's choice of liability.
    const owner = buildSpendItemEntry(utlagg, entryCtx({ settings: { ...DEFAULT_SPEND_SETTINGS, out_of_pocket_account: '2893' } }))
    expect(owner.lines.at(-1)).toMatchObject({ account_number: '2893', credit_amount: 212 })
  })

  it('books a paid-back utlägg from the wallet against the utlägg account', () => {
    const entry = buildSpendItemEntry(expense({ kind: 'reimbursement', amount: 212, lines: [], files: [] }), entryCtx())
    expect(entry.lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount, l.line_description])).toEqual([
      ['2820', 212, 0, 'Återbetalt utlägg'],
      ['1940', 0, 212, 'Utbetalt från kortkontot'],
    ])
    expectBalanced(entry.lines)
  })

  it.each([
    ['personal_spend', '1685', 'Privat köp'],
    ['atm_withdrawal', '1910', 'Kontantuttag'],
  ] as const)('%s books against the account the person chose, never a cost on its own', (kind, debitAccount, text) => {
    const item = expense({ kind, amount: 500, lines: [] })
    expect(buildSpendItemEntry(item, entryCtx())).toEqual({ lines: [], problems: [{ code: 'counter_account_needed', params: { kind } }], deductibleVat: 0 })

    const entry = buildSpendItemEntry(item, entryCtx({ debitAccount }))
    expect(entry.problems).toEqual([])
    expect(entry.lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount, l.line_description])).toEqual([
      [debitAccount, 500, 0, text],
      ['1940', 0, 500, text],
    ])
    expectBalanced(entry.lines)
  })

  it('keeps the dimensions on the cost lines of a split expense, never on VAT or the wallet', () => {
    const entry = buildSpendItemEntry(
      expense({
        amount: 1000,
        lines: [
          line({ account: '5410', amount: 800, vat: { code: 'SE25', type: 'standard', rate: 0.25, amount: 160 }, dimensions: { '1': 'K100' }, description: 'Skärmar' }),
          line({ account: '6540', amount: 200, vat: { code: 'MOMSFRI', type: 'standard', rate: 0, amount: null }, dimensions: { '6': 'P7' } }),
        ],
      }),
      entryCtx(),
    )
    expect(entry.problems).toEqual([])
    expect(entry.lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount, l.line_description, l.dimensions])).toEqual([
      ['5410', 640, 0, 'Skärmar', { '1': 'K100' }],
      ['2641', 160, 0, 'Ingående moms 25 %', undefined],
      ['6540', 200, 0, 'Clas Ohlson', { '6': 'P7' }],
      ['1940', 0, 1000, 'Betalt med företagskort', undefined],
    ])
    expectBalanced(entry.lines)
  })

  it('uses the wallet account chosen here over the provider mapping', () => {
    const entry = buildSpendItemEntry(
      expense({ walletAccount: '1941' }),
      entryCtx({ settings: { ...DEFAULT_SPEND_SETTINGS, wallet_account: '1940' } }),
    )
    expect(entry.lines.at(-1)).toMatchObject({ account_number: '1940', credit_amount: 1250 })
  })

  it('names what keeps a verifikat from being built instead of building a wrong one', () => {
    const cases: Array<[Partial<SpendExpenseModel>, string]> = [
      [{ kind: 'invoice' }, 'kind_unsupported'],
      [{ kind: 'wallet_topup' }, 'kind_unsupported'],
      [{ walletAccount: null }, 'wallet_account_unknown'],
      [{ lines: [] }, 'account_missing'],
      [{ lines: [line({ account: null })] }, 'account_missing'],
      [{ lines: [line({ vat: { code: 'XX', type: 'standard', rate: 0.25, amount: null } })] }, 'vat_code_unknown'],
      [{ amount: 0, lines: [line({ amount: 0, vat: { code: 'SE25', type: 'standard', rate: 0.25, amount: 0 } })] }, 'amounts_mismatch'],
    ]
    for (const [overrides, code] of cases) {
      const entry = buildSpendItemEntry(expense(overrides), entryCtx())
      expect(entry.lines, code).toEqual([])
      expect(entry.problems.map((p) => p.code), code).toEqual([code])
    }
    // A reimbursement or a private purchase without a wallet has nothing to credit.
    expect(buildSpendItemEntry(expense({ kind: 'reimbursement', walletAccount: null, lines: [] }), entryCtx()).problems[0].code).toBe('wallet_account_unknown')
    expect(
      buildSpendItemEntry(expense({ kind: 'personal_spend', walletAccount: null, lines: [] }), entryCtx({ debitAccount: '1685' })).problems[0].code,
    ).toBe('wallet_account_unknown')
  })

  it('balances to the öre for every kind it books', () => {
    const kinds: Array<[SpendExpenseKind, Partial<SpendExpenseModel>, Partial<SpendEntryContext>]> = [
      ['card_purchase', { amount: 333.33, lines: [line({ amount: 333.33, vat: { code: 'SE25', type: 'standard', rate: 0.25, amount: null } })] }, {}],
      ['card_invoice', { amount: 99.99, lines: [line({ amount: 99.99, vat: { code: 'SE12', type: 'standard', rate: 0.12, amount: null } })] }, {}],
      ['fee', { amount: 0.01, lines: [line({ account: '6570', amount: 0.01, vat: { code: 'MOMSFRI', type: 'standard', rate: 0, amount: null } })] }, {}],
      ['chargeback', { amount: -77.77, lines: [line({ amount: -77.77, vat: { code: 'SE6', type: 'standard', rate: 0.06, amount: null } })] }, {}],
      ['cashback', { amount: -12.34, lines: [line({ account: '6570', amount: -12.34, vat: { code: 'MOMSFRI', type: 'standard', rate: 0, amount: null } })] }, {}],
      [
        'card_purchase',
        {
          amount: 1001.01,
          lines: [
            line({ amount: 333.67, vat: { code: 'SE25', type: 'standard', rate: 0.25, amount: null } }),
            line({ account: '6540', amount: 333.67, vat: { code: 'EUTJ', type: 'reverse', rate: 0.25, amount: null } }),
            line({ account: '5800', amount: 333.67, vat: { code: 'SE6', type: 'standard', rate: 0.06, amount: null } }),
          ],
        },
        {},
      ],
      ['out_of_pocket', { amount: 45.5, lines: [line({ amount: 45.5, vat: { code: 'SE25', type: 'standard', rate: 0.25, amount: null } })] }, {}],
      ['mileage', { amount: 375, lines: [line({ account: '7331', amount: 375, vat: { code: 'MOMSFRI', type: 'standard', rate: 0, amount: null } })] }, {}],
      ['per_diem', { amount: 290, lines: [line({ account: '7321', amount: 290, vat: { code: 'MOMSFRI', type: 'standard', rate: 0, amount: null } })] }, {}],
      ['reimbursement', { amount: 45.5, lines: [] }, {}],
      ['personal_spend', { amount: 89.9, lines: [] }, { debitAccount: '2013' }],
      ['atm_withdrawal', { amount: 500, lines: [] }, { debitAccount: '1910' }],
    ]
    for (const [kind, overrides, context] of kinds) {
      const entry = buildSpendItemEntry(expense({ kind, ...overrides }), entryCtx(context))
      expect(entry.problems, kind).toEqual([])
      expectBalanced(entry.lines)
    }
  })
})

describe('spendItemDescription', () => {
  it('says what, who and from which system', () => {
    expect(spendItemDescription(expense(), 'Pleo')).toBe('Kortköp Clas Ohlson (Anna Berg), Pleo')
    expect(spendItemDescription(expense({ note: 'Kablar till\n  kontoret' }), 'Pleo')).toBe('Kortköp Clas Ohlson (Anna Berg): Kablar till kontoret, Pleo')
    expect(spendItemDescription(expense({ person: null }), 'Pleo')).toBe('Kortköp Clas Ohlson, Pleo')
  })

  it('names the kind once when there is no merchant', () => {
    expect(spendItemDescription(expense({ kind: 'out_of_pocket', merchant: null }), 'Pleo')).toBe('Utlägg (Anna Berg), Pleo')
  })

  it('stays within 200 characters', () => {
    expect(spendItemDescription(expense({ note: 'x'.repeat(500) }), 'Pleo')).toHaveLength(200)
  })
})

describe('spendItemNotes', () => {
  it("carries the provider's reference, the original currency and the attendees", () => {
    const notes = spendItemNotes(
      expense({
        original: { currency: 'EUR', amount: 109.5 },
        attendees: [
          { name: 'Anna Berg', company: null, internal: true },
          { name: 'Erik Lund', company: 'Kund AB', internal: false },
        ],
      }),
      'Pleo',
    )
    expect(notes).toBe('Pleo P-1001. Ursprungligt belopp 109.5 EUR. Deltagare: Anna Berg, Erik Lund (Kund AB)')
  })

  it('says when no receipt came with the expense', () => {
    expect(spendItemNotes(expense({ reference: null, files: [] }), 'Pleo')).toBe('Inget kvitto från utgiftsplattformen.')
    expect(spendItemNotes(expense({ reference: null }), 'Pleo')).toBe('')
  })
})
