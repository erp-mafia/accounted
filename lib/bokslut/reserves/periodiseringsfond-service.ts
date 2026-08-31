import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchEntryLines, type EntryLinesQuery } from '@/lib/bookkeeping/entry-lines'
import { roundOre } from '@/lib/money'
import type { ProposedDisposition } from '../types'

/** Maximum periodiseringsfond avsättning for aktiebolag: 25 % of skattemässigt
 *  resultat före avsättning. Enskild firma uses 30 % but is handled in NE/INK1
 *  rather than booked. */
export const PFOND_AB_RATE = 0.25
export const PFOND_AB_RATE_PCT = '25 %'

/** Mandatory holding period: a fond avsatt år N must be återförd no later
 *  than räkenskapsår N+6 (IL 30 kap 7 §). */
export const PFOND_MAX_HOLD_YEARS = 6

/**
 * Schablonintäkt rate on periodiseringsfonder for juridiska personer
 * (IL 30 kap 6a §): statslåneräntan 30 November of the year preceding the
 * calendar year in which the beskattningsår ends, floored at 0.5 %. Note:
 * the rate is the SLR itself, NOT SLR + 1 procentenhet (that formula is
 * negativ räntefördelning). Keyed by the closing calendar year.
 *
 * The table starts at closing year 2020. The "100 % of SLR" rule applies to
 * beskattningsår that START 2019-01-01 or later (prop. 2017/18:245; before
 * that the rate was 72 % of SLR), so a 2019 closing can still be a brutet
 * räkenskapsår under the old factor: 2019 and earlier therefore stay
 * unmapped (fail closed) rather than carry a value that is wrong for some
 * companies. SLR values per Riksgälden's 30 November announcements.
 */
const SCHABLONINTAKT_RATE_BY_CLOSING_YEAR: Record<number, number> = {
  2020: 0.005, // SLR 2019-11-30 = -0.09 %, floored to 0.5 %
  2021: 0.005, // SLR 2020-11-30 = -0.10 %, floored to 0.5 %
  2022: 0.005, // SLR 2021-11-30 = 0.23 %, floored to 0.5 %
  2023: 0.0194, // SLR 2022-11-30 = 1.94 %
  2024: 0.0262, // SLR 2023-11-30 = 2.62 %
  2025: 0.0196, // SLR 2024-11-30 = 1.96 %
  2026: 0.0255, // SLR 2025-11-30 = 2.55 %
}

/**
 * Thrown when the closing year has no SLR in the table. Carries a registry
 * code so errorResponse() maps it to a specific Swedish message instead of a
 * generic "oväntat serverfel", and the fiscal year so the UI or an agent can
 * name the year.
 */
export class SchablonintaktRateNotConfiguredError extends Error {
  readonly code = 'SCHABLONINTAKT_RATE_NOT_CONFIGURED'
  constructor(readonly fiscalYear: number) {
    super(
      `Schablonintäkt rate for fiscal year ${fiscalYear} is not configured. `
      + 'Add the SLR (30 Nov of the preceding year, floor 0.5 %) to '
      + 'SCHABLONINTAKT_RATE_BY_CLOSING_YEAR in periodiseringsfond-service.ts.',
    )
    this.name = 'SchablonintaktRateNotConfiguredError'
  }
}

/**
 * Fail closed for unmapped years: a statutory rate must never be guessed.
 * The table is an annual maintenance item (Riksbanken publishes the SLR on
 * 30 November); a missing year surfaces loudly here instead of silently
 * producing a wrong INK2S 4.6a adjustment. POST callers can still override
 * the rate per request while the table update lands.
 */
export function getSchablonintaktRate(fiscalYear: number): number {
  const rate = SCHABLONINTAKT_RATE_BY_CLOSING_YEAR[fiscalYear]
  if (rate === undefined) throw new SchablonintaktRateNotConfiguredError(fiscalYear)
  return rate
}

/**
 * Resolve the schablonintäkt rate for one bokslut run. The rate only matters
 * when some 212X account carried a balance at beskattningsårets ingång
 * (IL 30 kap 6a §: schablonintäkt = rate × opening fond balance), so a
 * company without periodiseringsfonder never consults the table and never
 * fails on an unmapped year: the bokslut wizard must not 500 for the common
 * no-fond AB just because that year's SLR is missing (which is exactly what
 * happened for every pre-2025 closing before the table was backfilled). With
 * opening fonder the table is authoritative unless the caller supplied a
 * validated override; a missing year still fails closed.
 */
export function resolveSchablonintaktRate(
  fiscalYear: number,
  existingFonder: ReadonlyArray<Pick<ExistingFond, 'opening_balance'>>,
  override?: number,
): number {
  if (override !== undefined) return override
  const hasOpeningBalance = existingFonder.some((f) => f.opening_balance > 0)
  if (!hasOpeningBalance) return 0
  return getSchablonintaktRate(fiscalYear)
}

