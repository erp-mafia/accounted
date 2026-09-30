/**
 * Refusals as the agent receives them, through the one dispatch point
 * (toToolError → getStructuredError): a stable code and an explicit
 * retryable, not UNKNOWN_ERROR.
 *
 * Production, 2026-09-23..28: MCP calls from dozens of companies came back as
 * UNKNOWN_ERROR, "Något gick fel. Försök igen.", for failures the agent could
 * only fix by changing its call (an ambiguous voucher ref, a closed period, an
 * unknown group_by, a missing document id). "Try again" was the wrong advice
 * for every one of them. Each case below is a site that threw a plain Error.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const mockValidateInvoiceLink = vi.fn()
vi.mock('@/lib/invoices/voucher-matching', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices/voucher-matching')>()),
  validateVoucherForInvoiceLink: (...a: unknown[]) => mockValidateInvoiceLink(...a),
}))

import { tools } from '../server'
import { toToolError } from '../tool-result'
import { getErrorEntry } from '@/lib/errors/structured-errors'

const tool = (name: string) => {
  const found = tools.find((t) => t.name === name)
  if (!found) throw new Error(`missing tool ${name}`)
  return found
}

/** Run a tool that must refuse, and return the envelope the agent receives. */
async function refusal(name: string, args: Record<string, unknown>, supabase: unknown) {
  let thrown: unknown
  try {
    await tool(name).execute(args, 'company-1', 'user-1', supabase as never, { type: 'api_key' })
  } catch (err) {
    thrown = err
  }
  expect(thrown, `${name} should have refused`).toBeDefined()
  return toToolError(thrown, { toolName: name }).error
}

const OP_ID = '0e5f0000-0000-4000-8000-000000000001'
const DOC_ID = '0d0c0000-0000-4000-8000-000000000002'
const JE_ID = '0a0e0000-0000-4000-8000-000000000003'
const NO_ROW = { code: 'PGRST116', message: 'Cannot coerce the result to a single JSON object', details: 'The result contains 0 rows' }
const TIMEOUT = { code: '57014', message: 'canceling statement due to statement timeout' }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('generated operation tools (parseOrThrow)', () => {
  it('a read tool names the missing argument: VALIDATION_ERROR with a Swedish reason', async () => {
    const from = vi.fn()
    const error = await refusal('gnubok_get_behandlingshistorik', {}, { from })

    expect(error).toMatchObject({ code: 'VALIDATION_ERROR', retryable: false, message_sv: 'period_id: Obligatoriskt fält saknas.' })
    expect(error.message_en).toMatch(/^Invalid arguments: period_id: /)
    expect(from).not.toHaveBeenCalled()
  })

  it('a staged write names every field at fault before any database work', async () => {
    const from = vi.fn()
    const error = await refusal('gnubok_create_dimension', { sie_dim_no: 'x' }, { from, rpc: vi.fn() })

    expect(error.code).toBe('VALIDATION_ERROR')
    expect(error.message_sv).toBe('name: Obligatoriskt fält saknas. sie_dim_no: Fel typ: ska vara ett tal.')
    expect(from).not.toHaveBeenCalled()
  })
})

