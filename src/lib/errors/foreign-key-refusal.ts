/**
 * A delete the database refused because other rows still point at the one
 * being deleted (Postgres 23503 on "update or delete on table ...", a
 * RESTRICT or NO ACTION foreign key). One definition for every reader:
 *
 *   - getErrorMessage (the dashboard): the Swedish sentence for a person.
 *   - getStructuredError (MCP tool errors) and errorResponse (v1 and the
 *     session API): a stable code an agent can branch on, an English
 *     sentence, and a remediation naming the way back (#2831).
 *
 * The other 23503, "insert or update on table ...", means the row points at
 * something that does not exist. That is not a refusal of a delete, so it is
 * not matched here and keeps its generic handling.
 *
 * Every mapped constraint is a delete a user or an agent can start and the
 * database refuses on purpose, before anything is removed. Sizing (#2831):
 * Postgres logs, 30 days to 2026-09-27, sandbox teardown excluded.
 *
 * The voucher DELETE (delete_last_voucher) on a verifikat a register still
 * points at. A posted verifikat is corrected, never deleted (BFL 5 kap. 5 §),
 * so each sentence names the register's own way back:
 *   - depreciation_schedules_journal_entry_id_fkey: planenlig avskrivning
 *     (issue #2779).
 *   - assets_disposal_journal_entry_id_fkey: avyttring or utrangering.
 *   - accrual_schedule_installments_journal_entry_id_fkey: a periodisering's
 *     monthly upplösning (7 refusals).
 *   - accrual_schedules_origin_journal_entry_id_fkey: the invoice booking a
 *     periodisering starts from. Crediting the invoice cancels the schedule
 *     and reverses its upplösningar (cancelSchedulesForSource).
 *   - salary_runs_*_entry_id_fkey: the four verifikat a booked payroll run
 *     posts (2 refusals). The run's own storno (Korrigera lönekörning,
 *     gnubok_correct_salary_run, v1 POST /salary-runs/{id}/correct)
 *     reverses all of them together.
 * The draft payroll run DELETE (dashboard and v1):
 *   - salary_payment_files_salary_run_id_fkey: a run that went back to draft
 *     after its payment file was generated. The file is räkenskapsinformation
 *     kept for seven years (migration 20260919105035), so the run stays
 *     (3 refusals).
 */
import type { StructuredErrorRemediation } from './structured-errors'

export type ForeignKeyRefusalCode =
  | 'JOURNAL_ENTRY_DELETE_BLOCKED_BY_REGISTER'
  | 'SALARY_RUN_DELETE_BLOCKED_BY_PAYMENT_FILE'
  | 'RECORD_STILL_REFERENCED'

export const FOREIGN_KEY_REFUSAL_CODES: ReadonlySet<string> = new Set<ForeignKeyRefusalCode>([
  'JOURNAL_ENTRY_DELETE_BLOCKED_BY_REGISTER',
  'SALARY_RUN_DELETE_BLOCKED_BY_PAYMENT_FILE',
  'RECORD_STILL_REFERENCED',
])

/** Which register holds a refused row, for agents that branch further. */
export type ForeignKeyRefusalRegister =
  | 'depreciation'
  | 'disposal'
  | 'accrual_release'
  | 'accrual_origin'
  | 'payroll'
  | 'payment_file'

interface MappedRefusal {
  code: Exclude<ForeignKeyRefusalCode, 'RECORD_STILL_REFERENCED'>
  register: ForeignKeyRefusalRegister
  sv: string
  en: string
  remediation: StructuredErrorRemediation
}

export interface ForeignKeyRefusal {
  code: ForeignKeyRefusalCode
  /** The table whose rows still point at the one being deleted. */
  referencedBy: string | null
  register: ForeignKeyRefusalRegister | null
  /** The sentence for a person. Null when unmapped: the caller's 23503 floor applies. */
  message_sv: string | null
  message_en: string
  remediation: StructuredErrorRemediation
}

const STORNO: StructuredErrorRemediation = {
  description:
    'A posted verifikat that a register points at is corrected, never deleted (BFL 5 kap. 5 §). Reverse it with storno (gnubok_reverse_journal_entry), or correct it inline with gnubok_correct_entry while the period is open and unlocked.',
  tool: 'gnubok_reverse_journal_entry',
}

