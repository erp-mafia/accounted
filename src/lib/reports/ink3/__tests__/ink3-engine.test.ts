import { describe, expect, it } from 'vitest'
import type { TrialBalanceRow } from '@/types'
import type { ExistingFond } from '@/lib/bokslut/reserves/periodiseringsfond-service'
import { computeInk3Underlag, type Ink3EngineInput } from '../ink3-engine'
import { INK3_FIELD_TABLES } from '../field-table'
import type { Ink3Inputs } from '../types'

/**
 * The pure INK3 computation on fixture trial balances. A closed calendar
 * year 2026 for an ideell förening:
 *
 *   Balance (closed books): 1930 50 000 D, 2068 20 000 C, 2069 18 000 C,
 *   2440 12 000 C.
 *   Result (before the resultatavslut): 3901 42 000 C (medlemsavgifter),
 *   3010 120 000 C, 3990 10 000 C, 4010 60 000 D, 5010 80 000 D,
 *   6110 14 000 D: årets resultat 18 000.
 */

const table = INK3_FIELD_TABLES['2026P4']

/** Trial balance rows from signed balances (debit positive). */
function tb(balances: Record<string, number>): TrialBalanceRow[] {
  return Object.entries(balances).map(([account, balance]) => ({
    account_number: account,
    account_name: `Konto ${account}`,
    account_class: Number(account.charAt(0)),
    opening_debit: 0,
    opening_credit: 0,
    period_debit: 0,
    period_credit: 0,
    closing_debit: balance > 0 ? balance : 0,
    closing_credit: balance < 0 ? -balance : 0,
  }))
}

const CLOSED = { '1930': 50_000, '2068': -20_000, '2069': -18_000, '2440': -12_000 }
const PRE_CLOSING = {
  '1930': 50_000,
  '2068': -20_000,
  '2440': -12_000,
  '3901': -42_000,
  '3010': -120_000,
  '3990': -10_000,
  '4010': 60_000,
  '5010': 80_000,
  '6110': 14_000,
}

const NO_INPUTS: Ink3Inputs = { allmannyttig: null, accountTreatments: {}, fieldOverrides: {} }

function run(overrides: Partial<Ink3EngineInput> = {}) {
  return computeInk3Underlag({
    table,
    inputs: NO_INPUTS,
    closedRows: tb(CLOSED),
    preClosingRows: tb(PRE_CLOSING),
    closingAccount: '2069',
    fonder: [],
    closingYear: 2026,
    isClosed: true,
    hasLinkedClosingEntry: true,
    ...overrides,
  })
}

const CLASSIFIED: Ink3Inputs = {
  allmannyttig: true,
  accountTreatments: { '3010': 'taxable', '3990': 'exempt', '4010': 'taxable', '5010': 'shared' },
  fieldOverrides: {},
}

function field(result: ReturnType<typeof run>, code: string) {
  const f = result.fields.find((x) => x.code === code)
  if (!f) throw new Error(`no field ${code}`)
  return f
}

describe('INK3R from the books', () => {
  it('fills the balance sheet from the closed books and ties it out', () => {
    const r = run()
    expect(field(r, '8730').value).toBe(50_000)
    expect(field(r, '8735').value).toBe(38_000)
    expect(field(r, '8742').value).toBe(12_000)
    expect(field(r, '8735').accounts.map((a) => a.accountNumber)).toEqual(['2068', '2069'])
    expect(r.totals).toMatchObject({ totalAssets: 50_000, totalEquityLiabilities: 50_000 })
    expect(r.warnings.join(' ')).not.toMatch(/inte i balans/)
  })

  it('fills the bookkeeping column from the books before the resultatavslut, 3901 on 6.1', () => {
    const r = run()
    expect(field(r, '8650').value).toBe(42_000)
    expect(field(r, '8653').value).toBe(120_000)
    expect(field(r, '8654').value).toBe(10_000)
    expect(field(r, '8750').value).toBe(60_000)
    expect(field(r, '8751').value).toBe(94_000)
    expect(field(r, '8663').value).toBe(18_000)
    expect(field(r, '8763').value).toBe(0)
    expect(field(r, '8651').source).toBe('books')
    expect(r.totals.bookkeepingResult).toBe(18_000)
    expect(r.warnings.join(' ')).not.toMatch(/stämmer inte med det bokförda resultatet/)
  })

  it('warns when årets resultat on 2069 does not match the income statement', () => {
    const r = run({ closedRows: tb({ ...CLOSED, '2069': -17_000, '2068': -21_000 }) })
    expect(r.warnings.join(' ')).toMatch(/18000 kr.*konto 2069 \(17000 kr\)/)
  })
})

