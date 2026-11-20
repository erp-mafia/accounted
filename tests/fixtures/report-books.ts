/**
 * Three closed-and-carried fiscal years of books for report equivalence
 * tests, per legal form, as rows for tests/ledger-fake-db.ts.
 *
 * Each year opens from an IB entry (opening_balance_entry_id), sells,
 * collects, pays costs and öre fees, settles VAT, books depreciation as a
 * year_end entry that is NOT the resultatavslut, carries a reversed voucher
 * with its storno, and ends with the resultatavslut into the form's closing
 * account (linked as closing_entry_id). The next year's IB entry carries every
 * balance account, the year's result moved to the carry account where the
 * form has one. 2023 and 2024 are closed; 2025 has its resultatavslut booked
 * but is still open.
 *
 * IB line ids run in DESCENDING account order, so a report that keeps the
 * IB entry's line order is told apart from one that sorts by account.
 */
import type { LedgerRow } from '../ledger-fake-db'

export const BOOKS_COMPANY_ID = 'co-books'

export type BooksForm = 'aktiebolag' | 'enskild_firma' | 'ekonomisk_forening'

interface FormShape {
  /** Bound or owner equity booked in the first IB, account → credit amount. */
  capital: Record<string, number>
  closing: string
  carry: string | null
  /** Owner withdrawal booked each year (enskild firma only). */
  withdrawal: string | null
}

const SHAPES: Record<BooksForm, FormShape> = {
  aktiebolag: { capital: { '2081': 25000 }, closing: '2099', carry: '2098', withdrawal: null },
  enskild_firma: { capital: { '2010': 25000 }, closing: '2010', carry: null, withdrawal: '2013' },
  ekonomisk_forening: { capital: { '2083': 20000, '2084': 5000 }, closing: '2099', carry: '2098', withdrawal: null },
}

const ACCOUNT_NAMES: Record<string, string> = {
  '1220': 'Inventarier och verktyg',
  '1229': 'Ackumulerade avskrivningar på inventarier och verktyg',
  '1510': 'Kundfordringar',
  '1630': 'Avräkning för skatter och avgifter (skattekonto)',
  '1930': 'Företagskonto / affärskonto',
  '2010': 'Eget kapital',
  '2013': 'Övriga egna uttag',
  '2081': 'Aktiekapital',
  '2083': 'Medlemsinsatser',
  '2084': 'Förlagsinsatser',
  '2091': 'Balanserad vinst eller förlust',
  '2098': 'Vinst eller förlust från föregående år',
  '2099': 'Årets resultat',
  '2611': 'Utgående moms på försäljning inom Sverige, 25 %',
  '2641': 'Debiterad ingående moms',
  '2650': 'Redovisningskonto för moms',
  '3001': 'Försäljning inom Sverige, 25 % moms',
  '5010': 'Lokalhyra',
  '6110': 'Kontorsmateriel',
  '6570': 'Bankkostnader',
  '7832': 'Avskrivningar på inventarier och verktyg',
}

const YEARS = [
  { id: 'fp-2023', name: '2023', start: '2023-01-01', end: '2023-12-31', closed: true },
  { id: 'fp-2024', name: '2024', start: '2024-01-01', end: '2024-12-31', closed: true },
  { id: 'fp-2025', name: '2025', start: '2025-01-01', end: '2025-12-31', closed: false },
]

type Line = [account: string, debit: number, credit: number]

const round = (n: number) => Math.round(n * 100) / 100

export interface ReportBooksOptions {
  /** Extra small vouchers in 2024 (the year before the current one), to measure scaling. */
  priorYearVouchers?: number
}

