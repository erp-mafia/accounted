/**
 * What a salary run pays out to each employee: the payable amount. One rule,
 * used by every path that moves the net pay (the bank payments of
 * pay-via-bank.ts, the pain.001 and Bankgirot LB files and their bank list
 * in build-payment-file.ts) and mirrored by the database function
 * salary_run_payable_amounts (migration 20261027213117), which
 * create_salary_payment_orders and the run's paid-by-bank step read.
 *
 * An ordinary run pays the effective net (effectiveNetPayout, rounded to
 * öre), exactly the figure every path wrote before this module.
 *
 * A correction run (rättelsekörning, correct-run.ts) carries the corrected
 * run's roster and line items at FULL amounts: right for the payslip and the
 * booking (the storno debits back the original's bank credit and the
 * correction credits the full corrected net, so the bank account nets to the
 * difference), wrong for the money. A correction is only made of a booked
 * run, whose net pay has left, so the correction pays each employee only the
 * difference between the corrected effective net and what the chain of runs
 * it replaces already paid that employee:
 *
 *   paidBefore(e) = max(0, effective net of e on each earlier run of the chain)
 *   payable(e)    = effective net of e on the correction - paidBefore(e)
 *
 * The chain is the corrected run, the run that one corrected, and so on up
 * to the first ordinary run. Why the maximum over the chain and not just the
 * corrected run's net: an earlier correction that lowered an employee's net
 * paid nothing back (an overpayment is never paid or deducted here), so the
 * employee still holds the higher amount; the maximum is what reached them,
 * assuming nothing was paid back. When no correction in the chain lowered
 * the net, the maximum is the corrected run's own net. An employee new on
 * the correction has paidBefore 0 and gets the full net.
 *
 * A positive payable is paid. Zero is not paid. A negative payable is an
 * overpayment: never paid and never deducted automatically; the employee is
 * left out and the preview names the amount so the person handles it. An
 * employee on the chain but no longer on the correction is overpaid by
 * everything paid before.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { effectiveNetPayout, type EffectiveNetInput } from './effective-net'

/** A run's link to the run it corrects (salary_runs.corrects_run_id). */
export interface PayableRunRef {
  id: string
  corrects_run_id?: string | null
}

/** What the chain of runs a correction replaces paid one employee. */
export interface PaidBeforeEntry {
  amount: number
  /** The employee's name as the chain's roster names it, for an employee no longer on the correction. */
  name: string
}

/** The chain a correction replaces, read once per payment path. Null for an ordinary run. */
export interface CorrectionPaidBefore {
  /** The run the correction corrects. */
  correctsRunId: string
  /** Every run of the chain, the corrected run first. */
  chainRunIds: string[]
  byEmployee: Map<string, PaidBeforeEntry>
}

/** An employee a correction overpaid: left out of the payment, named so the person handles it. */
export interface OverpaidEmployee {
  employee_id: string
  name: string
  /** Positive: how much more the chain paid than the corrected net. */
  amount: number
}

/** Corrections of corrections deeper than this are refused as a broken chain rather than walked forever. */
const MAX_CHAIN_DEPTH = 50

/** The effective net rounded to öre: what an ordinary run pays. */
export function effectiveNetOre(row: EffectiveNetInput): number {
  return roundOre(effectiveNetPayout(row))
}

/**
 * The amount a run pays one employee before the "> 0" filter every payment
 * path applies. An ordinary run (paidBefore null): the effective net. A
 * correction: the effective net minus what the chain already paid, negative
 * when the employee was overpaid.
 */
export function payableAmount(row: EffectiveNetInput, employeeId: string, paidBefore: CorrectionPaidBefore | null): number {
  const net = effectiveNetOre(row)
  if (!paidBefore) return net
  return roundOre(net - (paidBefore.byEmployee.get(employeeId)?.amount ?? 0))
}

/**
 * What the chain paid each employee: the largest effective net (never below
 * 0) on any of its runs. Pure, so the rule is tested without a database.
 */
export function paidBeforeFromChain(
  rows: ReadonlyArray<EffectiveNetInput & { employee_id: string; name: string }>,
): Map<string, PaidBeforeEntry> {
  const byEmployee = new Map<string, PaidBeforeEntry>()
  for (const row of rows) {
    const net = Math.max(0, effectiveNetOre(row))
    const current = byEmployee.get(row.employee_id)
    if (!current || net > current.amount) byEmployee.set(row.employee_id, { amount: net, name: row.name || current?.name || '' })
  }
  return byEmployee
}

/**
 * The employees a correction overpaid, by name: those on the run whose
 * payable is negative, and those the chain paid who are no longer on the
 * run. Sorted by name. Empty for an ordinary run.
 */