describe('NOT_FOUND and CONFLICT: pending operations', () => {
  it('reject: an operation that does not exist is NOT_FOUND, naming the id', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: NO_ROW })
    const error = await refusal('gnubok_reject_pending_operation', { operation_id: OP_ID }, supabase)

    expect(error).toMatchObject({ code: 'NOT_FOUND', retryable: false })
    expect(error.message_en).toContain(OP_ID)
  })

  it('reject: a malformed id is a miss as well', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { code: '22P02', message: 'invalid input syntax for type uuid: "op-1"' } })
    expect((await refusal('gnubok_reject_pending_operation', { operation_id: 'op-1' }, supabase)).code).toBe('NOT_FOUND')
  })

  it('reject: a statement timeout stays transient instead of reading as a wrong id', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: TIMEOUT })
    expect(await refusal('gnubok_reject_pending_operation', { operation_id: OP_ID }, supabase)).toMatchObject({
      code: 'TRANSIENT_ERROR',
      retryable: true,
    })
  })

  it('approve: an operation that does not exist is NOT_FOUND too', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: NO_ROW })
    expect((await refusal('gnubok_approve_pending_operation', { operation_id: OP_ID }, supabase)).code).toBe('NOT_FOUND')
  })

  it('reject: an operation already rejected is CONFLICT (REST answers 409), not retryable', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: OP_ID, status: 'rejected', operation_type: 'create_voucher', risk_level: 'medium' } })
    expect(await refusal('gnubok_reject_pending_operation', { operation_id: OP_ID }, supabase)).toMatchObject({
      code: 'CONFLICT',
      retryable: false,
      message_en: 'Operation already rejected.',
    })
  })

  it('reject: losing the claim to a parallel approval is CONFLICT as well', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: OP_ID, status: 'pending', operation_type: 'create_voucher', risk_level: 'medium' } })
    enqueue({ data: [] }) // CAS update: 0 rows
    expect((await refusal('gnubok_reject_pending_operation', { operation_id: OP_ID }, supabase)).code).toBe('CONFLICT')
  })
})

describe('NOT_FOUND: documents and verifikat', () => {
  it('get_document_content: an unknown id is NOT_FOUND naming it', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    const error = await refusal('gnubok_get_document_content', { document_id: DOC_ID }, supabase)

    expect(error).toMatchObject({ code: 'NOT_FOUND', retryable: false })
    expect(error.message_en).toContain(DOC_ID)
  })

  it('get_document_content: a file name sent as the id (22P02) is NOT_FOUND, not a database error', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { code: '22P02', message: 'invalid input syntax for type uuid: "scan-2026.pdf"' } })
    const error = await refusal('gnubok_get_document_content', { document_id: 'scan-2026.pdf' }, supabase)

    expect(error.code).toBe('NOT_FOUND')
    expect(error.message_en).toContain('scan-2026.pdf')
  })

  it('link_document_to_voucher: a missing verifikat is NOT_FOUND', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: DOC_ID, file_name: 'kvitto.pdf', mime_type: 'application/pdf', journal_entry_id: null } })
    enqueue({ data: null })
    const error = await refusal('gnubok_link_document_to_voucher', { document_id: DOC_ID, journal_entry_id: JE_ID }, supabase)

    expect(error.code).toBe('NOT_FOUND')
    expect(error.message_en).toMatch(/^Journal entry not found/)
  })

  it('link_document_to_voucher: a database error on the document lookup stays one', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: TIMEOUT })
    enqueue({ data: null })
    expect(await refusal('gnubok_link_document_to_voucher', { document_id: DOC_ID, journal_entry_id: JE_ID }, supabase)).toMatchObject({
      code: 'TRANSIENT_ERROR',
      retryable: true,
    })
  })

  it('reverse_journal_entry: a voucher ref with no entry is NOT_FOUND', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [] })
    const error = await refusal('gnubok_reverse_journal_entry', { entry_id: 'A-999' }, supabase)

    expect(error).toMatchObject({ code: 'NOT_FOUND', retryable: false })
    expect(error.message_en).toContain('"A-999"')
  })
})

