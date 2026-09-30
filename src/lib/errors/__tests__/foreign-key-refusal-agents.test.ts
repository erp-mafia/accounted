/**
 * A refused delete, as an agent sees it (#2831).
 *
 * Before: over MCP an agent got UNKNOWN_ERROR with the raw Postgres sentence,
 * and over v1 a generic 400 VALIDATION_ERROR, whichever register held the
 * row. Now both doors return a code to branch on, English it can act on and
 * a remediation naming the way back; the person in the dashboard keeps the
 * Swedish sentence.
 */
import { describe, expect, it, vi } from 'vitest'
import { foreignKeyRefusal } from '../foreign-key-refusal'
import { errorResponse, getStructuredError } from '../get-structured-error'
import { getErrorMessage } from '../get-error-message'

function refusedDelete(parent: string, constraint: string, child: string) {
  return {
    code: '23503',
    message: `update or delete on table "${parent}" violates foreign key constraint "${constraint}" on table "${child}"`,
    details: `Key (id)=(7d0c2c1e-5b1a-4a0e-9c2e-2f6a1b3c4d5e) is still referenced from table "${child}".`,
    hint: null,
  }
}

const PAYROLL_VOUCHER = refusedDelete('journal_entries', 'salary_runs_salary_entry_id_fkey', 'salary_runs')
const ACCRUAL_ORIGIN = refusedDelete(
  'journal_entries',
  'accrual_schedules_origin_journal_entry_id_fkey',
  'accrual_schedules',
)
const PAYMENT_FILE = refusedDelete('salary_runs', 'salary_payment_files_salary_run_id_fkey', 'salary_payment_files')
const UNMAPPED = refusedDelete('customers', 'recurring_invoice_schedules_customer_id_fkey', 'recurring_invoice_schedules')
const MISSING_PARENT = {
  code: '23503',
  message:
    'insert or update on table "salary_payment_files" violates foreign key constraint "salary_payment_files_salary_run_id_fkey"',
  details: 'Key (salary_run_id)=(00000000-0000-4000-8000-000000000000) is not present in table "salary_runs".',
  hint: null,
}

const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } as never

describe('foreignKeyRefusal', () => {
  it('resolves a mapped constraint to its code, register and referencing table', () => {
    expect(foreignKeyRefusal(PAYROLL_VOUCHER)).toMatchObject({
      code: 'JOURNAL_ENTRY_DELETE_BLOCKED_BY_REGISTER',
      register: 'payroll',
      referencedBy: 'salary_runs',
    })
    expect(foreignKeyRefusal(PAYMENT_FILE)).toMatchObject({
      code: 'SALARY_RUN_DELETE_BLOCKED_BY_PAYMENT_FILE',
      register: 'payment_file',
      referencedBy: 'salary_payment_files',
    })
  })

  it('gives an unmapped refused delete the general code and names the referencing table', () => {
    expect(foreignKeyRefusal(UNMAPPED)).toMatchObject({
      code: 'RECORD_STILL_REFERENCED',
      register: null,
      referencedBy: 'recurring_invoice_schedules',
      message_sv: null,
    })
  })

  it('reads the error nested under error, the way some callers forward it', () => {
    expect(foreignKeyRefusal({ error: PAYMENT_FILE })?.code).toBe('SALARY_RUN_DELETE_BLOCKED_BY_PAYMENT_FILE')
  })

  it('leaves an insert that points at a missing row alone: that is not a refused delete', () => {
    expect(foreignKeyRefusal(MISSING_PARENT)).toBeNull()
  })

  it('leaves every other database error alone', () => {
    expect(foreignKeyRefusal({ code: '23505', message: 'duplicate key value violates unique constraint "x_pkey"' })).toBeNull()
    expect(foreignKeyRefusal(new Error('boom'))).toBeNull()
    expect(foreignKeyRefusal(null)).toBeNull()
  })
})