/**
 * BAS account convention: account = '212' + (fiscalYear % 10). 2020 → '2120',
 * 2025 → '2125'. The collision year 2019/2029 maps to '2129' per the BAS
 * 2020 seed; if a company has fonder in both years on the same account, the
 * service surfaces a warning so the user can split the balance manually.
 */
export function getPeriodiseringsfondCohortAccount(fiscalYear: number): string {
  if (fiscalYear === 2019) return '2129'
  return '212' + (fiscalYear % 10).toString()
}

export interface ExistingFond {
  /** BAS account number for the cohort (e.g. '2120'). */
  account_number: string
  /** Cohort year derived from account naming convention (e.g. 2020 for 2120). */
  cohort_year: number
  /** Current credit balance (positive = liability balance). */
  balance: number
  /** Credit balance at the START of the fiscal period (beskattningsårets
   *  ingång). This is the schablonintäkt base per IL 30 kap 6a §: a fond
   *  avsatt in this year's bokslut has opening 0 and yields none, while a
   *  fond fully återförd during the year still yields it in full. */
  opening_balance: number
  /** True if the fond must be returned this year (cohort_year + 6 ≤ closing_year). */
  must_return_this_year: boolean
}

export interface PfondAvsattningInput {
  /** Skattemässigt resultat före avsättning. 25 % cap is applied to this. */
  skattemassigtResultatBeforeAvsattning: number
  /** Amount the user wants to set aside. Defaults to the maximum (25 %). */
  desiredAmount?: number
  /** Closing year of the fiscal period (e.g. 2025 for FY ending 2025-12-31).
   *  Determines which cohort account to use. */
  fiscalYear: number
  /** Balance already booked on this year's cohort account (a previous
   *  avsättning in the same bokslut). Reduces the remaining headroom under
   *  the 25 % cap so re-running the flow can never double-provision. */
  alreadyProvisioned?: number
}

export interface PfondAvsattningComputation {
  rate: number
  maxAmount: number
  desiredAmount: number
  actualAmount: number
  cohortAccount: string
  cohortYear: number
  cappedToMax: boolean
  alreadyProvisioned: number
}

/**
 * Propose a periodiseringsfond avsättning. Caps the user's desired amount
 * to 25 % of skattemässigt resultat före avsättning (rounded down to whole
 * krona). Returns null when no positive avsättning would result (loss year
 * or zero desired).
 */
export function proposeAvsattning(input: PfondAvsattningInput): ProposedDisposition | null {
  const base = Math.max(0, Math.floor(input.skattemassigtResultatBeforeAvsattning))
  const maxAmount = Math.floor(base * PFOND_AB_RATE)
  // The 25 % cap applies to the YEAR's total avsättning: anything already
  // booked on this year's cohort account consumes headroom.
  const alreadyProvisioned = Math.max(0, Math.floor(input.alreadyProvisioned ?? 0))
  const headroom = Math.max(0, maxAmount - alreadyProvisioned)
  const desiredAmount = Math.max(0, Math.floor(input.desiredAmount ?? headroom))
  const actualAmount = Math.min(desiredAmount, headroom)
  const cohortAccount = getPeriodiseringsfondCohortAccount(input.fiscalYear)
  const cappedToMax = desiredAmount > headroom

  if (actualAmount === 0) {
    return null
  }

  const computation: PfondAvsattningComputation = {
    rate: PFOND_AB_RATE,
    maxAmount,
    desiredAmount,
    actualAmount,
    cohortAccount,
    cohortYear: input.fiscalYear,
    cappedToMax,
    alreadyProvisioned,
  }

  const warnings: string[] = []
  if (cappedToMax) {
    warnings.push(
      alreadyProvisioned > 0
        ? `Begärt belopp (${desiredAmount} kr) översteg kvarvarande utrymme under ${PFOND_AB_RATE_PCT}-taket (${maxAmount} kr, varav ${alreadyProvisioned} kr redan avsatt). Avsättningen begränsades till ${headroom} kr.`
        : `Begärt belopp (${desiredAmount} kr) översteg ${PFOND_AB_RATE_PCT}-taket. Avsättningen begränsades till ${maxAmount} kr.`,
    )
  }

  return {
    kind: 'periodiseringsfond_avsattning',
    label: `Avsättning till periodiseringsfond ${input.fiscalYear}`,
    description: `Debet 8811, kredit ${cohortAccount}. Max ${PFOND_AB_RATE_PCT} av skattemässigt resultat.`,
    amount: actualAmount,
    lines: [
      {
        account_number: '8811',
        debit_amount: actualAmount,
        credit_amount: 0,
        line_description: `Avsättning periodiseringsfond ${input.fiscalYear}`,
      },
      {
        account_number: cohortAccount,
        debit_amount: 0,
        credit_amount: actualAmount,
        line_description: `Periodiseringsfond ${input.fiscalYear}`,
      },
    ],
    warnings,
    computation: computation as unknown as Record<string, unknown>,
  }
}

