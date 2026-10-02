/**
 * Fix a salary run's payslip sections the first time its payslips go to
 * employees.
 *
 * The employee copy prints Arbetsgivarkostnad and Beräkningsunderlag
 * according to the company's switches (company_settings), which can change
 * at any time. A payslip is räkenskapsinformation, and BFL 7 kap. 1 § keeps
 * electronic räkenskapsinformation with the content it had when it was
 * compiled, so a payslip already handed out must not change when the switches
 * do. The first employee-facing issue of a run (the payslip email, or an
 * employee-copy download such as "Ladda ner alla lönebesked", whichever comes
 * first) therefore writes the effective sections onto the run, once, and
 * every later employee copy of that run renders from them
 * (payslipSectionsFor in build-payslip-data).
 *
 * Only a caller who may WRITE the run issues it: the snapshot is permanent,
 * and a read must never cause a permanent write. A read-only caller (a viewer
 * member, a key without payroll:write or with read-only access to the
 * company) renders the employee copy from the run as stored, its snapshot
 * when issued, else the live switches, and never calls this.
 *
 * Only a run in an issuable status is fixed: a draft or a run in review is
 * still being calculated and will be recalculated, so a copy of it is not
 * the payslip the employee is paid by. Those copies follow the live switches.
 *
 * Write-once is enforced twice: the update below only matches a run that has
 * no snapshot yet (so two concurrent first issues cannot overwrite each other;
 * the loser reads what the winner stored), and the database trigger
 * salary_runs_payslip_sections_write_once refuses any change once it is set.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  issuedPayslipSections,
  payslipSectionsFor,
  type PayslipSectionSettings,
  type PayslipSectionSnapshot,
} from '@/lib/salary/payslips/build-payslip-data'

/** Run statuses whose payslips are final and may go to employees. */
export const PAYSLIP_ISSUABLE_STATUSES = ['approved', 'paid', 'booked'] as const

export interface IssuableRun extends PayslipSectionSnapshot {
  id: string
  status: string
}

export type IssuePayslipSectionsOutcome =
  | { ok: true; snapshot: PayslipSectionSnapshot }
  | { ok: false; error: unknown }

export function isPayslipIssuableStatus(status: string): boolean {
  return (PAYSLIP_ISSUABLE_STATUSES as readonly string[]).includes(status)
}

function snapshotOf(run: PayslipSectionSnapshot): PayslipSectionSnapshot {
  return {
    payslip_sections_issued_at: run.payslip_sections_issued_at ?? null,
    payslip_show_employer_cost: run.payslip_show_employer_cost ?? null,
    payslip_show_breakdown: run.payslip_show_breakdown ?? null,
  }
}

/**
 * The columns the first issue writes: the sections the employee copy prints
 * under these switches right now.
 */
export function payslipSectionSnapshotRow(
  settings: PayslipSectionSettings | null,
  issuedAt: string,
): Required<PayslipSectionSnapshot> {
  const sections = payslipSectionsFor({ kind: 'employee', settings })
  return {
    payslip_sections_issued_at: issuedAt,
    payslip_show_employer_cost: sections.employerCost,
    payslip_show_breakdown: sections.breakdown,
  }
}

/**
 * Called on every employee-facing issue of a run's payslips, before anything
 * reaches the employee. Returns the snapshot to render from:
 *   - already issued: the stored snapshot, untouched;
 *   - not issuable (draft, review, corrected): the empty snapshot, nothing
 *     written, so the copy follows the live switches;
 *   - otherwise: writes the sections from `settings` (the caller's
 *     fail-closed read of the company's switches) and returns them.
 *
 * The caller must already have established that the requester may write the
 * run (requireWritePermission, or payroll:write on a writable company for the
 * v1 API; the token link exists only because a writer sent it), and `client`
 * is that requester's own client wherever it has one. Never call this on
 * behalf of a read-only caller, and never reach for the service role to get
 * past a read-only caller's RLS.
 */
export async function issuePayslipSections(
  client: SupabaseClient,
  params: { companyId: string; run: IssuableRun; settings: PayslipSectionSettings | null },
): Promise<IssuePayslipSectionsOutcome> {
  const { companyId, run, settings } = params

  if (issuedPayslipSections(run)) return { ok: true, snapshot: snapshotOf(run) }
  if (!isPayslipIssuableStatus(run.status)) return { ok: true, snapshot: snapshotOf({}) }

  const row = payslipSectionSnapshotRow(settings, new Date().toISOString())
  // Literal payload and select lists, so the schema guard
  // (tests/schema/no-phantom-columns.test.ts) can check every column.
  const { data: written, error: writeError } = await client
    .from('salary_runs')
    .update({
      payslip_sections_issued_at: row.payslip_sections_issued_at,
      payslip_show_employer_cost: row.payslip_show_employer_cost,
      payslip_show_breakdown: row.payslip_show_breakdown,
    })
    .eq('id', run.id)
    .eq('company_id', companyId)
    .is('payslip_sections_issued_at', null)
    .select('payslip_sections_issued_at, payslip_show_employer_cost, payslip_show_breakdown')
    .maybeSingle()
  if (writeError) return { ok: false, error: writeError }
  if (written) return { ok: true, snapshot: snapshotOf(written as PayslipSectionSnapshot) }

  // Nothing matched: another request issued the run first. Render what that
  // issue stored, never this request's switches.
  const { data: current, error: readError } = await client
    .from('salary_runs')
    .select('payslip_sections_issued_at, payslip_show_employer_cost, payslip_show_breakdown')
    .eq('id', run.id)
    .eq('company_id', companyId)
    .maybeSingle()
  if (readError) return { ok: false, error: readError }
  const stored = current as PayslipSectionSnapshot | null
  if (!stored || !issuedPayslipSections(stored)) {
    return { ok: false, error: new Error('payslip section snapshot missing after issue') }
  }
  return { ok: true, snapshot: snapshotOf(stored) }
}