export function overpaidEmployees(
  rows: ReadonlyArray<EffectiveNetInput & { employee_id: string; name: string }>,
  paidBefore: CorrectionPaidBefore | null,
): OverpaidEmployee[] {
  if (!paidBefore) return []
  const onRun = new Set(rows.map((row) => row.employee_id))
  const overpaid: OverpaidEmployee[] = []
  for (const row of rows) {
    const payable = payableAmount(row, row.employee_id, paidBefore)
    if (payable < 0) overpaid.push({ employee_id: row.employee_id, name: row.name, amount: roundOre(-payable) })
  }
  for (const [employeeId, entry] of paidBefore.byEmployee) {
    if (!onRun.has(employeeId) && entry.amount > 0) {
      overpaid.push({ employee_id: employeeId, name: entry.name, amount: entry.amount })
    }
  }
  return overpaid.sort((a, b) => a.name.localeCompare(b.name, 'sv') || a.employee_id.localeCompare(b.employee_id))
}

interface ChainEmployeeRow {
  id: string
  employee_id: string
  net_salary: number | string
  tax_withheld: number | string
  tax_withheld_override: number | string | null
  employee: { first_name: string | null; last_name: string | null } | null
}

export type LoadPaidBeforeResult = { ok: true; paidBefore: CorrectionPaidBefore | null } | { ok: false; error: unknown }

/**
 * Reads what the chain a correction run replaces already paid. An ordinary
 * run (no corrects_run_id) answers null without a query, so its payment
 * paths read exactly what they read before. Every query filters by
 * company_id (the v1 and MCP doors run on a service-role client).
 */
export async function loadCorrectionPaidBefore(
  supabase: SupabaseClient,
  companyId: string,
  run: PayableRunRef,
): Promise<LoadPaidBeforeResult> {
  const correctsRunId = run.corrects_run_id ?? null
  if (!correctsRunId) return { ok: true, paidBefore: null }

  const chainRunIds: string[] = []
  let next: string | null = correctsRunId
  while (next) {
    if (chainRunIds.includes(next) || next === run.id || chainRunIds.length >= MAX_CHAIN_DEPTH) {
      return { ok: false, error: new Error(`salary run ${run.id}: the chain of corrected runs does not end`) }
    }
    const current: string = next
    const { data, error } = await supabase
      .from('salary_runs')
      .select('id, corrects_run_id')
      .eq('id', current)
      .eq('company_id', companyId)
      .maybeSingle()
    if (error) return { ok: false, error }
    // A corrected run that cannot be read is no reason to pay the full net:
    // refuse rather than guess.
    if (!data) return { ok: false, error: new Error(`salary run ${run.id}: corrected run ${current} not found`) }
    chainRunIds.push(current)
    next = (data as { corrects_run_id: string | null }).corrects_run_id ?? null
  }

  let rows: ChainEmployeeRow[]
  try {
    rows = await fetchAllRows<ChainEmployeeRow>((range) =>
      supabase
        .from('salary_run_employees')
        .select('id, employee_id, net_salary, tax_withheld, tax_withheld_override, employee:employees(first_name, last_name)')
        .in('salary_run_id', chainRunIds)
        .eq('company_id', companyId)
        .order('id')
        .range(range.from, range.to) as unknown as PromiseLike<{ data: ChainEmployeeRow[] | null; error: { message: string } | null }>,
    )
  } catch (error) {
    return { ok: false, error }
  }

  const byEmployee = paidBeforeFromChain(
    rows.map((row) => ({
      employee_id: row.employee_id,
      net_salary: Number(row.net_salary),
      tax_withheld: Number(row.tax_withheld),
      tax_withheld_override: row.tax_withheld_override === null ? null : Number(row.tax_withheld_override),
      name: `${row.employee?.first_name ?? ''} ${row.employee?.last_name ?? ''}`.trim(),
    })),
  )
  return { ok: true, paidBefore: { correctsRunId, chainRunIds, byEmployee } }
}

/** A correction that raises nobody's net: nothing for a payment to pay. */
export const CORRECTION_NOTHING_TO_PAY_SV = 'Rättelsen ger ingen skillnad att betala ut jämfört med den tidigare körningen.'

/** The muted line a correction's payment shows (dialog, file panel): Swedish for the file warnings. */
export const CORRECTION_DIFFERENCE_ONLY_SV = 'Rättelse: endast skillnaden mot den tidigare körningen betalas ut.'

/**
 * The one Swedish sentence naming every overpaid employee and amount, for
 * the payment file warnings (v1, MCP). It makes no claim about deducting the
 * amount from a later salary: that is the person's to handle.
 */
export function overpaidSentenceSv(overpaid: ReadonlyArray<OverpaidEmployee>, formatAmount: (amount: number) => string): string | null {
  if (overpaid.length === 0) return null
  const list = overpaid.map((o) => `${o.name || o.employee_id} (${formatAmount(o.amount)})`).join(', ')
  return `Enligt rättelsen har ${list} fått för mycket utbetalt; det ingår inte i betalningen och dras inte av automatiskt, så hantera det separat.`
}