const DEPRECIATION_VOUCHER: MappedRefusal = {
  code: 'JOURNAL_ENTRY_DELETE_BLOCKED_BY_REGISTER',
  register: 'depreciation',
  sv: 'Verifikatet bokför en avskrivning i anläggningsregistret och kan inte raderas. Gör en rättelse (storno) i stället.',
  en: 'This voucher posts a depreciation in the fixed asset register and cannot be deleted. Make a correction (storno) instead.',
  remediation: STORNO,
}
const DISPOSAL_VOUCHER: MappedRefusal = {
  code: 'JOURNAL_ENTRY_DELETE_BLOCKED_BY_REGISTER',
  register: 'disposal',
  sv: 'Verifikatet bokför en avyttring i anläggningsregistret och kan inte raderas. Gör en rättelse (storno) i stället.',
  en: 'This voucher posts a disposal in the fixed asset register and cannot be deleted. Make a correction (storno) instead.',
  remediation: STORNO,
}
const ACCRUAL_RELEASE_VOUCHER: MappedRefusal = {
  code: 'JOURNAL_ENTRY_DELETE_BLOCKED_BY_REGISTER',
  register: 'accrual_release',
  sv: 'Verifikatet löser upp en periodisering och kan inte raderas. Gör en rättelse (storno) i stället.',
  en: 'This voucher releases an accrual and cannot be deleted. Make a correction (storno) instead.',
  remediation: STORNO,
}
const ACCRUAL_ORIGIN_VOUCHER: MappedRefusal = {
  code: 'JOURNAL_ENTRY_DELETE_BLOCKED_BY_REGISTER',
  register: 'accrual_origin',
  sv: 'Verifikatet bokför en faktura som periodiseras och kan inte raderas. Kreditera fakturan i stället, så avbryts periodiseringen.',
  en: 'This voucher books an invoice that is being accrued and cannot be deleted. Credit the invoice instead, which cancels the accrual.',
  remediation: {
    description:
      'Credit the invoice this voucher books (gnubok_credit_supplier_invoice for a supplier invoice, gnubok_credit_invoice for a customer invoice). Crediting cancels the accrual schedule and reverses its posted releases.',
    tool: 'gnubok_credit_supplier_invoice',
  },
}
const PAYROLL_VOUCHER: MappedRefusal = {
  code: 'JOURNAL_ENTRY_DELETE_BLOCKED_BY_REGISTER',
  register: 'payroll',
  sv: 'Verifikatet bokför en lönekörning och kan inte raderas. Använd Korrigera lönekörning (storno) på lönekörningen i stället.',
  en: 'This voucher posts a payroll run and cannot be deleted. Use Correct payroll run (storno) on the payroll run instead.',
  remediation: {
    description:
      "Correct the payroll run as a whole: gnubok_correct_salary_run, or POST /api/v1/companies/{companyId}/salary-runs/{id}/correct (Korrigera lönekörning in the dashboard), reverses all of the run's verifikat together. Do not reverse one of them on its own.",
    tool: 'gnubok_correct_salary_run',
  },
}
const PAYROLL_RUN_WITH_PAYMENT_FILE: MappedRefusal = {
  code: 'SALARY_RUN_DELETE_BLOCKED_BY_PAYMENT_FILE',
  register: 'payment_file',
  sv: 'Lönekörningen kan inte raderas eftersom en betalfil har skapats för den, och betalfilen ska sparas i sju år. Ändra lönekörningen i stället.',
  en: 'This payroll run cannot be deleted because a payment file was generated for it, and that file must be kept for seven years. Edit the payroll run instead.',
  remediation: {
    description:
      'A generated payment file is kept for seven years, so the run it belongs to stays. Edit the draft run instead (gnubok_set_run_salary, gnubok_update_salary_run), or leave it unbooked.',
    tool: 'gnubok_update_salary_run',
  },
}

const MAPPED_REFUSALS: Record<string, MappedRefusal> = {
  depreciation_schedules_journal_entry_id_fkey: DEPRECIATION_VOUCHER,
  assets_disposal_journal_entry_id_fkey: DISPOSAL_VOUCHER,
  accrual_schedule_installments_journal_entry_id_fkey: ACCRUAL_RELEASE_VOUCHER,
  accrual_schedules_origin_journal_entry_id_fkey: ACCRUAL_ORIGIN_VOUCHER,
  salary_runs_salary_entry_id_fkey: PAYROLL_VOUCHER,
  salary_runs_avgifter_entry_id_fkey: PAYROLL_VOUCHER,
  salary_runs_vacation_entry_id_fkey: PAYROLL_VOUCHER,
  salary_runs_pension_entry_id_fkey: PAYROLL_VOUCHER,
  salary_payment_files_salary_run_id_fkey: PAYROLL_RUN_WITH_PAYMENT_FILE,
}

const STILL_REFERENCED_REMEDIATION: StructuredErrorRemediation = {
  description:
    'Other records still point at this one; details.referenced_by names their table. Remove or re-point those records first, or keep this one (archive or deactivate it where the resource supports that). Retrying the same delete will not help.',
}

const REFUSED_DELETE_RE = /^update or delete on table "[^"]+" violates foreign key constraint "([^"]+)" on table "([^"]+)"/

/** The { code, message } pair a Postgres error carries, directly or nested. */
function databaseError(err: unknown): { code: string; message: string } | null {
  if (typeof err !== 'object' || err === null) return null
  const obj = err as Record<string, unknown>
  if (typeof obj.code === 'string' && typeof obj.message === 'string') {
    return { code: obj.code, message: obj.message }
  }
  if (typeof obj.error === 'object' && obj.error !== null) {
    const inner = obj.error as Record<string, unknown>
    if (typeof inner.code === 'string' && typeof inner.message === 'string') {
      return { code: inner.code, message: inner.message }
    }
  }
  return null
}

/**
 * The refusal a database error describes, or null when it is not a refused
 * delete. Accepts the error as supabase-js returns it or nested under
 * `error`.
 */
export function foreignKeyRefusal(err: unknown): ForeignKeyRefusal | null {
  const db = databaseError(err)
  if (!db || db.code !== '23503') return null
  const match = REFUSED_DELETE_RE.exec(db.message.trim())
  if (!match) return null
  const [, constraint, referencedBy] = match
  const mapped = MAPPED_REFUSALS[constraint]
  if (mapped) {
    return {
      code: mapped.code,
      referencedBy,
      register: mapped.register,
      message_sv: mapped.sv,
      message_en: mapped.en,
      remediation: mapped.remediation,
    }
  }
  return {
    code: 'RECORD_STILL_REFERENCED',
    referencedBy,
    register: null,
    message_sv: null,
    message_en: `This record cannot be deleted because other records still refer to it (table ${referencedBy}).`,
    remediation: STILL_REFERENCED_REMEDIATION,
  }
}
