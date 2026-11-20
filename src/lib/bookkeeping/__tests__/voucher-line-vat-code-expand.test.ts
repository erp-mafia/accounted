/**
 * expandVoucherLineVatCodes: the momskod of a voucher line on the v1 voucher
 * routes and the MCP tool create_voucher (crm#1096).
 *
 * Pinned here: the lines a vat_code posts are the lines the manual verifikat
 * form posts for the same code (parity, over the same kontoplan rows the two
 * read differently: the form every account row, the server only the
 * configured class 4-6 rows fetchChartVatTreatments loads); nothing is
 * generated without an explicit code; and a code that cannot post as asked
 * is refused per line instead of adjusted, also when it is the kontoplan row
 * of the basis account the code books that says otherwise.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  expandVoucherLineVatCodes,
  groupVoucherLinesWithVatCodes,
  type VatCodedVoucherLine,
  type VoucherLineVatCode,
} from '../voucher-line-vat-code'
import { chartVatTreatmentsOf } from '../vat-entries'
import { rutorFromTotals } from '@/lib/reports/vat-declaration'

const NON_EU_25: VoucherLineVatCode = { kind: 'non_eu_services', rate: 0.25 }
const EU_SERVICES_25: VoucherLineVatCode = { kind: 'eu_services', rate: 0.25 }

/** A kontoplan row as both doors read it. PostgREST may hand the numeric rate over as a string. */
interface ChartRow {
  account_number: string
  default_vat_treatment: string | null
  default_vat_rate: number | string | null
}

const row = (account: string, treatment: string | null = null, rate: number | string | null = null): ChartRow => ({
  account_number: account,
  default_vat_treatment: treatment,
  default_vat_rate: rate,
})

/** A kontoplan where every account the cases book has a row; most have no momskod. */
const KONTOPLAN: ChartRow[] = [
  row('1930'), row('2440'), row('2645'), row('2614'), row('4531'), row('4598'),
  row('5410'), row('6540'), row('6550'), row('4545'),
  row('6560', 'reverse_charge_eu_services', '0.12'),
  row('4010', 'reverse_charge_domestic', 0.25),
  row('6570', 'reverse_charge_eu_services', 0),
]

/** What fetchChartVatTreatments loads from those rows: the configured class 4-6 ones. */
function serverChart(rows: ChartRow[]) {
  return chartVatTreatmentsOf(rows.filter((r) => /^[4-6]/.test(r.account_number) && r.default_vat_treatment !== null))
}

const loaderOf = (rows: ChartRow[] = KONTOPLAN) => vi.fn(async () => serverChart(rows))

function line(
  account: string,
  debit: number,
  credit = 0,
  vatCode?: VoucherLineVatCode | null,
  extra: Partial<VatCodedVoucherLine> = {},
): VatCodedVoucherLine {
  return { account_number: account, debit_amount: debit, credit_amount: credit, vat_code: vatCode, ...extra }
}

type Posted = [account: string, debit: number, credit: number, description: string | null]

const posted = (lines: Array<{ account_number: string; debit_amount: number; credit_amount: number; line_description?: string }>): Posted[] =>
  lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount, l.line_description || null])

/**
 * What the manual verifikat form posts for the same lines with the same codes
 * chosen in its menu, every other line switched off: the form's own grouping
 * over every kontoplan row, then its submit's parse of the string amounts.
 */
function formPosts(lines: VatCodedVoucherLine[], rows: ChartRow[] = KONTOPLAN): Posted[] {
  const byNumber = new Map(rows.map((r) => [r.account_number, r]))
  const formLines = lines.map((l) => ({
    account_number: l.account_number,
    debit_amount: l.debit_amount > 0 ? String(l.debit_amount) : '',
    credit_amount: l.credit_amount > 0 ? String(l.credit_amount) : '',
    line_description: l.line_description ?? '',
    vat_code: l.vat_code ?? null,
  }))
  return groupVoucherLinesWithVatCodes(formLines, (account) => byNumber.get(account))
    .flatMap((group) => [group.line, ...group.generated])
    .map((l) => [
      l.account_number,
      parseFloat(l.debit_amount) || 0,
      parseFloat(l.credit_amount) || 0,
      l.line_description || null,
    ])
}

