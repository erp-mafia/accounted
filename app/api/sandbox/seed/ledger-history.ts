/**
 * A month-by-month posted ledger for the sandbox's current fiscal year.
 *
 * The base seed posts two verifikat, which leaves Resultatrapport, Balansrapport,
 * Nyckeltal and momsrapporten looking like a broken page rather than a demo. This
 * builder produces the missing year-to-date: January through the month BEFORE
 * today's month, at 4 to 7 verifikat per month, for the one-person Swedish
 * IT/design consultancy (enskild firma) the rest of the seed portrays.
 *
 * Pure by construction. `today` is an input, there is no Math.random and no
 * Date.now, and every amount is derived from a literal table or a modulo of the
 * month index, so the same inputs always produce byte-identical rows and the
 * unit test can assert the whole set.
 *
 * The monthly rhythm:
 *   day 3   Programvaror (SaaS-verktyg), 25 % ingående moms
 *   day 8   Mobiltelefon och abonnemang, 25 % ingående moms
 *   day 12  A rotating larger or periodic cost (some months have none)
 *   day 20  Kundinbetalning of the PREVIOUS month's faktura (not in January)
 *   day 25  Konsultarvode, faktura to a customer, 25 % utgående moms
 *   day 27  Eget uttag (not in January: no cash has come in yet)
 * plus, in January only, an owner's capital contribution on day 2. The fiscal
 * year is the sandbox company's first period and therefore has no ingående
 * balans, so without that contribution konto 1930 would go negative before the
 * first customer pays.
 *
 * Why the result is large: in an enskild firma the owner's own work is NOT a
 * cost (compensation happens through egna uttag on 2013, an equity movement),
 * so a consultancy billing ~1.1 MSEK legitimately shows a result of roughly the
 * same order. That is what a real NE-bilaga looks like.
 *
 * Accounts are restricted to the set seed_chart_of_accounts activates for
 * enskild_firma, so every row in the reports carries its BAS name instead of the
 * "Konto 6212" fallback.
 *
 * The entries deliberately carry NO voucher_number: the caller assigns those by
 * calling the next_voucher_number RPC once per entry, in array order, so the
 * sequence stays unbroken (BFNAR 2013:2). Lines carry no journal_entry_id for
 * the same reason.
 */

import { roundOre } from '@/lib/money'

/**
 * Every BAS account this builder can emit. Exported so the seed's
 * chart_of_accounts lookup can be widened in one place instead of drifting out
 * of sync with the entries below.
 */
export const SANDBOX_LEDGER_ACCOUNT_NUMBERS: readonly string[] = [
  '1510', // Kundfordringar
  '1930', // Företagskonto / checkkonto
  '2013', // Övriga egna uttag
  '2018', // Övriga egna insättningar
  '2611', // Utgående moms försäljning inom Sverige, 25 %
  '2641', // Debiterad ingående moms
  '2650', // Redovisningskonto för moms
  '3001', // Försäljning inom Sverige, 25 % moms
  '5410', // Förbrukningsinventarier
  '5420', // Programvaror
  '5460', // Förbrukningsmaterial
  '5800', // Resekostnader
  '5910', // Annonsering
  '6110', // Kontorsmateriel
  '6212', // Mobiltelefon
  '6230', // Datakommunikation
  '6530', // Redovisningstjänster
  '6570', // Bankavgifter
]

export interface SandboxLedgerHistoryInput {
  userId: string
  companyId: string
  fiscalPeriodId: string
  /** "Now" as the seed sees it. The history stops at the end of the previous month. */
  today: Date
  /** account_number to chart_of_accounts.id. Missing entries fall back to null. */
  accountMap: Record<string, string | undefined>
}

/** A journal_entries row WITHOUT voucher_number: the caller assigns that. */
export interface SandboxLedgerEntryRow {
  user_id: string
  company_id: string
  fiscal_period_id: string
  voucher_series: string
  entry_date: string
  description: string
  source_type: string
  source_id: null
  status: string
  committed_at: string
}

/** A journal_entry_lines row WITHOUT journal_entry_id: the caller fills it in. */
export interface SandboxLedgerLineRow {
  account_number: string
  account_id: string | null
  debit_amount: number
  credit_amount: number
  line_description: string
  sort_order: number
  /**
   * Always set, never omitted. PostgREST normalizes columns across a bulk
   * insert, so a row missing the key while a sibling sets it sends NULL and
   * violates the NOT NULL on journal_entry_lines.dimensions.
   */
  dimensions: Record<string, string>
}

export interface SandboxLedgerHistory {
  entries: SandboxLedgerEntryRow[]
  /** linesByEntryIndex[i] belongs to entries[i]. */
  linesByEntryIndex: SandboxLedgerLineRow[][]
}