describe('VALIDATION_ERROR: arguments the agent must change', () => {
  it('correct_entry / reverse: a voucher ref in several fiscal years keeps the candidates to pick from', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        { id: '11111111-1111-4111-8111-111111111111', entry_date: '2026-08-10', description: 'Google Workspace' },
        { id: '22222222-2222-4222-8222-222222222222', entry_date: '2025-08-11', description: 'Leverantörsfaktura' },
      ],
    })
    const error = await refusal('gnubok_reverse_journal_entry', { entry_id: 'A-149' }, supabase)

    expect(error).toMatchObject({ code: 'VALIDATION_ERROR', retryable: false })
    expect(error.message_en).toMatch(/^Invalid arguments: entry_id: Voucher "A-149" matches multiple entries/)
    expect(error.message_en).toContain('id=11111111-1111-4111-8111-111111111111')
    expect(error.message_en).toContain('id=22222222-2222-4222-8222-222222222222')
    expect(error.message_sv).toBe('entry_id: Verifikation A-149 finns i flera räkenskapsår: ange verifikationens id (UUID) i stället.')
  })

  it('an entry reference that is neither a UUID nor a voucher ref', async () => {
    const from = vi.fn()
    const error = await refusal('gnubok_reverse_journal_entry', { entry_id: 'last one' }, { from })
    expect(error.code).toBe('VALIDATION_ERROR')
    expect(from).not.toHaveBeenCalled()
  })

  it('query_journal: an unknown group_by lists the valid ones', async () => {
    const from = vi.fn()
    const error = await refusal('gnubok_query_journal', { group_by: 'month' }, { from })

    expect(error.code).toBe('VALIDATION_ERROR')
    expect(error.message_en).toBe(
      'Invalid arguments: group_by: must be one of: account_number, voucher_series, source_type, cost_center, project',
    )
    expect(error.message_sv).toBe('group_by: Måste vara ett av: account_number, voucher_series, source_type, cost_center, project.')
  })

  it('get_invoice_deliveries: a missing invoice_id', async () => {
    const from = vi.fn()
    const error = await refusal('gnubok_get_invoice_deliveries', {}, { from })
    expect(error).toMatchObject({ code: 'VALIDATION_ERROR', message_en: 'Invalid arguments: invoice_id: is required' })
    expect(from).not.toHaveBeenCalled()
  })

  it('categorize_transaction: an unknown category', async () => {
    const { supabase } = createQueuedMockSupabase()
    const error = await refusal('gnubok_categorize_transaction', { transaction_id: JE_ID, category: 'other' }, supabase)
    expect(error.code).toBe('VALIDATION_ERROR')
    expect(error.message_sv).toMatch(/^category: Okänd kategori "other"\. Giltiga kategorier: /)
  })

  it('update_customer: nothing to change', async () => {
    const { supabase } = createQueuedMockSupabase()
    const error = await refusal('gnubok_update_customer', { customer_id: '11111111-1111-4111-8111-111111111111' }, supabase)
    expect(error).toMatchObject({
      code: 'VALIDATION_ERROR',
      message_en: 'Invalid customer update: changes: At least one customer field must be supplied',
    })
  })

  it('set_inbox_extracted_data: every field at fault, named from extracted_data', async () => {
    const { supabase } = createQueuedMockSupabase()
    const error = await refusal('gnubok_set_inbox_extracted_data', { inbox_item_id: 'inbox-1', extracted_data: { supplier: 'not-an-object' } }, supabase)
    expect(error.code).toBe('VALIDATION_ERROR')
    expect(error.message_en).toMatch(/^Invalid extracted_data: extracted_data\./)
    expect(error.message_en).not.toMatch(/"code":/) // no raw Zod JSON
  })

  it('set_inbox_extracted_data: no extracted_data at all', async () => {
    const { supabase } = createQueuedMockSupabase()
    const error = await refusal('gnubok_set_inbox_extracted_data', { inbox_item_id: 'inbox-1' }, supabase)
    expect(error).toMatchObject({ code: 'VALIDATION_ERROR', message_sv: 'extracted_data: Obligatoriskt fält saknas.' })
  })

  it('create_skill: a step over 200 characters', async () => {
    const { supabase } = createQueuedMockSupabase()
    const error = await refusal('gnubok_create_skill', { name: 'Månadsflöde', description: 'Stäng månaden', steps: ['x'.repeat(201)] }, supabase)
    expect(error).toMatchObject({ code: 'VALIDATION_ERROR', retryable: false, message_sv: 'steps.0: Högst 200 tecken.' })
    expect(error.message_en).toMatch(/^Invalid skill: steps\.0: /)
  })

  it('create_skill: markup in the text of knowledge is the caller\'s text to fix', async () => {
    const { supabase } = createQueuedMockSupabase()
    const error = await refusal(
      'gnubok_create_skill',
      { kind: 'rules', name: 'Momsregler', description: 'Så bokför vi moms', text: 'Bokför alltid <b>moms</b> separat.' },
      supabase,
    )
    expect(error.code).toBe('VALIDATION_ERROR')
    expect(error.message_en).toMatch(/^Invalid skill: text: Line \d+: use plain Markdown/)
    expect(supabase.from).not.toHaveBeenCalled()
  })
})