describe('INK3R taxable column from the per-account treatment', () => {
  it('counts taxable accounts, drops exempt ones, and waits on shared and unclassified', () => {
    const r = run({ inputs: CLASSIFIED })
    expect(field(r, '8673').value).toBe(120_000)
    expect(field(r, '8674').value).toBe(0)
    expect(field(r, '8674').needsInput).toBe(false)
    expect(field(r, '8770').value).toBe(60_000)
    expect(field(r, '8771')).toMatchObject({ value: 0, needsInput: true, needsInputReason: 'unclassified_account' })
    expect(field(r, '8685').value).toBe(60_000)
    expect(r.totals.taxableResult).toBe(60_000)
    expect(r.complete).toBe(false)
    expect(r.warnings.join(' ')).toMatch(/1 ruta behöver din bedömning/)
  })

  it('marks a ruta fed only by a shared account as shared', () => {
    const r = run({ inputs: { ...CLASSIFIED, accountTreatments: { ...CLASSIFIED.accountTreatments, '6110': 'exempt' } } })
    expect(field(r, '8771')).toMatchObject({ needsInput: true, needsInputReason: 'shared_account' })
  })

  it('lists the accounts to classify, never 6.1 Medlemsavgifter', () => {
    const r = run({ inputs: CLASSIFIED })
    expect(r.accounts.map((a) => [a.accountNumber, a.ruta, a.amount, a.treatment])).toEqual([
      ['3010', '6.4', 120_000, 'taxable'],
      ['3990', '6.5', 10_000, 'exempt'],
      ['4010', '6.6', 60_000, 'taxable'],
      ['5010', '6.7', 80_000, 'shared'],
      ['6110', '6.7', 14_000, null],
    ])
  })

  it("takes the user's figure for a waiting ruta and carries it through 6.21, 7.1 and 7.9", () => {
    const r = run({
      inputs: {
        ...CLASSIFIED,
        accountTreatments: { ...CLASSIFIED.accountTreatments, '6110': 'exempt' },
        fieldOverrides: { '8771': 30_000 },
      },
    })
    expect(field(r, '8771')).toMatchObject({ value: 30_000, computed: 0, source: 'override', needsInput: false })
    expect(field(r, '8685').value).toBe(30_000)
    expect(field(r, '8686').value).toBe(30_000)
    expect(field(r, '8695').value).toBe(30_000)
    expect(r.complete).toBe(true)
  })

  it('never overrides a sum, and says so', () => {
    const r = run({ inputs: { ...CLASSIFIED, fieldOverrides: { '8695': 1, '8663': 5 } } })
    expect(field(r, '8695').value).toBe(60_000)
    expect(field(r, '8663').value).toBe(18_000)
    expect(field(r, '8695').overridable).toBe(false)
    expect(r.warnings.join(' ')).toMatch(/8663, 8695 används inte/)
  })

  it('lets an override replace a books figure in the bookkeeping column too', () => {
    const r = run({ inputs: { ...CLASSIFIED, fieldOverrides: { '8654': 9_000 } } })
    expect(field(r, '8654')).toMatchObject({ value: 9_000, computed: 10_000, source: 'override' })
    expect(field(r, '8663').value).toBe(17_000)
  })
})

describe('INK3R net rows', () => {
  it('nets 8810 between 6.16 återföring and 6.17 avsättning', () => {
    const credit = run({ preClosingRows: tb({ ...PRE_CLOSING, '8810': -5_000, '4010': 65_000 }) })
    expect(field(credit, '8659').value).toBe(5_000)
    expect(field(credit, '8760').value).toBe(0)
    const debit = run({ preClosingRows: tb({ ...PRE_CLOSING, '8810': 2_000, '8811': 3_000, '4010': 55_000 }) })
    expect(field(debit, '8659').value).toBe(0)
    expect(field(debit, '8760').value).toBe(5_000)
  })

  it('files a net loss on 6.11 in its minus box, in both columns', () => {
    const r = run({
      inputs: { ...CLASSIFIED, accountTreatments: { ...CLASSIFIED.accountTreatments, '8012': 'taxable', '8020': 'taxable' } },
      preClosingRows: tb({ ...PRE_CLOSING, '8012': -1_000, '8020': 3_000, '4010': 58_000 }),
    })
    expect(field(r, '8655').value).toBe(0)
    expect(field(r, '8755').value).toBe(2_000)
    expect(field(r, '8775').value).toBe(2_000)
    expect(field(r, '8675').value).toBe(0)
  })
})

