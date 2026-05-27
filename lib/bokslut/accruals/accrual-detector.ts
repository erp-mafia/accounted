import type { SupabaseClient } from '@supabase/supabase-js'
import { generateVacationLiability } from '@/lib/reports/vacation-liability'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import type { AccrualProposal, AccrualsProposal } from './types'

/** Sociala avgifter on accrued salary/vacation (K3 BFNAR 2012:1 ch.19,
 *  K2 BFNAR 2016:10 ch.16). Same rate as the regular AGI calculation. */
export const AVGIFTER_RATE_ON_ACCRUED = 0.3142

/**
 * Compute the next-day ISO date for auto-reversal. The accrual is reversed
 * on the first day of the period following the closing date.
 */
function nextDayIso(closingDate: string): string {
  const d = new Date(closingDate + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

/**
 * Propose an adjustment of semesterlöneskuld (vacation pay liability).
 *
 * Two correctness rules drive this entry (per BFNAR 2016:10 ch.16 and the
 * vacation-liability report):
 *
 *   1. The delta is anchored against the **current closing balance** of
 *      2920 (after any mid-year partial accruals / reversals), not the
 *      opening balance. Anchoring on opening would over- or understate the
 *      adjustment by the sum of in-period movements.
 *
 *   2. Semesterlöneskuld is a balance-sheet carry-forward (2920 / 2940
 *      persist until the vacation is actually paid). The bokslut delta is
 *      a normal posting that does NOT reverse on Jan 1 — reversing would
 *      zero the liability on day 1 of the new year, which is a known
 *      Swedish bookkeeping error. Hence `reverses_on` is empty for this
 *      proposal; the wizard / UI suppresses the reversal badge accordingly.
 *
 * Returns null when delta is zero (no entry to propose).
 */
export async function proposeVacationLiabilityChange(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  options: { closingDate: string },
): Promise<AccrualProposal | null> {
  const closingYear = parseInt(options.closingDate.slice(0, 4), 10)
  if (Number.isNaN(closingYear)) {
    throw new Error(`Invalid closing date: ${options.closingDate}`)
  }

  const [report, tb] = await Promise.all([
    generateVacationLiability(supabase, companyId, closingYear),
    generateTrialBalance(supabase, companyId, fiscalPeriodId),
  ])

  // Current closing balance (what 2920 should be at year-end)
  const targetLiability = Math.round(report.totals.accruedAmount)
  // Anchor on the CURRENT closing balance, not opening — captures any
  // mid-year accruals / reversals that have already touched 2920.
  const row2920 = tb.rows.find((r) => r.account_number === '2920')
  const currentLiability = row2920
    ? Math.round((row2920.closing_credit - row2920.closing_debit) * 100) / 100
    : 0

  const deltaLiability = targetLiability - currentLiability
  if (Math.abs(deltaLiability) < 1) {
    return null
  }

  // Round each side to whole krona so the entry stays balanced after
  // rounding. Compute avgifter on the same rounded delta.
  const deltaInt = Math.round(deltaLiability)
  const avgifterDelta = Math.round(deltaInt * AVGIFTER_RATE_ON_ACCRUED)

  // Positive delta = more vacation liability accrued → debit 7090 expense.
  // Negative delta = vacation taken / liability released → credit 7090.
  const isIncrease = deltaInt > 0
  const lines = [
    {
      account_number: '7090',
      debit_amount: isIncrease ? Math.abs(deltaInt) : 0,
      credit_amount: isIncrease ? 0 : Math.abs(deltaInt),
      line_description: 'Förändring av semesterlöneskuld',
    },
    {
      account_number: '2920',
      debit_amount: isIncrease ? 0 : Math.abs(deltaInt),
      credit_amount: isIncrease ? Math.abs(deltaInt) : 0,
      line_description: 'Upplupna semesterlöner',
    },
    {
      account_number: '7519',
      debit_amount: isIncrease ? Math.abs(avgifterDelta) : 0,
      credit_amount: isIncrease ? 0 : Math.abs(avgifterDelta),
      line_description: 'Sociala avgifter på upplupen semester (31,42 %)',
    },
    {
      account_number: '2940',
      debit_amount: isIncrease ? 0 : Math.abs(avgifterDelta),
      credit_amount: isIncrease ? Math.abs(avgifterDelta) : 0,
      line_description: 'Upplupna sociala avgifter på semester',
    },
  ]

  const totalAmount = Math.abs(deltaInt) + Math.abs(avgifterDelta)

  return {
    kind: 'vacation_liability_change',
    label: isIncrease
      ? `Ökning av semesterlöneskuld (${Math.abs(deltaInt)} kr + avgifter)`
      : `Minskning av semesterlöneskuld (${Math.abs(deltaInt)} kr + avgifter)`,
    description:
      'Justering av 2920 mot 7090 plus 31,42 % sociala avgifter på 2940 mot 7519. Saldot på 2920 rullas vidare till nästa år (ingen vändning).',
    amount: totalAmount,
    lines,
    // null (not '') = no reversal. The future accrual-reversal cron will
    // filter `reverses_on IS NOT NULL` and an empty string would silently
    // match that.
    reverses_on: null,
    warnings: [],
    computation: {
      current_2920: currentLiability,
      closing_target: targetLiability,
      delta: deltaInt,
      avgifter_rate: AVGIFTER_RATE_ON_ACCRUED,
      avgifter_delta: avgifterDelta,
      employee_rows: report.rows.length,
    },
  }
}

export interface AuditFeeInput {
  /** Estimated audit fee for the fiscal year being closed. */
  amount: number
  /** Closing date — used to derive the reversal date. */
  closingDate: string
  /** Account to credit on the liability side. Defaults to 2992 (revision),
   *  use 2991 for bokslut-fee accrual. */
  liabilityAccount?: '2991' | '2992'
}

/**
 * Propose accrual of audit / bookkeeping fee that will be invoiced after
 * year-end. Standard BFL practice: accrue the cost in the period it relates
 * to, reverse on Jan 1 when the actual invoice arrives.
 */
export function proposeAuditFee(input: AuditFeeInput): AccrualProposal | null {
  const amount = Math.round(input.amount)
  if (amount <= 0) return null
  const liabilityAccount = input.liabilityAccount ?? '2992'
  const isBokslut = liabilityAccount === '2991'
  // BAS 2026: 6420 = "Revisionsarvode" (lagstadgad revision specifically).
  // Bokslutskostnader for a non-revisionspliktigt bolag belong on 6590
  // (övriga externa tjänster) — Skatteverket may query a 6420 debit
  // without a corresponding revisor i bolaget.
  const expenseAccount = isBokslut ? '6590' : '6420'

  return {
    kind: 'audit_fee',
    label: isBokslut ? 'Beräknat arvode för bokslut' : 'Beräknat arvode för revision',
    description: `Debet ${expenseAccount}, kredit ${liabilityAccount}. Vänds vid faktura nästa år.`,
    amount,
    lines: [
      {
        account_number: expenseAccount,
        debit_amount: amount,
        credit_amount: 0,
        line_description: isBokslut ? 'Beräknat bokslutarvode' : 'Beräknat revisionsarvode',
      },
      {
        account_number: liabilityAccount,
        debit_amount: 0,
        credit_amount: amount,
        line_description: isBokslut ? 'Beräknat arvode bokslut' : 'Beräknat arvode revision',
      },
    ],
    reverses_on: nextDayIso(input.closingDate),
    warnings: [],
  }
}

export interface ManualPrepaidInput {
  /** Amount of the cost that relates to NEXT year and should be reclassified
   *  to a 17xx prepaid account. */
  amount: number
  /** Cost account being relieved (e.g. 6310 företagsförsäkringar). */
  expenseAccount: string
  /** Target prepaid account (e.g. 1730 förutbetalda försäkringspremier).
   *  Must be in the 17xx interimsfordringar range. */
  prepaidAccount: string
  /** Period this prepaid covers — used in the line description. */
  description: string
  closingDate: string
}

/**
 * Manual prepaid expense reclassification. Debit 17xx, credit the expense
 * account by the portion that hasn't been consumed yet.
 *
 * The caller chooses which expense and prepaid accounts to use because
 * heuristic detection from supplier invoices isn't reliable (no service-
 * period field on the invoice model — see types/index.ts SupplierInvoice).
 * A future heuristic detector can replace this when the data model grows
 * service_period_start/_end fields.
 */
export function proposeManualPrepaid(input: ManualPrepaidInput): AccrualProposal | null {
  if (!/^17\d{2}$/.test(input.prepaidAccount)) {
    throw new Error(`prepaidAccount must be in 17xx range, got ${input.prepaidAccount}`)
  }
  const amount = Math.round(input.amount)
  if (amount <= 0) return null

  return {
    kind: 'manual_prepaid_expense',
    label: `Förutbetald kostnad: ${input.description}`,
    description: `Debet ${input.prepaidAccount}, kredit ${input.expenseAccount}. Vänds vid årsskiftet.`,
    amount,
    lines: [
      {
        account_number: input.prepaidAccount,
        debit_amount: amount,
        credit_amount: 0,
        line_description: `Förutbetald: ${input.description}`,
      },
      {
        account_number: input.expenseAccount,
        debit_amount: 0,
        credit_amount: amount,
        line_description: `Periodisering ut: ${input.description}`,
      },
    ],
    reverses_on: nextDayIso(input.closingDate),
    warnings: [],
  }
}

export interface ManualAccruedInput {
  amount: number
  /** Cost account being charged (e.g. 5010 hyra lokal). */
  expenseAccount: string
  /** Target accrued-cost account (e.g. 2990 övriga upplupna kostnader).
   *  Must be in the 29xx interimsskulder range. */
  accruedAccount: string
  description: string
  closingDate: string
}

/**
 * Manual accrued cost. Debit the expense account, credit 29xx for the
 * portion incurred but not yet invoiced. Mirrors `proposeManualPrepaid`
 * but in the opposite direction.
 */
export function proposeManualAccrued(input: ManualAccruedInput): AccrualProposal | null {
  if (!/^29\d{2}$/.test(input.accruedAccount)) {
    throw new Error(`accruedAccount must be in 29xx range, got ${input.accruedAccount}`)
  }
  const amount = Math.round(input.amount)
  if (amount <= 0) return null

  return {
    kind: 'manual_accrued_expense',
    label: `Upplupen kostnad: ${input.description}`,
    description: `Debet ${input.expenseAccount}, kredit ${input.accruedAccount}. Vänds vid årsskiftet.`,
    amount,
    lines: [
      {
        account_number: input.expenseAccount,
        debit_amount: amount,
        credit_amount: 0,
        line_description: `Periodisering in: ${input.description}`,
      },
      {
        account_number: input.accruedAccount,
        debit_amount: 0,
        credit_amount: amount,
        line_description: `Upplupen: ${input.description}`,
      },
    ],
    reverses_on: nextDayIso(input.closingDate),
    warnings: [],
  }
}

export interface RevenueDeferralInput {
  amount: number
  /** Revenue account to debit (e.g. 3000 / 3001). The full periodisering
   *  flow debits revenue and credits 2970 — opposite direction to a prepaid
   *  expense. */
  revenueAccount: string
  /** Target deferred-revenue account. Must be in the 29xx range; the wizard
   *  defaults this to 2970 specifically (förutbetalda intäkter). */
  deferredAccount: string
  description: string
  closingDate: string
}

/**
 * Propose a deferred-revenue entry. Customer has paid (or has been invoiced)
 * for a service that spans across year-end — the portion attributable to
 * NEXT year is reclassified out of revenue and into 2970. Reverses on Jan 1.
 *
 * Thin wrapper around `proposeManualAccrued` reversed direction-wise: debit
 * the revenue account, credit 2970. Built on the same engine to keep the
 * idempotency / period-lock guarantees identical.
 */
export function proposeRevenueDeferral(input: RevenueDeferralInput): AccrualProposal | null {
  if (!/^29\d{2}$/.test(input.deferredAccount)) {
    throw new Error(`deferredAccount must be in 29xx range, got ${input.deferredAccount}`)
  }
  const amount = Math.round(input.amount)
  if (amount <= 0) return null

  return {
    kind: 'deferred_revenue',
    label: `Förutbetald intäkt: ${input.description}`,
    description: `Debet ${input.revenueAccount}, kredit ${input.deferredAccount}. Vänds vid årsskiftet.`,
    amount,
    lines: [
      {
        account_number: input.revenueAccount,
        debit_amount: amount,
        credit_amount: 0,
        line_description: `Periodisering intäkt ut: ${input.description}`,
      },
      {
        account_number: input.deferredAccount,
        debit_amount: 0,
        credit_amount: amount,
        line_description: `Förutbetald intäkt: ${input.description}`,
      },
    ],
    reverses_on: nextDayIso(input.closingDate),
    warnings: [],
  }
}

export interface AccruedInterestInput {
  amount: number
  /** Interest-expense account, typically 8410 räntekostnader. */
  expenseAccount: string
  /** Accrued-interest liability, typically 2940 upplupna sociala avgifter
   *  is wrong — actual choice is the more general 2940 / 2960 family. The
   *  wizard defaults to 2960 / 2950; this helper validates 29xx. */
  accruedAccount: string
  description: string
  closingDate: string
}

/**
 * Propose accrued interest expense. Same shape as a generic accrued cost,
 * but emits a clearer label so the user can tell apart from rent/utilities
 * in the wizard's review step.
 */
export function proposeAccruedInterest(input: AccruedInterestInput): AccrualProposal | null {
  const base = proposeManualAccrued({
    amount: input.amount,
    expenseAccount: input.expenseAccount,
    accruedAccount: input.accruedAccount,
    description: input.description,
    closingDate: input.closingDate,
  })
  if (!base) return null
  return {
    ...base,
    kind: 'accrued_interest',
    label: `Upplupen ränta: ${input.description}`,
  }
}

export interface AccruedUtilityInput {
  amount: number
  /** Utility-expense account (e.g. 5020 el för kontorslokal). */
  expenseAccount: string
  /** Accrued liability, typically 2990 övriga upplupna kostnader. */
  accruedAccount: string
  description: string
  closingDate: string
}

/**
 * Propose accrued utility cost. Same shape as proposeAccruedInterest with a
 * different label — helps the wizard group similar accruals visually.
 */
export function proposeAccruedUtility(input: AccruedUtilityInput): AccrualProposal | null {
  const base = proposeManualAccrued({
    amount: input.amount,
    expenseAccount: input.expenseAccount,
    accruedAccount: input.accruedAccount,
    description: input.description,
    closingDate: input.closingDate,
  })
  if (!base) return null
  return {
    ...base,
    kind: 'accrued_utility',
    label: `Upplupen förbrukning: ${input.description}`,
  }
}

/**
 * Build a snapshot of automatically-detectable accrual proposals for the
 * wizard's preflight. Today this is just the vacation-liability delta;
 * future versions can add salary-accrued-but-unpaid, supplier-invoice-period
 * detection, etc. Manual prepaid/accrued cards are added via the UI form
 * (the API endpoint accepts them but they're not in the auto-proposal).
 */
export async function buildAccrualsProposal(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<AccrualsProposal> {
  const { data: period, error } = await supabase
    .from('fiscal_periods')
    .select('id, name, period_start, period_end')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .single()
  if (error || !period) throw new Error('Fiscal period not found')

  const proposals: AccrualProposal[] = []

  const vacation = await proposeVacationLiabilityChange(supabase, companyId, fiscalPeriodId, {
    closingDate: period.period_end,
  })
  if (vacation) proposals.push(vacation)

  return {
    fiscalPeriod: period,
    proposals,
  }
}
