/**
 * The delete refusals users actually hit (issue #2831). Each foreign key below
 * is ON DELETE RESTRICT or NO ACTION, so Postgres refuses the DELETE before
 * anything is removed, and the route hands that raw PostgREST error to
 * getErrorMessage(): the voucher DELETE route (delete_last_voucher) with
 * context 'journal_entry' and status 400, the draft payroll run DELETE route
 * with no options. Each refusal must say what the row is and what to do
 * instead, never the database's text. Same shape as
 * depreciation-voucher-delete-refusal.test.ts, which keeps its own case.
 */
import { describe, expect, it } from 'vitest'
import { getErrorMessage } from '../get-error-message'

const ROW_ID = '4bbade92-9d6c-43cd-b0ff-700d18c78a3c'

/** The error object supabase-js returns for a refused delete, verbatim shape. */
function refusal(constraint: string, parent: string, child: string) {
  return {
    code: '23503',
    message: `update or delete on table "${parent}" violates foreign key constraint "${constraint}" on table "${child}"`,
    details: `Key (id)=(${ROW_ID}) is still referenced from table "${child}".`,
    hint: null,
  }
}

const VOUCHER_ROUTE = { context: 'journal_entry', statusCode: 400 } as const

interface Case {
  constraint: string
  parent: string
  child: string
  /** How the route that meets this refusal calls the mapper. */
  options: { context?: 'journal_entry'; statusCode?: number }
  sv: string
  /** Words the English sentence must carry. */
  en: RegExp[]
}

const PAYROLL_VOUCHER_SV =
  'Verifikatet bokför en lönekörning och kan inte raderas. Använd Korrigera lönekörning (storno) på lönekörningen i stället.'

const CASES: Case[] = [
  {
    constraint: 'assets_disposal_journal_entry_id_fkey',
    parent: 'journal_entries',
    child: 'assets',
    options: VOUCHER_ROUTE,
    sv: 'Verifikatet bokför en avyttring i anläggningsregistret och kan inte raderas. Gör en rättelse (storno) i stället.',
    en: [/disposal/i, /storno/i],
  },
  {
    constraint: 'accrual_schedule_installments_journal_entry_id_fkey',
    parent: 'journal_entries',
    child: 'accrual_schedule_installments',
    options: VOUCHER_ROUTE,
    sv: 'Verifikatet löser upp en periodisering och kan inte raderas. Gör en rättelse (storno) i stället.',
    en: [/accrual/i, /storno/i],
  },
  {
    constraint: 'accrual_schedules_origin_journal_entry_id_fkey',
    parent: 'journal_entries',
    child: 'accrual_schedules',
    options: VOUCHER_ROUTE,
    sv: 'Verifikatet bokför en faktura som periodiseras och kan inte raderas. Kreditera fakturan i stället, så avbryts periodiseringen.',
    en: [/accru/i, /credit the invoice/i],
  },
  ...(['salary', 'avgifter', 'vacation', 'pension'] as const).map((kind) => ({
    constraint: `salary_runs_${kind}_entry_id_fkey`,
    parent: 'journal_entries',
    child: 'salary_runs',
    options: VOUCHER_ROUTE,
    sv: PAYROLL_VOUCHER_SV,
    en: [/payroll run/i, /storno/i],
  })),
  {
    constraint: 'salary_payment_files_salary_run_id_fkey',
    parent: 'salary_runs',
    child: 'salary_payment_files',
    options: {},
    sv: 'Lönekörningen kan inte raderas eftersom en betalfil har skapats för den, och betalfilen ska sparas i sju år. Ändra lönekörningen i stället.',
    en: [/payment file/i, /seven years/i],
  },
]

describe.each(CASES)('getErrorMessage: refused delete on $constraint', (c) => {
  const error = refusal(c.constraint, c.parent, c.child)

  it('names the register and the way out, as the route calls it', () => {
    expect(getErrorMessage(error, c.options)).toBe(c.sv)
  })

  it('does so without options too', () => {
    expect(getErrorMessage(error)).toBe(c.sv)
  })

  it('has an English message', () => {
    const en = getErrorMessage(error, { ...c.options, locale: 'en' })
    expect(en).not.toBe(c.sv)
    for (const word of c.en) expect(en).toMatch(word)
  })

  it('never leaks the raw constraint name, the tables or the row id', () => {
    for (const locale of ['sv', 'en'] as const) {
      const msg = getErrorMessage(error, { ...c.options, locale })
      expect(msg).not.toMatch(/_fkey|foreign key|violates|4bbade92/)
      expect(msg).not.toContain(c.child)
    }
  })

  it('is keyed on 23503: the same constraint name under another code does not trigger it', () => {
    expect(getErrorMessage({ ...error, code: '23505' }, c.options)).not.toBe(c.sv)
  })
})
