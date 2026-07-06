import type { SupabaseClient } from '@supabase/supabase-js'
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
}

export interface PfondAvsattningComputation {
  rate: number
  maxAmount: number
  desiredAmount: number
  actualAmount: number
  cohortAccount: string
  cohortYear: number
  cappedToMax: boolean
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
  const desiredAmount = Math.max(0, Math.floor(input.desiredAmount ?? maxAmount))
  const actualAmount = Math.min(desiredAmount, maxAmount)
  const cohortAccount = getPeriodiseringsfondCohortAccount(input.fiscalYear)
  const cappedToMax = desiredAmount > maxAmount

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
  }

  const warnings: string[] = []
  if (cappedToMax) {
    warnings.push(
      `Begärt belopp (${desiredAmount} kr) översteg ${PFOND_AB_RATE_PCT}-taket. Avsättningen begränsades till ${maxAmount} kr.`,
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
 * 2110-2199 account as of the closing date of the fiscal period. Marks any
 * fond whose cohort_year + 6 ≤ closing_year as `must_return_this_year`.
 *
 * Uses the trial-balance pattern: sum debit/credit on each 21xx account from
 * inception through the closing date. Result is positive when the credit
 * balance exceeds debits (the normal state of a liability account).
 */
export async function listExistingPeriodiseringsfonder(
  supabase: SupabaseClient,
  companyId: string,
  closingDate: string,
): Promise<ExistingFond[]> {
  const closingYear = parseInt(closingDate.slice(0, 4), 10)
  if (Number.isNaN(closingYear)) {
    throw new Error(`Invalid closing date: ${closingDate}`)
  }

  // Sum debit/credit per 21xx account up to and including the closing date.
  // Use the journal_entry_lines table directly: RLS scopes to the company.
  const { data, error } = await supabase
    .from('journal_entry_lines')
    .select(
      'account_number, debit_amount, credit_amount, journal_entries!inner(company_id, entry_date, status)',
    )
    .eq('journal_entries.company_id', companyId)
    .eq('journal_entries.status', 'posted')
    .lte('journal_entries.entry_date', closingDate)
    .gte('account_number', '2110')
    .lte('account_number', '2199')

  if (error) {
    throw new Error(`Failed to fetch periodiseringsfond balances: ${error.message}`)
  }

  type Row = { account_number: string; debit_amount: number | string | null; credit_amount: number | string | null }
  const byAccount = new Map<string, number>()
  for (const row of (data ?? []) as Row[]) {
    const balance =
      (Number(row.credit_amount) || 0) - (Number(row.debit_amount) || 0)
    byAccount.set(row.account_number, (byAccount.get(row.account_number) ?? 0) + balance)
  }

  const fonder: ExistingFond[] = []
  for (const [accountNumber, balance] of byAccount) {
    if (Math.abs(balance) < 0.005) continue
    const cohortYear = cohortYearFromAccount(accountNumber)
    if (cohortYear === null) continue
    fonder.push({
      account_number: accountNumber,
      cohort_year: cohortYear,
      balance: Math.round(balance * 100) / 100,
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
 * the schablonintäkt on the opening balance of all 21xx accounts (per IL 30
 * kap 6a §): caller adds this to taxable result when computing bolagsskatt.
 *
 * @param schablonintaktRate Statslåneräntan 30 nov året före, plus 1 pe, min
 *   0.5 %. For income year 2025: ~3.0 %. Caller passes this in because the
 *   rate changes annually and is sourced from Riksbanken.
 */
export function proposeAteforing(
  existingFonder: ExistingFond[],
  options: {
    /** Map from account_number to desired return amount. Omit entries the
     *  user does not want to return (mandatory ones are returned regardless). */
    returns?: Record<string, number>
    /** Schablonintäkt rate as a decimal (0.03 for 3 %). Applied to opening
     *  balance of every 21xx account. */
    schablonintaktRate: number
  },
): PfondAteforingProposal {
  const proposals: ProposedDisposition[] = []
  let schablonintaktAmount = 0

  for (const fond of existingFonder) {
    schablonintaktAmount += fond.balance * options.schablonintaktRate

    const desiredReturn = options.returns?.[fond.account_number] ?? 0
    const isMandatory = fond.must_return_this_year
    const returnAmount = isMandatory
      ? fond.balance // forced full reversal
      : Math.min(Math.max(0, Math.floor(desiredReturn)), fond.balance)

    if (returnAmount === 0) continue

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