export function reportBooks(form: BooksForm, options: ReportBooksOptions = {}): Record<string, LedgerRow[]> {
  const shape = SHAPES[form]
  const periods: LedgerRow[] = []
  const entries: LedgerRow[] = []
  const lines: LedgerRow[] = []
  let entrySeq = 0
  let lineSeq = 0

  const book = (
    period: (typeof YEARS)[number],
    date: string,
    description: string,
    entryLines: Line[],
    extra: LedgerRow = {},
    lineIds?: string[],
  ): string => {
    entrySeq += 1
    const id = `je-${String(entrySeq).padStart(3, '0')}`
    entries.push({
      id,
      company_id: BOOKS_COMPANY_ID,
      fiscal_period_id: period.id,
      entry_date: date,
      description,
      voucher_series: 'A',
      voucher_number: entrySeq,
      status: 'posted',
      source_type: 'manual',
      reverses_id: null,
      correction_of_id: null,
      created_at: `${date}T12:00:00Z`,
      ...extra,
    })
    entryLines.forEach(([account, debit, credit], index) => {
      lineSeq += 1
      lines.push({
        id: lineIds?.[index] ?? `jl-${String(lineSeq).padStart(4, '0')}`,
        journal_entry_id: id,
        company_id: BOOKS_COMPANY_ID,
        account_number: account,
        debit_amount: debit,
        credit_amount: credit,
        line_description: null,
        dimensions: {},
      })
    })
    return id
  }

  /** Net (debit - credit) per account over the given entries, öre-exact. */
  const netOf = (entryIds: Set<string>) => {
    const net = new Map<string, number>()
    for (const line of lines) {
      if (!entryIds.has(String(line.journal_entry_id))) continue
      const account = String(line.account_number)
      net.set(account, round((net.get(account) ?? 0) + Number(line.debit_amount) - Number(line.credit_amount)))
    }
    return net
  }

  // First IB: the capital paid in, on the bank account (net, debit positive).
  let carried = new Map<string, number>([
    ['1930', 25000],
    ...Object.entries(shape.capital).map(([account, amount]) => [account, -amount] as [string, number]),
  ])

  YEARS.forEach((year, index) => {
    // IB entry: one line per carried balance, plus a 1630 pair that nets to
    // zero (a balance read as IB whose net is 0 kr).
    const ibLines: Line[] = [...carried.entries()]
      .filter(([, net]) => net !== 0)
      .map(([account, net]) => [account, net > 0 ? net : 0, net < 0 ? -net : 0] as Line)
    ibLines.push(['1630', 100, 0], ['1630', 0, 100])
    ibLines.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    const ibIds = ibLines.map((_, i) => `jl-ib-${year.name}-${String(ibLines.length - i).padStart(2, '0')}`)
    const ibId = book(year, year.start, `Ingående balans ${year.name}`, ibLines, { source_type: 'opening_balance' }, ibIds)

    const k = index + 1
    const ids = new Set<string>()
    const add = (id: string) => (ids.add(id), id)
    add(book(year, `${year.name}-02-10`, 'Försäljning', [['1510', 12500 * k, 0], ['3001', 0, 10000 * k], ['2611', 0, 2500 * k]]))
    add(book(year, `${year.name}-03-10`, 'Inbetalning', [['1930', 12500 * k, 0], ['1510', 0, 12500 * k]]))
    add(book(year, `${year.name}-04-01`, 'Hyra', [['5010', 3000, 0], ['2641', 750, 0], ['1930', 0, 3750]]))
    add(book(year, `${year.name}-04-02`, 'Bankavgift', [['6570', 0.1, 0], ['1930', 0, 0.1]]))
    add(book(year, `${year.name}-04-03`, 'Bankavgift', [['6570', 0.2, 0], ['1930', 0, 0.2]]))
    add(book(year, `${year.name}-05-05`, 'Bankavgift', [['6570', 123.45, 0], ['1930', 0, 123.45]]))
    if (index === 0) add(book(year, '2023-06-01', 'Inköp dator', [['1220', 5000, 0], ['1930', 0, 5000]]))
    if (index === 1) {
      for (let i = 0; i < (options.priorYearVouchers ?? 0); i += 1) {
        add(book(year, '2024-10-01', 'Småinköp', [['6110', 10, 0], ['1930', 0, 10]]))
      }
    }
    if (shape.withdrawal) {
      add(book(year, `${year.name}-07-01`, 'Eget uttag', [[shape.withdrawal, 1000, 0], ['1930', 0, 1000]]))
    }
    // A voucher reversed by storno: both stay in the year, netting to zero.
    const reversed = add(
      book(year, `${year.name}-08-01`, 'Kontorsmateriel', [['6110', 200, 0], ['1930', 0, 200]], { status: 'reversed' }),
    )
    add(
      book(year, `${year.name}-08-02`, 'Makulering', [['1930', 200, 0], ['6110', 0, 200]], { reverses_id: reversed }),
    )
    const vat = netOf(ids)
    add(
      book(year, `${year.name}-09-12`, 'Momsredovisning', [
        ['2611', -(vat.get('2611') ?? 0), 0],
        ['2641', 0, vat.get('2641') ?? 0],
        ['2650', 0, round(-(vat.get('2611') ?? 0) - (vat.get('2641') ?? 0))],
      ]),
    )
    // Depreciation: a year_end entry that is not the resultatavslut.
    add(book(year, year.end, 'Avskrivning', [['7832', 1000, 0], ['1229', 0, 1000]], { source_type: 'year_end' }))

    // Resultatavslut: every result account against the closing account.
    const result = netOf(ids)
    const closingLines: Line[] = []
    let total = 0
    for (const [account, net] of [...result.entries()].sort()) {
      if (account[0] < '3' || net === 0) continue
      closingLines.push([account, net < 0 ? -net : 0, net > 0 ? net : 0])
      total = round(total + net)
    }
    closingLines.push([shape.closing, total > 0 ? total : 0, total < 0 ? -total : 0])
    const closingId = add(book(year, year.end, `Årsbokslut ${year.name}`, closingLines, { source_type: 'year_end' }))

    periods.push({
      id: year.id,
      company_id: BOOKS_COMPANY_ID,
      name: year.name,
      period_start: year.start,
      period_end: year.end,
      previous_period_id: index === 0 ? null : YEARS[index - 1].id,
      opening_balance_entry_id: ibId,
      closing_entry_id: closingId,
      is_closed: year.closed,
      closed_externally: false,
      locked_at: year.closed ? `${Number(year.name) + 1}-03-01T00:00:00Z` : null,
    })

    // Next IB: this year's closing balances, the result moved to the carry.
    const next = new Map(carried)
    for (const [account, net] of netOf(ids)) next.set(account, round((next.get(account) ?? 0) + net))
    for (const [account, net] of [...next.entries()]) {
      if (account[0] >= '3') next.delete(account)
      else if (shape.carry && account === shape.closing) {
        next.set(shape.carry, round((next.get(shape.carry) ?? 0) + net))
        next.delete(account)
      }
    }
    carried = next
  })

  const chart: LedgerRow[] = Object.entries(ACCOUNT_NAMES).map(([account, name]) => ({
    id: `acc-${account}`,
    company_id: BOOKS_COMPANY_ID,
    account_number: account,
    account_name: name,
    account_class: Number(account[0]),
    is_active: true,
    sru_code: account[0] === '3' ? '7410' : null,
  }))

  return {
    fiscal_periods: periods,
    journal_entries: entries,
    journal_entry_lines: lines,
    chart_of_accounts: chart,
    companies: [{ id: BOOKS_COMPANY_ID, entity_type: form, accounting_framework: 'k2' }],
    company_settings: [
      {
        company_id: BOOKS_COMPANY_ID,
        company_name: 'Bokföringsexempel',
        org_number: '5566778899',
        registered_office: 'Sundsvall',
        city: 'Sundsvall',
        entity_type: form,
        aktiekapital: form === 'aktiebolag' ? 25000 : null,
        antal_aktier: form === 'aktiebolag' ? 250 : null,
      },
    ],
    arsredovisning_narratives: [
      {
        company_id: BOOKS_COMPANY_ID,
        fiscal_period_id: 'fp-2025',
        agm_date: '2026-04-15',
      },
    ],
  }
}
