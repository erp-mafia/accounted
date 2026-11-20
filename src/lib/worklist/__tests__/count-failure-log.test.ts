import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'

/**
 * How a worklist count that could not be read is logged. A failed read never
 * errors Hem (the count answers zero or an empty list); the log line must say
 * what failed. On 2026-10-29 the attest-due row logged "[object Object]" for
 * 46 minutes: the attest policy read threw PostgREST's plain error object
 * (column two_step_from_sek not migrated yet) and the catch ran String() on it.
 */

const { logError, logWarn } = vi.hoisted(() => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logger')>()
  return {
    ...actual,
    createLogger: (module: string, base?: Parameters<typeof actual.createLogger>[1]) => ({
      ...actual.createLogger(module, base),
      warn: logWarn,
      error: logError,
    }),
  }
})

import { countHeldDocuments, listSupplierInvoiceAttestsDue } from '../categories'

const POLICY = { company_id: 'c1', enabled: true, threshold_amount: 1000, mode: 'all', attesters: ['anna'], preparer_may_attest: false, updated_by: null, updated_at: null }

function attestDb(policyResult: { data?: unknown; error?: unknown }) {
  return createTableMockSupabase({
    company_attest_policies: policyResult as never,
    company_settings: { data: { accounting_method: 'accrual' } },
    company_members: { data: [{ user_id: 'anna', role: 'member' }] },
    supplier_invoices: { data: [] },
  })
}

const listAttests = (mock: ReturnType<typeof attestDb>) => listSupplierInvoiceAttestsDue(mock.supabase as unknown as SupabaseClient, 'c1', 'anna')

describe('worklist count failure logging', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('logs the PostgREST message and code of a thrown error object, not "[object Object]"', async () => {
    const rows = await listAttests(attestDb({ data: null, error: { message: 'canceling statement due to statement timeout', code: '57014', details: null, hint: null } }))

    expect(rows).toEqual([])
    expect(logError).toHaveBeenCalledWith('worklist count failed: supplier_invoice_attest_due', {
      companyId: 'c1',
      reason: 'canceling statement due to statement timeout',
      code: '57014',
    })
    expect(JSON.stringify(logError.mock.calls)).not.toContain('[object Object]')
  })

  it('a column the code reads before its migration has run is a warning, and the row list is empty', async () => {
    const rows = await listAttests(
      attestDb({ data: null, error: { message: 'column company_attest_policies.two_step_from_sek does not exist', code: '42703', details: null, hint: null } }),
    )

    expect(rows).toEqual([])
    expect(logError).not.toHaveBeenCalled()
    expect(logWarn).toHaveBeenCalledWith('worklist count skipped, schema not migrated yet: supplier_invoice_attest_due', {
      companyId: 'c1',
      reason: 'column company_attest_policies.two_step_from_sek does not exist',
      code: '42703',
    })
  })

  it.each([
    ['PGRST204', "Could not find the 'x' column of 'document_attachments' in the schema cache"],
    ['PGRST205', "Could not find the table 'public.document_attachments' in the schema cache"],
    ['42P01', 'relation "document_attachments" does not exist'],
  ])('a count on a column or table not there yet (%s) answers zero with a warning', async (code, message) => {
    const mock = createTableMockSupabase({ document_attachments: { data: null, count: null, error: { message, code } as never } })

    const count = await countHeldDocuments(mock.supabase as unknown as SupabaseClient, 'c1')

    expect(count).toBe(0)
    expect(logError).not.toHaveBeenCalled()
    expect(logWarn).toHaveBeenCalledWith('worklist count skipped, schema not migrated yet: document_relevance', { companyId: 'c1', reason: message, code })
  })

  it('any other failed count is still an error with its message and code', async () => {
    const mock = createTableMockSupabase({ document_attachments: { data: null, count: null, error: { message: 'permission denied for table document_attachments', code: '42501' } as never } })

    expect(await countHeldDocuments(mock.supabase as unknown as SupabaseClient, 'c1')).toBe(0)
    expect(logWarn).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledWith('worklist count failed: document_relevance', {
      companyId: 'c1',
      reason: 'permission denied for table document_attachments',
      code: '42501',
    })
  })

  it('reads normally when nothing fails: no log line', async () => {
    const rows = await listAttests(attestDb({ data: POLICY }))

    expect(rows).toEqual([])
    expect(logError).not.toHaveBeenCalled()
    expect(logWarn).not.toHaveBeenCalled()
  })
})