describe('MCP tool errors (getStructuredError)', () => {
  it('a payroll voucher: its code, English an agent can act on, the Swedish sentence, never retryable', () => {
    const structured = getStructuredError(PAYROLL_VOUCHER)
    expect(structured.code).toBe('JOURNAL_ENTRY_DELETE_BLOCKED_BY_REGISTER')
    expect(structured.message_en).toBe(
      'This voucher posts a payroll run and cannot be deleted. Use Correct payroll run (storno) on the payroll run instead.',
    )
    expect(structured.message_sv).toBe(
      'Verifikatet bokför en lönekörning och kan inte raderas. Använd Korrigera lönekörning (storno) på lönekörningen i stället.',
    )
    expect(structured.remediation?.description).toMatch(/salary-runs\/\{id\}\/correct/)
    expect(structured.remediation?.tool).toBe('gnubok_correct_salary_run')
    expect(structured.retryable).toBe(false)
  })

  it('an accrual origin names the credit tools instead of storno', () => {
    const structured = getStructuredError(ACCRUAL_ORIGIN)
    expect(structured.code).toBe('JOURNAL_ENTRY_DELETE_BLOCKED_BY_REGISTER')
    expect(structured.remediation?.tool).toBe('gnubok_credit_supplier_invoice')
    expect(structured.remediation?.description).toMatch(/gnubok_credit_invoice/)
  })

  it('a payment file points at editing the draft run', () => {
    const structured = getStructuredError(PAYMENT_FILE)
    expect(structured.code).toBe('SALARY_RUN_DELETE_BLOCKED_BY_PAYMENT_FILE')
    expect(structured.remediation?.tool).toBe('gnubok_update_salary_run')
    expect(structured.retryable).toBe(false)
  })

  it('an unmapped refusal: the general code, the table in English, the Swedish floor, no raw Postgres text', () => {
    const structured = getStructuredError(UNMAPPED)
    expect(structured.code).toBe('RECORD_STILL_REFERENCED')
    expect(structured.message_en).toContain('recurring_invoice_schedules')
    expect(structured.message_en).not.toMatch(/violates foreign key constraint/)
    expect(structured.message_sv).toBe('Posten kan inte ändras eftersom den refereras av annan data.')
    expect(structured.retryable).toBe(false)
  })

  it('a missing-parent insert keeps its previous handling', () => {
    expect(getStructuredError(MISSING_PARENT).code).not.toBe('RECORD_STILL_REFERENCED')
  })
})

describe('v1 and session API errors (errorResponse)', () => {
  it('a mapped refusal is a 409 with its code, both sentences, the remediation and what holds the row', async () => {
    const res = errorResponse(PAYROLL_VOUCHER, log, { requestId: 'req-1' })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toMatchObject({
      code: 'JOURNAL_ENTRY_DELETE_BLOCKED_BY_REGISTER',
      message:
        'Verifikatet bokför en lönekörning och kan inte raderas. Använd Korrigera lönekörning (storno) på lönekörningen i stället.',
      message_en:
        'This voucher posts a payroll run and cannot be deleted. Use Correct payroll run (storno) on the payroll run instead.',
      details: { pgCode: '23503', referenced_by: 'salary_runs', register: 'payroll' },
    })
    expect(body.error.remediation.description).toMatch(/Do not reverse one of them on its own/)
  })

  it('an unmapped refusal is a 409 RECORD_STILL_REFERENCED instead of a generic 400', async () => {
    const res = errorResponse(UNMAPPED, log)
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('RECORD_STILL_REFERENCED')
    expect(body.error.details).toMatchObject({ referenced_by: 'recurring_invoice_schedules' })
    expect(JSON.stringify(body)).not.toMatch(/violates foreign key constraint/)
  })

  it('other database errors keep their mapping (a duplicate stays a 400 VALIDATION_ERROR)', async () => {
    const res = errorResponse({ code: '23505', message: 'duplicate key value violates unique constraint "x_pkey"' }, log)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
  })

  it('the dashboard shows the envelope its own sentence, in either language', async () => {
    const body = await errorResponse(ACCRUAL_ORIGIN, log).json()
    expect(getErrorMessage(body)).toBe(
      'Verifikatet bokför en faktura som periodiseras och kan inte raderas. Kreditera fakturan i stället, så avbryts periodiseringen.',
    )
    expect(getErrorMessage(body, { locale: 'en' })).toBe(
      'This voucher books an invoice that is being accrued and cannot be deleted. Credit the invoice instead, which cancels the accrual.',
    )
  })
})