async function expand(lines: VatCodedVoucherLine[], rows: ChartRow[] = KONTOPLAN) {
  const result = await expandVoucherLineVatCodes(lines, loaderOf(rows))
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.refusals)}`)
  return result.lines
}

async function refusalsOf(lines: VatCodedVoucherLine[], rows: ChartRow[] = KONTOPLAN) {
  const result = await expandVoucherLineVatCodes(lines, loaderOf(rows))
  if (result.ok) throw new Error('expected a refusal')
  return result.refusals
}

describe('a vat_code posts what the manual verifikat form posts for the same momskod', () => {
  it.each<[string, VatCodedVoucherLine[]]>([
    ['an ordinary cost account, tjänst utanför EU 25 %', [line('6540', 1000, 0, NON_EU_25), line('1930', 0, 1000)]],
    ['two purchases, varor från EU 12 % and tjänst från EU 25 %', [
      line('5410', 200, 0, { kind: 'eu_goods', rate: 0.12 }),
      line('6550', 1000, 0, EU_SERVICES_25),
      line('1930', 0, 1200),
    ]],
    ['domestic reverse charge at 6 %', [line('6540', 1000, 0, { kind: 'domestic_services', rate: 0.06 }), line('2440', 0, 1000)]],
    ['4531, which reports ruta 22 itself, with its own code', [line('4531', 1000, 0, NON_EU_25), line('2440', 0, 1000)]],
    ['an account set to EU services at 12 % in the kontoplan, with its own code', [
      line('6560', 500, 0, { kind: 'eu_services', rate: 0.12 }),
      line('1930', 0, 500),
    ]],
    ['an account set to domestic reverse charge (ruta 23), with its own code', [
      line('4010', 1000, 0, { kind: 'domestic_services', rate: 0.25 }),
      line('2440', 0, 1000),
    ]],
    ['a credit note on the credit side', [line('2440', 400), line('6540', 0, 400, EU_SERVICES_25)]],
    ['a coded line beside hand-typed lines on other accounts', [
      line('6540', 1000, 0, NON_EU_25),
      line('5410', 100),
      line('1930', 0, 1100),
    ]],
  ])('%s', async (_case, lines) => {
    expect(posted(await expand(lines))).toEqual(formPosts(lines))
  })

  it('declares the purchase in its rutor and leaves ruta 49 at zero', async () => {
    const lines = await expand([line('6540', 1000, 0, NON_EU_25), line('1930', 0, 1000)])
    const totals = new Map<string, { debit: number; credit: number }>()
    for (const l of lines) {
      const t = totals.get(l.account_number) ?? { debit: 0, credit: 0 }
      totals.set(l.account_number, { debit: t.debit + l.debit_amount, credit: t.credit + l.credit_amount })
    }
    const rutor = rutorFromTotals(totals)
    expect([rutor.ruta22, rutor.ruta30, rutor.ruta48, rutor.ruta49]).toEqual([1000, 250, 250, 0])
  })

  it('puts each generated set directly under its line, keeps the typed line whole and adds no dimensions', async () => {
    const typed = line('6540', 1000, 0, NON_EU_25, {
      line_description: 'Licens',
      dimensions: { '6': 'P001' },
      currency: 'USD',
      amount_in_currency: 95,
      exchange_rate: 10.5263,
    })
    const lines = await expand([typed, line('1930', 0, 1000)])

    expect(lines.map((l) => l.account_number)).toEqual(['6540', '2645', '2614', '4531', '4598', '1930'])
    expect(lines[0]).toEqual({
      account_number: '6540',
      debit_amount: 1000,
      credit_amount: 0,
      line_description: 'Licens',
      dimensions: { '6': 'P001' },
      currency: 'USD',
      amount_in_currency: 95,
      exchange_rate: 10.5263,
    })
    expect(lines.every((l) => !('vat_code' in l))).toBe(true)
    expect(lines.slice(1, 5).every((l) => l.dimensions === undefined && l.currency === undefined)).toBe(true)

    const debit = lines.reduce((sum, l) => sum + l.debit_amount, 0)
    const credit = lines.reduce((sum, l) => sum + l.credit_amount, 0)
    expect(Math.round(debit * 100)).toBe(Math.round(credit * 100))
  })
})

describe('explicit only', () => {
  it('generates nothing for a line without a code, also on 4531 where the form switches its own code on', async () => {
    const lines = [line('4531', 1000), line('1930', 0, 1000)]
    const loadChart = loaderOf()
    const result = await expandVoucherLineVatCodes(lines, loadChart)

    expect(result).toEqual({ ok: true, lines: [lines[0], lines[1]].map(({ vat_code: _code, ...l }) => l) })
    // No code anywhere: the kontoplan is never read.
    expect(loadChart).not.toHaveBeenCalled()

    // The form, with no choice made, books 4531's fiktiv moms by itself.
    const byNumber = new Map(KONTOPLAN.map((r) => [r.account_number, r]))
    const [form] = groupVoucherLinesWithVatCodes(
      [{ account_number: '4531', debit_amount: '1000', credit_amount: '' }, { account_number: '1930', debit_amount: '', credit_amount: '1000' }],
      (account) => byNumber.get(account),
    )
    expect(form.generated.map((l) => l.account_number)).toEqual(['2645', '2614'])
  })

  it('treats a null vat_code as none', async () => {
    const result = await expandVoucherLineVatCodes([line('6540', 100, 0, null), line('1930', 0, 100, null)], loaderOf())
    expect(result.ok && result.lines.map((l) => l.account_number)).toEqual(['6540', '1930'])
  })

  it('reads the kontoplan once for a request with several codes', async () => {
    const loadChart = loaderOf()
    await expandVoucherLineVatCodes(
      [line('6540', 100, 0, NON_EU_25), line('6550', 100, 0, EU_SERVICES_25), line('1930', 0, 200)],
      loadChart,
    )
    expect(loadChart).toHaveBeenCalledTimes(1)
  })
})

describe('a code that cannot post as asked is refused, never adjusted', () => {
  it.each(['1930', '2440', '3001', '7010', '4598'])('refuses a code on %s, which is not a purchase cost account', async (account) => {
    const refusals = await refusalsOf([line(account, 1000, 0, EU_SERVICES_25), line('2893', 0, 1000)])
    expect(refusals).toEqual([{
      field: 'lines.0.vat_code',
      en: expect.stringContaining(`Account ${account} takes no vat_code`),
      sv: expect.stringContaining(`Konto ${account} kan inte ha en momskod`),
    }])
    expect(refusals[0].en).toMatch(/class 4-6/)
  })

  it.each([
    ['4545, the import basis (ruta 50)', '4545'],
    ['an account whose reverse-charge momskod has 0 % as its momssats', '6570'],
  ])('refuses a code on %s', async (_case, account) => {
    const [refusal] = await refusalsOf([line(account, 1000, 0, EU_SERVICES_25), line('1930', 0, 1000)])
    expect(refusal.field).toBe('lines.0.vat_code')
    expect(refusal.en).toMatch(/momsruta outside 20-24/)
  })

  it('refuses another code on an account that reports ruta 20-24 itself, naming the one that would post', async () => {
    const [kind] = await refusalsOf([line('4531', 1000, 0, EU_SERVICES_25), line('1930', 0, 1000)])
    expect(kind.en).toContain('reports ruta 22 at 25 % itself')
    expect(kind.en).toContain('{"kind":"non_eu_services","rate":0.25}')
    expect(kind.sv).toContain('{"kind":"non_eu_services","rate":0.25}')

    const [rate] = await refusalsOf([line('6560', 500, 0, EU_SERVICES_25), line('1930', 0, 500)])
    expect(rate.en).toContain('reports ruta 21 at 12 % itself')
    expect(rate.en).toContain('{"kind":"eu_services","rate":0.12}')
  })

  it('refuses a code on a line without an amount', async () => {
    const [refusal] = await refusalsOf([
      line('6540', 0, 0, NON_EU_25),
      line('6550', 100),
      line('1930', 0, 100),
    ])
    expect(refusal.field).toBe('lines.0.vat_code')
    expect(refusal.en).toMatch(/needs a debit or credit amount/)
  })

  it('refuses a code beside lines that book the accounts it creates by hand, as the form does', async () => {
    const [fiktiv] = await refusalsOf([
      line('6540', 1000, 0, NON_EU_25),
      line('2645', 250),
      line('2614', 0, 250),
      line('1930', 0, 1000),
    ])
    expect(fiktiv.field).toBe('lines.0.vat_code')
    expect(fiktiv.en).toContain('creates 2614, 2645 itself')
    expect(fiktiv.sv).toContain('köpet skulle räknas två gånger')

    const [offset] = await refusalsOf([line('6540', 1000, 0, NON_EU_25), line('4598', 0, 1000)])
    expect(offset.en).toContain('creates 4598 itself')
  })

  it('refuses a coded purchase beside a line on the basis account its code creates, and says to split the voucher', async () => {
    // Two purchases by their codes, but by its lines not told apart from one
    // purchase whose basis is both generated and typed: the form's rule.
    const refusals = await refusalsOf([
      line('6540', 1000, 0, EU_SERVICES_25),
      line('4535', 500, 0, EU_SERVICES_25),
      line('1930', 0, 1500),
    ])
    expect(refusals.map((r) => r.field)).toEqual(['lines.0.vat_code'])
    expect(refusals[0].en).toContain('creates 4535 itself')
    expect(refusals[0].en).toContain('if they are another purchase, book it in a voucher of its own')
    expect(refusals[0].sv).toContain('är de ett annat inköp bokförs det i ett eget verifikat')
  })

  it('accepts the BAS shape: 4531\'s own code beside a typed 4531 / 4598 statistic pair', async () => {
    const lines = [
      line('6540', 1000),
      line('1930', 0, 1000),
      line('4531', 1000, 0, NON_EU_25),
      line('4598', 0, 1000),
    ]
    expect(posted(await expand(lines))).toEqual(formPosts(lines))
  })

  it('refuses a code that is not one of the offered kinds and rates', async () => {
    const [refusal] = await refusalsOf([
      line('6540', 1000, 0, { kind: 'import' as VoucherLineVatCode['kind'], rate: 0.25 }),
      line('1930', 0, 1000),
    ])
    expect(refusal.en).toContain('vat_code must be {"kind": eu_goods | eu_services | non_eu_services | domestic_services, "rate": 0.25 | 0.12 | 0.06}')
  })

  it('reports every refused line at once, each in English and Swedish', async () => {
    const refusals = await refusalsOf([
      line('1930', 1000, 0, NON_EU_25),
      line('4531', 1000, 0, EU_SERVICES_25),
      line('2440', 0, 2000),
    ])
    expect(refusals.map((r) => r.field)).toEqual(['lines.0.vat_code', 'lines.1.vat_code'])
    expect(refusals.every((r) => r.en.length > 0 && r.sv.length > 0 && r.en !== r.sv)).toBe(true)
  })
})

describe('the basis pair lands in the ruta and momssats that were asked for, or the code is refused', () => {
  /** KONTOPLAN with one row replaced or added. */
  const kontoplanWith = (changed: ChartRow) =>
    [...KONTOPLAN.filter((r) => r.account_number !== changed.account_number), changed]

  it('refuses a 12 % code when the kontoplan sets its basis account 4426 to 25 %', async () => {
    const rows = kontoplanWith(row('4426', 'reverse_charge_domestic', 0.25))
    const [refusal] = await refusalsOf(
      [line('6540', 1000, 0, { kind: 'domestic_services', rate: 0.12 }), line('2440', 0, 1000)],
      rows,
    )
    expect(refusal.field).toBe('lines.0.vat_code')
    expect(refusal.en).toContain('books its basis on 4426')
    expect(refusal.en).toContain('report ruta 24 at 25 %, not ruta 24 at 12 %')
    expect(refusal.sv).toContain('redovisar ruta 24 med 25 %, inte ruta 24 med 12 %')

    // The same account at the sats BAS gives it posts, as in the form.
    const matching = kontoplanWith(row('4426', 'reverse_charge_domestic', '0.12'))
    const lines = [line('6540', 1000, 0, { kind: 'domestic_services', rate: 0.12 }), line('2440', 0, 1000)]
    expect(posted(await expand(lines, matching))).toEqual(formPosts(lines, matching))
    expect((await expand(lines, matching)).map((l) => l.account_number)).toEqual(['6540', '2647', '2624', '4426', '4598', '2440'])
  })

  it('refuses a code when the kontoplan sets its basis account to another ruta', async () => {
    const [refusal] = await refusalsOf(
      [line('6540', 1000, 0, NON_EU_25), line('1930', 0, 1000)],
      kontoplanWith(row('4531', 'reverse_charge_eu_services', 0.25)),
    )
    expect(refusal.field).toBe('lines.0.vat_code')
    expect(refusal.en).toContain('books its basis on 4531')
    expect(refusal.en).toContain('report ruta 21 at 25 %, not ruta 22 at 25 %')
    expect(refusal.en).toContain('an account that reports ruta 22 at 25 % itself')
  })

  it.each([
    ['a reverse-charge momskod at 0 %', row('4535', 'reverse_charge_eu_services', 0)],
    ['a momskod that reports no purchase ruta', row('4535', 'exempt', 0)],
    ['a momskod for another purchase ruta', row('4535', 'import_goods', 0.25)],
  ])('refuses a code when its basis account has %s', async (_case, changed) => {
    const [refusal] = await refusalsOf(
      [line('6540', 1000, 0, EU_SERVICES_25), line('1930', 0, 1000)],
      kontoplanWith(changed),
    )
    expect(refusal.en).toContain('books its basis on 4535')
    expect(refusal.en).toContain('report no ruta 20-24 at 25, 12 or 6 %, not ruta 21 at 25 %')
    expect(refusal.sv).toContain('redovisar ingen ruta 20-24 med 25, 12 eller 6 %, inte ruta 21 med 25 %')
  })

  it('does not ask the basis account anything on an account with its own ruta: no pair is booked there', async () => {
    const rows = kontoplanWith(row('4536', 'reverse_charge_eu_services', 0.25))
    const lines = [line('6560', 500, 0, { kind: 'eu_services', rate: 0.12 }), line('1930', 0, 500)]
    expect((await expand(lines, rows)).map((l) => l.account_number)).toEqual(['6560', '2645', '2624', '1930'])
  })
})

describe('expandVoucherLineVatCodes: a BAS basis number the company renamed (crm#1453)', () => {
  const namesOf = (names: Record<string, string>) =>
    vi.fn(async (accounts: readonly string[]) => new Map(accounts.filter((a) => a in names).map((a) => [a, names[a]])))

  it('refuses to post the basis on a renamed 4531 when the company has no basis account of its own', async () => {
    const loadNames = namesOf({ '4531': 'Förråd - studio och location' })
    const result = await expandVoucherLineVatCodes(
      [line('5410', 1000, 0, NON_EU_25), line('1930', 0, 1000)],
      loaderOf(),
      loadNames,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusals).toHaveLength(1)
    expect(result.refusals[0].field).toBe('lines.0.vat_code')
    expect(result.refusals[0].en).toContain('Förråd - studio och location')
    expect(result.refusals[0].sv).toContain('ruta 22')
  })

  it('books the basis on the company\'s own ruta 22 account when 4531 is renamed', async () => {
    const rows = [...KONTOPLAN, row('4539', 'reverse_charge_non_eu_services', 0.25)]
    const loadNames = namesOf({ '4531': 'Säkerhet', '4539': 'Import tjänster utanför EU 25%' })
    const result = await expandVoucherLineVatCodes(
      [line('5410', 1000, 0, NON_EU_25), line('1930', 0, 1000)],
      loaderOf(rows),
      loadNames,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const accounts = result.lines.map((l) => l.account_number)
    expect(accounts).toContain('4539')
    expect(accounts).not.toContain('4531')
    expect(result.lines.find((l) => l.account_number === '4539')?.debit_amount).toBe(1000)
  })

  it('keeps 4531 when its name reads as the basis account, in any of the spellings charts use', async () => {
    for (const name of ['Inköp av tjänster från ett land utanför EU, 25 % moms', 'Purchases of services from a country outside the EU, 25%', 'Impo tj utanf EU 25%', 'Inköp av tjänster från ett lan']) {
      const result = await expandVoucherLineVatCodes(
        [line('5410', 1000, 0, NON_EU_25), line('1930', 0, 1000)],
        loaderOf(),
        namesOf({ '4531': name }),
      )
      expect(result.ok, name).toBe(true)
      if (result.ok) expect(result.lines.map((l) => l.account_number)).toContain('4531')
    }
  })

  it('reads no names when no basis pair is generated, and keeps the old behaviour without a loader', async () => {
    const loadNames = namesOf({})
    await expandVoucherLineVatCodes([line('5410', 1000), line('1930', 0, 1000)], loaderOf(), loadNames)
    expect(loadNames).not.toHaveBeenCalled()
    const noLoader = await expandVoucherLineVatCodes([line('5410', 1000, 0, EU_SERVICES_25), line('1930', 0, 1000)], loaderOf())
    expect(noLoader.ok).toBe(true)
  })
})