describe('INK3S', () => {
  it('sums 7.1-7.8 by their printed sign into 7.9 or 7.10', () => {
    const r = run({ inputs: { ...CLASSIFIED, fieldOverrides: { '8771': 0, '8787': 5_000, '8689': 700, '8789': 200 } } })
    expect(field(r, '8695').value).toBe(60_000 - 5_000 + 700 - 200)
    expect(field(r, '8795').value).toBe(0)
    const loss = run({ inputs: { ...CLASSIFIED, fieldOverrides: { '8771': 0, '8787': 70_000 } } })
    expect(field(loss, '8695').value).toBe(0)
    expect(field(loss, '8795').value).toBe(10_000)
    expect(loss.totals.taxableSurplus).toBe(-10_000)
  })

  it('computes 7.5a from the periodiseringsfonder at the start of the year', () => {
    const fonder: ExistingFond[] = [
      { account_number: '2125', cohort_year: 2025, balance: 100_000, opening_balance: 100_000, must_return_this_year: false },
      { account_number: '2126', cohort_year: 2026, balance: 40_000, opening_balance: 0, must_return_this_year: false },
    ]
    const r = run({ inputs: CLASSIFIED, fonder })
    // 2026 rate 2,55 % (periodiseringsfond-service) on the 100 000 kr opening balance.
    expect(field(r, '8688')).toMatchObject({ value: 2_550, computed: 2_550, source: 'computed', needsInput: false })
  })

  it('asks for 7.5a when the year has no rate, and for 7.5c when a fond was returned', () => {
    const fonder: ExistingFond[] = [
      { account_number: '2120', cohort_year: 2020, balance: 0, opening_balance: 10_000, must_return_this_year: true },
    ]
    const r = run({ fonder, closingYear: 2031 })
    expect(field(r, '8688')).toMatchObject({ value: null, needsInput: true, needsInputReason: 'not_computable' })
    expect(r.warnings.join(' ')).toMatch(/7\.5a/)
    expect(r.warnings.join(' ')).toMatch(/7\.5c/)
  })

  it('takes entered values as inputs, empty until entered', () => {
    const r = run()
    expect(field(r, '8787')).toMatchObject({ value: null, computed: null, source: 'input', needsInput: false })
    expect(field(r, '8040')).toMatchObject({ value: null, source: 'input' })
  })

  it('warns when both boxes of a yes/no pair are ticked', () => {
    const r = run({ inputs: { ...CLASSIFIED, fieldOverrides: { '8040': true, '8041': true } } })
    expect(r.warnings.join(' ')).toMatch(/8040 och 8041/)
  })
})

describe('INK3SUF and the filing map', () => {
  const sufInputs: Ink3Inputs = {
    ...CLASSIFIED,
    fieldOverrides: { '8771': 0, '8822': true, '8620': 'Kulturarv', '8640': 42_000, '8614': 25 },
  }

  it('includes INK3SUF only when the user states the förening is allmännyttig', () => {
    const yes = run({ inputs: sufInputs })
    expect(yes.sufApplicable).toBe(true)
    expect(yes.filing).toMatchObject({ '8822': 'X', '8620': 'Kulturarv', '8640': 42_000, '8614': 25 })

    const no = run({ inputs: { ...sufInputs, allmannyttig: false } })
    expect(no.sufApplicable).toBe(false)
    for (const c of ['8822', '8620', '8640', '8614']) expect(no.filing[c]).toBeUndefined()
  })

  it('files non-zero amounts and leaves zeros out', () => {
    const r = run({ inputs: sufInputs })
    expect(r.filing).toMatchObject({ '8730': 50_000, '8650': 42_000, '8653': 120_000, '8673': 120_000, '8663': 18_000, '8695': 60_000 })
    expect(r.filing['8674']).toBeUndefined()
    expect(r.filing['8763']).toBeUndefined()
  })

  it('asks for the allmännyttig statement until it is made', () => {
    const r = run()
    expect(r.complete).toBe(false)
    expect(r.warnings.join(' ')).toMatch(/Ange om föreningen är allmännyttig/)
  })
})

describe('INK3 checks', () => {
  it('moves a credit skattekonto to 5.18 Skatteskulder', () => {
    const closed = { ...CLOSED, '1630': -4_000, '1930': 54_000 }
    const r = run({ closedRows: tb(closed), preClosingRows: tb({ ...PRE_CLOSING, '1630': -4_000, '1930': 54_000 }) })
    expect(field(r, '8728').value).toBe(0)
    expect(field(r, '8741').value).toBe(4_000)
    expect(r.warnings.join(' ')).toMatch(/redovisats som skatteskuld/)
  })

  it('names accounts BAS gives no INK3R box', () => {
    const r = run({ preClosingRows: tb({ ...PRE_CLOSING, '7700': 1_000, '4010': 59_000 }) })
    expect(r.warnings.join(' ')).toMatch(/7700 \(Konto 7700\)/)
  })

  it('warns when a ruta that takes only non-negative amounts comes out negative', () => {
    const r = run({ preClosingRows: tb({ ...PRE_CLOSING, '8310': 500, '4010': 59_500 }) })
    expect(field(r, '8657').value).toBe(-500)
    expect(r.warnings.join(' ')).toMatch(/Ruta 6\.13 \(fältkod 8657\) blir -500 kr/)
  })

  it('says an open year may still change and ties the balance with the unclosed result', () => {
    const r = run({ closedRows: tb(PRE_CLOSING), isClosed: false, hasLinkedClosingEntry: false })
    expect(r.warnings.join(' ')).toMatch(/inte stängt/)
    expect(r.totals.totalEquityLiabilities).toBe(50_000)
    expect(r.warnings.join(' ')).not.toMatch(/inte i balans/)
  })
})