/**
 * 'manual' is the only allowed source_type that dereferences nothing: every
 * other candidate ('invoice_created', 'bank_transaction', ...) makes the voucher
 * detail view look for a source row that this history does not have. The value
 * must come from the journal_entries_source_type_check allowlist (see
 * 20260712100500_journal_source_type_stripe_payout.sql).
 */
const SOURCE_TYPE = 'manual'
const VOUCHER_SERIES = 'A'

const MONTH_NAMES_SV = [
  'januari',
  'februari',
  'mars',
  'april',
  'maj',
  'juni',
  'juli',
  'augusti',
  'september',
  'oktober',
  'november',
  'december',
]

/** Billed hours per month. July is semester, autumn is the busy season. */
const CONSULTING_HOURS = [96, 104, 120, 112, 108, 88, 40, 72, 116, 124, 118, 84]
const HOURLY_RATE = 950

/** Owner's opening capital contribution, January only. */
const OWNER_CONTRIBUTION = 60000

interface PeriodicCost {
  accountNumber: string
  description: string
  /** Amount excluding VAT. */
  net: number
  /** Integer percent. 0 means a VAT-exempt supply: no 2641 line at all. */
  vatRate: number
}

/**
 * The day-12 cost, by month index (0 = January). null means the month has none,
 * which is what makes it read as occasional rather than as a subscription.
 *
 * VAT rates follow the supply, not the account: persontransport inom Sverige is
 * 6 % and hotellrum 12 % (ML 9 kap.), and banktjänster are undantagna från
 * moms (ML 10 kap. 33 §), so the December bank fee books gross with no input
 * VAT. Deductible input VAT always lands on 2641 regardless of the rate.
 */
const PERIODIC_COSTS: Array<PeriodicCost | null> = [
  null,
  { accountNumber: '5910', description: 'Annonsering, kampanj sociala medier', net: 2400, vatRate: 25 },
  { accountNumber: '6530', description: 'Redovisningskonsult, avstämning inför deklaration', net: 6500, vatRate: 25 },
  { accountNumber: '6230', description: 'Bredband kontorsplats, första halvåret', net: 1490, vatRate: 25 },
  { accountNumber: '5800', description: 'Tågbiljetter, kundmöten Göteborg', net: 1480, vatRate: 6 },
  { accountNumber: '5410', description: 'Extern skärm och dockningsstation', net: 4990, vatRate: 25 },
  null,
  { accountNumber: '6110', description: 'Kontorsmateriel', net: 780, vatRate: 25 },
  { accountNumber: '5800', description: 'Hotell, kundprojekt Malmö', net: 3950, vatRate: 12 },
  { accountNumber: '6230', description: 'Bredband kontorsplats, andra halvåret', net: 1490, vatRate: 25 },
  { accountNumber: '5460', description: 'Förbrukningsmaterial, kontor', net: 1150, vatRate: 25 },
  { accountNumber: '6570', description: 'Bankavgifter, årsavgift företagskonto', net: 1200, vatRate: 0 },
]

/** Internal line shape: exactly one of debit/credit is set. */
interface LineSpec {
  accountNumber: string
  debit?: number
  credit?: number
  lineDescription: string
  dimensions?: Record<string, string>
}

/** yyyy-MM-dd from calendar parts. Avoids toISOString(), which shifts to UTC. */
function dateStr(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function vatOf(net: number, vatRate: number): number {
  return roundOre((net * vatRate) / 100)
}

/** Day 0 of the next month is the last day of this one, leap years included. */
function lastDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate()
}

/**
 * Deterministic per-month variation. `(month * factor) % cycle` walks the cycle
 * in a non-obvious order, so the amounts look hand-entered without any
 * randomness: the builder must be reproducible.
 */
function vary(base: number, month: number, factor: number, cycle: number, step: number): number {
  return roundOre(base + (((month * factor) % cycle) * step))
}

/**
 * Revenue-line dimension bag, by month. Three-month cycle so the dimension P&L
 * report has data on both kostnadsställe/projekt pairs the seed creates AND a
 * meaningful untagged remainder. Every other line in the history is untagged.
 */
function revenueDimensions(month: number): Record<string, string> {
  const phase = month % 3
  if (phase === 1) return { '1': 'BUTIK', '6': 'P001' }
  if (phase === 2) return { '1': 'WEBB', '6': 'P002' }
  return {}
}