describe('the server\'s own parse is not the caller\'s fault', () => {
  it('create_skill: a flow body the builder assembled that fails SkillBodySchema is INTERNAL_ERROR', async () => {
    // buildOwnSkill cleans every field, yet a description that opens with a
    // bare "export " still becomes a line markdownProblems rejects: the
    // builder's promise is what failed, not the agent's arguments.
    const { supabase } = createQueuedMockSupabase()
    const error = await refusal(
      'gnubok_create_skill',
      { name: 'Månadsflöde', description: 'export the invoices to the accountant', steps: ['Hämta fakturorna'] },
      supabase,
    )
    expect(error.code).toBe('INTERNAL_ERROR')
    expect(error.code).not.toBe('VALIDATION_ERROR')
    expect(error.message_en).toMatch(/failed its own validation \(a server bug\)/)
    expect(supabase.from).not.toHaveBeenCalled()
  })
})

describe('registry codes the refusal already had', () => {
  it('unlock_period: a closed period is PERIOD_UNLOCK_CLOSED', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'p1', name: '2025', period_start: '2025-01-01', period_end: '2025-12-31', is_closed: true, locked_at: '2026-02-01T00:00:00Z' } })
    expect(await refusal('gnubok_unlock_period', { fiscal_period_id: 'p1' }, supabase)).toMatchObject({
      code: 'PERIOD_UNLOCK_CLOSED',
      retryable: false,
      message_sv: getErrorEntry('PERIOD_UNLOCK_CLOSED')!.message_sv,
    })
  })

  it('unlock_period: a period that is not locked is PERIOD_UNLOCK_NOT_LOCKED', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'p1', name: '2026', period_start: '2026-01-01', period_end: '2026-12-31', is_closed: false, locked_at: null } })
    expect((await refusal('gnubok_unlock_period', { fiscal_period_id: 'p1' }, supabase)).code).toBe('PERIOD_UNLOCK_NOT_LOCKED')
  })

  it('bulk_book_transactions: unbalanced new_entry lines are JOURNAL_ENTRY_NOT_BALANCED with both totals', async () => {
    const from = vi.fn()
    const error = await refusal(
      'gnubok_bulk_book_transactions',
      {
        tx_ids: ['tx-1'],
        new_entry: {
          description: 'Skatteverket',
          lines: [
            { account_number: '2710', debit_amount: 3001.41, credit_amount: 0, currency: 'SEK' },
            { account_number: '2731', debit_amount: 0, credit_amount: 590.28, currency: 'SEK' },
          ],
        },
      },
      { from },
    )
    expect(error).toMatchObject({ code: 'JOURNAL_ENTRY_NOT_BALANCED', retryable: false })
    expect(error.message_en).toBe('new_entry.lines must balance: debits=3001.41 credits=590.28')
    // Intl separates thousands and the currency with no-break spaces.
    expect(error.message_sv).toMatch(/^Verifikationen balanserar inte \(3\s001,41\skr debet vs 590,28\skr kredit\)\.$/)
    expect(from).not.toHaveBeenCalled()
  })

  it('link_invoice_to_voucher: the validator code rides on .code, its details stay in the text', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'inv-1', invoice_number: '1042', status: 'sent', document_type: 'invoice', currency: 'SEK', remaining_amount: 312 } })
    mockValidateInvoiceLink.mockResolvedValue({
      ok: false,
      code: 'LINK_VOUCHER_AMOUNT_EXCEEDS_REMAINING',
      details: { ar_credit: 313, remaining: 312 },
    })
    const error = await refusal('gnubok_link_invoice_to_voucher', { invoice_id: 'inv-1', journal_entry_id: JE_ID }, supabase)

    expect(error).toMatchObject({
      code: 'LINK_VOUCHER_AMOUNT_EXCEEDS_REMAINING',
      retryable: false,
      message_sv: getErrorEntry('LINK_VOUCHER_AMOUNT_EXCEEDS_REMAINING')!.message_sv,
    })
    expect(error.message_en).toContain('Details: {"ar_credit":313,"remaining":312}')
  })
})
