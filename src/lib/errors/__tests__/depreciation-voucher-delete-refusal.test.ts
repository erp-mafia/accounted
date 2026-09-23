/**
 * A depreciation voucher cannot be deleted through delete_last_voucher: the
 * foreign key depreciation_schedules.journal_entry_id is ON DELETE RESTRICT,
 * so Postgres refuses at the DELETE, before anything is removed (pinned in
 * tests/pg/asset-depreciation-atomic.pg.test.ts). The voucher DELETE route
 * hands that raw PostgREST error to getErrorMessage(); this pins that the user
 * is told what the voucher is and what to do, not the generic 23503 text.
 */
import { describe, expect, it } from 'vitest'
import { getErrorMessage } from '../get-error-message'

/** The error object supabase-js returns for the refused delete, verbatim shape. */
const REFUSAL = {
  code: '23503',
  message:
    'update or delete on table "journal_entries" violates foreign key constraint "depreciation_schedules_journal_entry_id_fkey" on table "depreciation_schedules"',
  details: 'Key (id)=(4bbade92-9d6c-43cd-b0ff-700d18c78a3c) is still referenced from table "depreciation_schedules".',
  hint: null,
}

const SV =
  'Verifikatet bokför en avskrivning i anläggningsregistret och kan inte raderas. Gör en rättelse (storno) i stället.'

describe('getErrorMessage: deleting a depreciation voucher', () => {
  it('names the register and the way out, as the voucher DELETE route calls it', () => {
    expect(getErrorMessage(REFUSAL, { context: 'journal_entry', statusCode: 400 })).toBe(SV)
  })

  it('does so without a context too', () => {
    expect(getErrorMessage(REFUSAL)).toBe(SV)
  })

  it('has an English message', () => {
    const en = getErrorMessage(REFUSAL, { context: 'journal_entry', locale: 'en' })
    expect(en).toMatch(/depreciation/i)
    expect(en).toMatch(/storno/i)
  })

  it('is keyed on this one constraint: another foreign key refusal is handled exactly as before', () => {
    const other = {
      ...REFUSAL,
      message:
        'update or delete on table "journal_entries" violates foreign key constraint "salary_runs_salary_entry_id_fkey" on table "salary_runs"',
      details: 'Key (id)=(x) is still referenced from table "salary_runs".',
    }
    const msg = getErrorMessage(other, { context: 'journal_entry', statusCode: 400 })
    expect(msg).not.toBe(SV)
    // Deliberately unchanged by this fix (scope): whatever the mapper did for
    // other constraints before, it still does.
    expect(msg).toBe(other.message)
  })

  it('is keyed on 23503: the constraint name in some other error does not trigger it', () => {
    const msg = getErrorMessage({ ...REFUSAL, code: '23505' }, { context: 'journal_entry' })
    expect(msg).not.toBe(SV)
  })

  it('never leaks the raw constraint name or a row id to the user', () => {
    const msg = getErrorMessage(REFUSAL, { context: 'journal_entry', statusCode: 400 })
    expect(msg).not.toMatch(/_fkey|foreign key|4bbade92/)
  })
})