export function buildSandboxLedgerHistory({
  userId,
  companyId,
  fiscalPeriodId,
  today,
  accountMap,
}: SandboxLedgerHistoryInput): SandboxLedgerHistory {
  const year = today.getFullYear()
  /** 1-based; the history covers January through the month before this one. */
  const lastMonth = today.getMonth()

  const entries: SandboxLedgerEntryRow[] = []
  const linesByEntryIndex: SandboxLedgerLineRow[][] = []

  /**
   * Running VAT, so the quarterly momsredovisning below settles the exact
   * amounts the period's own entries produced rather than a re-derivation.
   */
  let quarterOutputVat = 0
  let quarterInputVat = 0

  const accountId = (accountNumber: string): string | null =>
    accountMap[accountNumber] ?? null

  function addEntry(entryDate: string, description: string, lines: LineSpec[]): void {
    entries.push({
      user_id: userId,
      company_id: companyId,
      fiscal_period_id: fiscalPeriodId,
      voucher_series: VOUCHER_SERIES,
      entry_date: entryDate,
      description,
      source_type: SOURCE_TYPE,
      source_id: null,
      status: 'posted',
      committed_at: entryDate,
    })
    linesByEntryIndex.push(
      lines.map((line, index) => ({
        account_number: line.accountNumber,
        account_id: accountId(line.accountNumber),
        debit_amount: roundOre(line.debit ?? 0),
        credit_amount: roundOre(line.credit ?? 0),
        line_description: line.lineDescription,
        sort_order: index,
        dimensions: line.dimensions ?? {},
      })),
    )
  }

  /** Dr cost (+ Dr 2641), Cr 1930. The bank pays it the day it happens. */
  function addBankPaidCost(entryDate: string, cost: PeriodicCost): void {
    const vat = vatOf(cost.net, cost.vatRate)
    const gross = roundOre(cost.net + vat)
    const lines: LineSpec[] = [
      { accountNumber: cost.accountNumber, debit: cost.net, lineDescription: cost.description },
    ]
    if (vat > 0) {
      quarterInputVat = roundOre(quarterInputVat + vat)
      lines.push({
        accountNumber: '2641',
        debit: vat,
        lineDescription: `Ingående moms ${cost.vatRate} %`,
      })
    }
    lines.push({
      accountNumber: '1930',
      credit: gross,
      lineDescription: 'Betalt från företagskontot',
    })
    addEntry(entryDate, cost.description, lines)
  }

  /**
   * Close one VAT quarter: clear 2611 and 2641 into 2650, then pay 2650 from
   * the bank on the SFL 26 kap. 26 § deadline.
   *
   * Without this the sandbox reads as a company that has collected VAT all
   * year and never remitted a krona: the moms liability and the bank balance
   * both climb without limit, and every cash KPI derived from them is
   * nonsense. The company files quarterly (company_settings.moms_period =
   * 'quarterly'), so each quarter is declared after it closes and paid on the
   * 12th of the second month after it.
   */
  /** Payments owed but not yet emitted, keyed by the month they fall due. */
  const vatPaymentsDue = new Map<number, { amount: number; label: string }>()

  function declareVatQuarter(quarterEndMonth: number, paymentMonth: number, label: string): void {
    const output = quarterOutputVat
    const input = quarterInputVat
    quarterOutputVat = 0
    quarterInputVat = 0

    const netPayable = roundOre(output - input)
    // A refund quarter would need the opposite sign on 2650 and a bank
    // deposit. This history is comfortably output-heavy every quarter, so
    // rather than emit a voucher whose direction was never exercised, skip.
    if (netPayable <= 0) return

    // 2611 debit + 2641 credit + 2650 is the shape get_vat_declaration_totals
    // classifies as a momsredovisning and drops from the period's totals, which
    // is exactly right: a settlement must not feed the next declaration.
    addEntry(
      dateStr(year, quarterEndMonth, lastDayOfMonth(year, quarterEndMonth)),
      `Momsredovisning ${label}`,
      [
        { accountNumber: '2611', debit: output, lineDescription: 'Utgående moms för perioden' },
        { accountNumber: '2641', credit: input, lineDescription: 'Ingående moms för perioden' },
        { accountNumber: '2650', credit: netPayable, lineDescription: 'Redovisningskonto för moms' },
      ],
    )

    vatPaymentsDue.set(paymentMonth, { amount: netPayable, label })
  }

  /**
   * Emitted from inside the payment month's own block, never from the quarter
   * close: a 12 May voucher appended while building March would put the entry
   * list out of date order, and the caller assigns voucher numbers in array
   * order (BFNAR 2013:2 expects the sequence to follow the books).
   */
  function payVatIfDue(month: number): void {
    const due = vatPaymentsDue.get(month)
    if (!due) return
    vatPaymentsDue.delete(month)
    addEntry(dateStr(year, month, 12), `Betald moms ${due.label}`, [
      { accountNumber: '2650', debit: due.amount, lineDescription: 'Redovisningskonto för moms' },
      { accountNumber: '1930', credit: due.amount, lineDescription: 'Betalt till skattekontot' },
    ])
  }

  for (let month = 1; month <= lastMonth; month++) {
    const monthName = MONTH_NAMES_SV[month - 1]
    const hours = CONSULTING_HOURS[month - 1]
    const revenueNet = hours * HOURLY_RATE
    const revenueVat = vatOf(revenueNet, 25)
    const revenueGross = roundOre(revenueNet + revenueVat)

    // ── day 2, January only: owner funds the business ────────────────────
    // The fiscal year is the company's first period, so there is no ingående
    // balans on 1930. Without this the bank account goes negative in January.
    if (month === 1) {
      addEntry(dateStr(year, month, 2), 'Egen insättning, startkapital', [
        { accountNumber: '1930', debit: OWNER_CONTRIBUTION, lineDescription: 'Insättning på företagskontot' },
        { accountNumber: '2018', credit: OWNER_CONTRIBUTION, lineDescription: 'Övriga egna insättningar' },
      ])
    }

    // ── day 3: software subscriptions ────────────────────────────────────
    addBankPaidCost(dateStr(year, month, 3), {
      accountNumber: '5420',
      description: `Programvaror, molntjänster ${monthName}`,
      net: vary(890, month, 7, 5, 60),
      vatRate: 25,
    })

    // ── day 8: mobile and subscription ───────────────────────────────────
    addBankPaidCost(dateStr(year, month, 8), {
      accountNumber: '6212',
      description: `Mobiltelefon och abonnemang, ${monthName}`,
      net: vary(429, month, 5, 4, 35),
      vatRate: 25,
    })

    // ── day 12: the rotating larger or periodic cost ─────────────────────
    const periodic = PERIODIC_COSTS[month - 1]
    if (periodic) {
      addBankPaidCost(dateStr(year, month, 12), periodic)
    }

    // ── day 12: the previous quarter's moms leaves the bank ──────────────
    // SFL 26 kap. 26 §: a quarterly filer declares and pays on the 12th of
    // the second month after the period.
    payVatIfDue(month)

    // ── day 20: the previous month's faktura is paid ─────────────────────
    // 30 day terms, so January has nothing to collect.
    if (month > 1) {
      const previousMonthName = MONTH_NAMES_SV[month - 2]
      const previousNet = CONSULTING_HOURS[month - 2] * HOURLY_RATE
      const previousGross = roundOre(previousNet + vatOf(previousNet, 25))
      addEntry(
        dateStr(year, month, 20),
        `Kundinbetalning, konsultarvode ${previousMonthName}`,
        [
          { accountNumber: '1930', debit: previousGross, lineDescription: 'Insättning på företagskontot' },
          { accountNumber: '1510', credit: previousGross, lineDescription: 'Kvittad kundfordran' },
        ],
      )
    }

    // ── day 25: the month's consulting invoice ───────────────────────────
    addEntry(
      dateStr(year, month, 25),
      `Faktura, konsultarvode ${monthName} (${hours} tim)`,
      [
        { accountNumber: '1510', debit: revenueGross, lineDescription: 'Kundfordran' },
        {
          accountNumber: '3001',
          credit: revenueNet,
          lineDescription: `Konsultarvode ${hours} tim à ${HOURLY_RATE} kr`,
          dimensions: revenueDimensions(month),
        },
        { accountNumber: '2611', credit: revenueVat, lineDescription: 'Utgående moms 25 %' },
      ],
    )
    quarterOutputVat = roundOre(quarterOutputVat + revenueVat)

    // ── day 27: eget uttag ───────────────────────────────────────────────
    // Enskild firma: the owner is not an employee, so their compensation is an
    // equity withdrawal on 2013, never a personnel cost. Skipped in January for
    // the same cash reason as the customer payment.
    if (month > 1) {
      const withdrawal = vary(38000, month, 3, 4, 4000)
      addEntry(dateStr(year, month, 27), `Eget uttag, ${monthName}`, [
        { accountNumber: '2013', debit: withdrawal, lineDescription: 'Övriga egna uttag' },
        { accountNumber: '1930', credit: withdrawal, lineDescription: 'Uttag från företagskontot' },
      ])
    }

    // ── quarter close: declare and pay the moms the quarter produced ──────
    // Emitted inside the loop rather than appended afterwards so the
    // verifikat stay in date order, which is what the voucher numbering the
    // caller assigns will follow.
    if (month === 3) declareVatQuarter(3, 5, `${year} Q1`)
    if (month === 6) declareVatQuarter(6, 8, `${year} Q2`)
    if (month === 9) declareVatQuarter(9, 11, `${year} Q3`)
  }

  return { entries, linesByEntryIndex }
}