/**
 * List existing periodiseringsfonder by querying the account balance of every
 * 2110-2199 account as of the closing date of the fiscal period, plus the
 * balance at `periodStart` (the schablonintäkt base). Marks any fond whose
 * cohort_year + 6 ≤ closing_year as `must_return_this_year`. Accounts where
 * BOTH balances are zero are dropped; a fond fully återförd during the
 * period is kept (closing 0, opening > 0) so its schablonintäkt survives.
 *
 * When the period has an opening-balance entry (created by year-end closing
 * of the previous period, dated at period_start), that entry ALREADY carries
 * the accumulated 21xx balances: opening = the OB entry's lines, closing =
 * OB + current-period activity, and pre-period entries are ignored (counting
 * them alongside the OB entry would double every carried fond). Without an
 * OB entry (first fiscal year, plain SIE history) the balances fall back to
 * the full history sum, split at period_start.
 */
export async function listExistingPeriodiseringsfonder(
  supabase: SupabaseClient,
  companyId: string,
  closingDate: string,
  periodStart: string,
  openingBalanceEntryId?: string | null,
): Promise<ExistingFond[]> {
  const closingYear = parseInt(closingDate.slice(0, 4), 10)
  if (Number.isNaN(closingYear)) {
    throw new Error(`Invalid closing date: ${closingDate}`)
  }
  // Full validity parse: '2025-02-31' passes a shape regex but would silently
  // misclassify every entry in the opening/closing split below.
  const periodStartParsed = new Date(`${periodStart}T00:00:00Z`)
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(periodStart)
    || Number.isNaN(periodStartParsed.getTime())
    || periodStartParsed.toISOString().slice(0, 10) !== periodStart
  ) {
    throw new Error(`Invalid period start: ${periodStart}`)
  }

  // Sum debit/credit per 21xx account up to and including the closing date.
  // Two-step entry-lines fetch (see lib/bookkeeping/entry-lines.ts): drives
  // the query from journal_entries and paginates, instead of the old
  // journal_entries!inner embed that scanned all tenants' lines and silently
  // truncated at PostgREST's 1000-row cap. The parent entry_date is attached
  // per line so opening balances need no second query.
  type Row = {
    account_number: string
    debit_amount: number | string | null
    credit_amount: number | string | null
    journal_entry_id?: string
    journal_entries?: { entry_date?: string }
  }
  let data: Row[]
  try {
    data = await fetchEntryLines<Row>({
      supabase,
      entryColumns: 'id, entry_date',
      lineColumns: 'account_number, debit_amount, credit_amount',
      filterEntries: (q: EntryLinesQuery) =>
        q
          .eq('company_id', companyId)
          // Storno semantics: a reversed entry stays in the ledger and its
          // storno cancels it. Counting only 'posted' would see the storno's
          // debit but not the reversed original's credit, producing a
          // negative phantom balance on the fond account.
          .in('status', ['posted', 'reversed'])
          .lte('entry_date', closingDate),
      filterLines: (q: EntryLinesQuery) =>
        q.gte('account_number', '2110').lte('account_number', '2199'),
    })
  } catch (err) {
    throw new Error(
      `Failed to fetch periodiseringsfond balances: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const byAccount = new Map<string, { closing: number; opening: number }>()
  for (const row of data) {
    const delta =
      (Number(row.credit_amount) || 0) - (Number(row.debit_amount) || 0)
    const entryDate = row.journal_entries?.entry_date
    const rec = byAccount.get(row.account_number) ?? { closing: 0, opening: 0 }
    if (openingBalanceEntryId) {
      if (row.journal_entry_id === openingBalanceEntryId) {
        // The OB entry IS the carried balance: opening and closing both.
        rec.opening += delta
        rec.closing += delta
      } else if (typeof entryDate === 'string' && entryDate >= periodStart) {
        // Current-period activity on top of the carried balance.
        rec.closing += delta
      }
      // Pre-period entries: ignored, their net effect is inside the OB entry.
    } else {
      rec.closing += delta
      if (typeof entryDate === 'string' && entryDate < periodStart) {
        rec.opening += delta
      }
    }
    byAccount.set(row.account_number, rec)
  }

  const fonder: ExistingFond[] = []
  for (const [accountNumber, { closing, opening }] of byAccount) {
    if (Math.abs(closing) < 0.005 && Math.abs(opening) < 0.005) continue
    const cohortYear = cohortYearFromAccount(accountNumber)
    if (cohortYear === null) continue
    fonder.push({
      account_number: accountNumber,
      cohort_year: cohortYear,
      balance: roundOre(closing),
      opening_balance: roundOre(opening),
      must_return_this_year: cohortYear + PFOND_MAX_HOLD_YEARS <= closingYear,
    })
  }

  fonder.sort((a, b) => a.cohort_year - b.cohort_year)
  return fonder
}

/**
 * Derive the cohort year from a BAS account number. Returns null for accounts
 * that don't follow the '212X' convention (e.g. 2110 = grouping account, no
 * specific cohort).
 */
function cohortYearFromAccount(accountNumber: string): number | null {
  if (!/^212\d$/.test(accountNumber)) return null
  const lastDigit = parseInt(accountNumber.slice(-1), 10)
  // BAS 2020: 2129 represents 2019 by convention; 2128 = 2028.
  if (lastDigit === 9) return 2019
  // For 0-8, the cohort year is in the 2020s. As fiscal years extend past
  // 2029 the convention will recycle (2120 might mean 2030 then); cap at
  // 2020-decade interpretation for now and surface ambiguity in a warning.
  return 2020 + lastDigit
}

export interface PfondAteforingProposal {
  /** One proposal per individual fond being returned. The wizard renders these
   *  as separate cards; mandatory ones (must_return_this_year) cannot be skipped. */
  proposals: ProposedDisposition[]
  /** Total schablonintäkt computed on the OPENING balance of all 21xx accounts.
   *  This is NOT booked: it goes into INK2 as a manual adjustment to taxable
   *  result. Caller (bolagsskatt-calculator) reads this to add to taxable result. */
  schablonintaktAmount: number
}

/**
 * Propose periodiseringsfond reversals. Forces reversal of any fond reaching
 * its 6-year limit; offers optional reversal of newer fonder. Also computes
 * the schablonintäkt on the OPENING balance of all 21xx accounts (per IL 30
 * kap 6a §: the base is the fond balance at beskattningsårets ingång, so a
 * fond avsatt in this year's bokslut yields none and a fond fully återförd
 * during the year still yields it in full): caller adds this to taxable
 * result when computing bolagsskatt.
 *
 * @param schablonintaktRate Statslåneräntan 30 nov året före det kalenderår
 *   beskattningsåret går ut, min 0.5 % (IL 30 kap 6a §). Use
 *   {@link getSchablonintaktRate}; caller passes it in because the rate
 *   changes annually and can be overridden per request.
 */
export function proposeAteforing(
  existingFonder: ExistingFond[],
  options: {
    /** Map from account_number to desired return amount. Omit entries the
     *  user does not want to return (mandatory ones are returned regardless). */
    returns?: Record<string, number>
    /** Schablonintäkt rate as a decimal (0.03 for 3 %). Applied to the
     *  opening balance of every 21xx account. */
    schablonintaktRate: number
  },
): PfondAteforingProposal {
  const proposals: ProposedDisposition[] = []
  let schablonintaktAmount = 0

  for (const fond of existingFonder) {
    // Schablonintäkt runs on the opening balance regardless of what happens
    // to the fond during the year.
    schablonintaktAmount += Math.max(0, fond.opening_balance) * options.schablonintaktRate

    // A fond with no (or negative) closing balance has nothing to return.
    // Negative balances are a data anomaly (e.g. a debit-only view of a
    // storno pair); proposing a negative återföring would produce an
    // uncommittable entry.
    if (fond.balance <= 0) continue

    const desiredReturn = options.returns?.[fond.account_number] ?? 0
    const isMandatory = fond.must_return_this_year
    const returnAmount = isMandatory
      ? fond.balance // forced full reversal
      : Math.min(Math.max(0, Math.floor(desiredReturn)), fond.balance)

    if (returnAmount <= 0) continue

    const warnings: string[] = []
    if (isMandatory) {
      warnings.push(
        `Periodiseringsfond ${fond.cohort_year} har nått 6-årsgränsen och måste återföras.`,
      )
    }

    proposals.push({
      kind: 'periodiseringsfond_ateforing',
      label: `Återföring periodiseringsfond ${fond.cohort_year}`,
      description: `Debet ${fond.account_number}, kredit 8819.`,
      amount: returnAmount,
      lines: [
        {
          account_number: fond.account_number,
          debit_amount: returnAmount,
          credit_amount: 0,
          line_description: `Återföring periodiseringsfond ${fond.cohort_year}`,
        },
        {
          account_number: '8819',
          debit_amount: 0,
          credit_amount: returnAmount,
          line_description: `Återföring periodiseringsfond ${fond.cohort_year}`,
        },
      ],
      warnings,
      computation: {
        cohort_year: fond.cohort_year,
        opening_balance: fond.balance,
        return_amount: returnAmount,
        was_mandatory: isMandatory,
      },
      required: isMandatory,
    })
  }

  return {
    proposals,
    schablonintaktAmount: Math.round(schablonintaktAmount),
  }
}
