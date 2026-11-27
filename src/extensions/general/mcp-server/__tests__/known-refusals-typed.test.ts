/**
 * Refusals the tools threw as plain Errors, so the agent read UNKNOWN_ERROR,
 * "Något gick fel. Försök igen.", for calls no retry fixes (30 days to
 * 2026-11-08): gnubok_create_voucher 19 (unbalanced lines, no open period, an
 * inbox item missing or booked already), gnubok_create_supplier_invoice_from_inbox
 * 13 (item missing, converted already, no reading), the upload tools 22 (a CSV,
 * Excel, text or Markdown file). Each answers a registry code and a remediation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/bookkeeping/engine', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/engine')>('@/lib/bookkeeping/engine')
  return { ...actual, findFiscalPeriod: vi.fn() }
})

import { tools } from '../server'
import { toToolError } from '../tool-result'
import { findFiscalPeriod } from '@/lib/bookkeeping/engine'

const tool = (name: string) => tools.find((t) => t.name === name)!

async function refusal(promise: Promise<unknown>) {
  return toToolError(await promise.then(() => null, (err: unknown) => err)).error
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_create_voucher', () => {
  const OPEN_PERIOD = { data: { id: 'fp-1', is_closed: false, period_start: '2026-01-01', period_end: '2026-12-31', name: '2026' }, error: null }
  const ACCOUNTS = {
    data: [
      { account_number: '5410', account_name: 'Förbrukningsinventarier', is_active: true },
      { account_number: '1930', account_name: 'Företagskonto', is_active: true },
    ],
    error: null,
  }
  const LINES = [
    { account_number: '5410', debit_amount: 250 },
    { account_number: '1930', credit_amount: 250 },
  ]
  const stage = (supabase: unknown, args: Record<string, unknown>) =>
    tool('gnubok_create_voucher').execute(
      { entry_date: '2026-05-12', description: 'Kvitto', lines: LINES, ...args },
      'company-1',
      'user-1',
      supabase as never,
    )

  it('unbalanced lines: JOURNAL_ENTRY_NOT_BALANCED, the totals named', async () => {
    const { supabase } = createQueuedMockSupabase()
    const error = await refusal(stage(supabase, { lines: [LINES[0], { account_number: '1930', credit_amount: 249.75 }] }))
    expect(error).toMatchObject({ code: 'JOURNAL_ENTRY_NOT_BALANCED', retryable: false, message_sv: expect.stringMatching(/^Verifikationen balanserar inte\./) })
    expect(error.message_en).toBe('Lines are not balanced: debits 250 SEK, credits 249.75 SEK. Both must be positive and equal.')
    expect(error.remediation?.description).toMatch(/Recalculate the lines/)
  })

  it('a fiscal_period_id of no period: FISCAL_PERIOD_NOT_FOUND, leave it out', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: null })
    const error = await refusal(stage(supabase, { fiscal_period_id: 'fp-unknown' }))
    expect(error).toMatchObject({ code: 'FISCAL_PERIOD_NOT_FOUND', remediation: { description: expect.stringMatching(/Leave fiscal_period_id out/) } })
  })

  it('no open period covers the date: NO_OPEN_PERIOD_FOR_DATE', async () => {
    vi.mocked(findFiscalPeriod).mockResolvedValueOnce(null)
    const { supabase } = createQueuedMockSupabase()
    const error = await refusal(stage(supabase, {}))
    expect(error).toMatchObject({ code: 'NO_OPEN_PERIOD_FOR_DATE', retryable: false })
    expect(error.message_en).toContain('No open fiscal period covers 2026-05-12')
  })

  it('an inbox_item_id of no item: INBOX_ITEM_NOT_FOUND, pointing at the inbox list', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue(OPEN_PERIOD)
    enqueue(ACCOUNTS)
    enqueue({ data: null, error: { code: 'PGRST116', message: 'no rows' } })
    const error = await refusal(stage(supabase, { fiscal_period_id: 'fp-1', inbox_item_id: 'inbox-missing' }))
    expect(error).toMatchObject({
      code: 'INBOX_ITEM_NOT_FOUND',
      message_sv: 'Inkorgsposten hittades inte.',
      message_en: 'Inbox item inbox-missing not found for this company.',
      remediation: { tool: 'gnubok_list_inbox_items', description: expect.stringContaining('A document id is no inbox item id') },
      retryable: false,
    })
  })

  it('an inbox item booked already: INBOX_ITEM_ALREADY_BOOKED, changed only by correction or storno', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue(OPEN_PERIOD)
    enqueue(ACCOUNTS)
    enqueue({ data: { id: 'inbox-1', document_id: 'doc-1', created_journal_entry_id: 'je-1', created_supplier_invoice_id: null }, error: null })
    const error = await refusal(stage(supabase, { fiscal_period_id: 'fp-1', inbox_item_id: 'inbox-1' }))
    expect(error).toMatchObject({ code: 'INBOX_ITEM_ALREADY_BOOKED', retryable: false })
    expect(error.message_en).toContain('already booked as journal entry je-1')
    expect(error.remediation?.description).toMatch(/gnubok_correct_entry or gnubok_reverse_journal_entry/)
  })

  it('an inbox item registered as a supplier invoice: INBOX_ITEM_ALREADY_CONVERTED', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue(OPEN_PERIOD)
    enqueue(ACCOUNTS)
    enqueue({ data: { id: 'inbox-1', document_id: 'doc-1', created_journal_entry_id: null, created_supplier_invoice_id: 'si-1' }, error: null })
    const error = await refusal(stage(supabase, { fiscal_period_id: 'fp-1', inbox_item_id: 'inbox-1' }))
    expect(error).toMatchObject({ code: 'INBOX_ITEM_ALREADY_CONVERTED', message_en: expect.stringContaining('supplier invoice si-1') })
  })
})

describe('gnubok_create_supplier_invoice_from_inbox', () => {
  const stage = (supabase: unknown, args: Record<string, unknown> = { inbox_item_id: 'inbox-1' }) =>
    tool('gnubok_create_supplier_invoice_from_inbox').execute(args, 'company-1', 'user-1', supabase as never)
  const ITEM = { id: 'inbox-1', status: 'received', matched_supplier_id: null, created_supplier_invoice_id: null, created_journal_entry_id: null, document_id: 'doc-1', kind_hint: null }

  it('no inbox_item_id: VALIDATION_ERROR on the field', async () => {
    const { supabase } = createQueuedMockSupabase()
    expect(await refusal(stage(supabase, {}))).toMatchObject({ code: 'VALIDATION_ERROR', message_en: 'inbox_item_id is required' })
  })

  it('an id of no item: INBOX_ITEM_NOT_FOUND, pointing at the inbox list', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { code: 'PGRST116', message: 'no rows' } })
    expect(await refusal(stage(supabase))).toMatchObject({
      code: 'INBOX_ITEM_NOT_FOUND',
      message_en: 'Inbox item inbox-1 not found for this company.',
      remediation: { tool: 'gnubok_list_inbox_items' },
    })
  })

  it('registered already: INBOX_ITEM_ALREADY_CONVERTED, do not stage again', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ...ITEM, created_supplier_invoice_id: 'si-1', extracted_data: {} }, error: null })
    const error = await refusal(stage(supabase))
    expect(error).toMatchObject({
      code: 'INBOX_ITEM_ALREADY_CONVERTED',
      message_sv: 'Posten är redan kopplad till en leverantörsfaktura.',
      message_en: 'Inbox item already converted to supplier invoice si-1',
      remediation: { description: expect.stringContaining('Do not stage it again') },
    })
  })

  it('registered as an invoice that was credited since: released, so the staging goes on to its next check', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ...ITEM, created_supplier_invoice_id: 'si-1', extracted_data: null }, error: null })
    // The invoice the item names: credited, so it no longer holds the underlag.
    enqueue({ data: { id: 'si-1', status: 'credited', is_credit_note: false }, error: null })
    const error = await refusal(stage(supabase))
    expect(error).toMatchObject({ code: 'INBOX_ITEM_NO_READING' })
  })

  it('no reading: INBOX_ITEM_NO_READING, write one with set_inbox_extracted_data', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ...ITEM, extracted_data: null }, error: null })
    const error = await refusal(stage(supabase))
    expect(error).toMatchObject({
      code: 'INBOX_ITEM_NO_READING',
      retryable: false,
      remediation: { tool: 'gnubok_set_inbox_extracted_data', args: { inbox_item_id: 'inbox-1' } },
    })
    expect(error.message_en).toMatch(/^Inbox item has no extracted_data/)
  })
})

describe('gnubok_create_document_upload and gnubok_upload_document', () => {
  const PNG = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64')
  const reserve = (args: Record<string, unknown>) =>
    tool('gnubok_create_document_upload').execute(args, 'company-1', 'user-1', createQueuedMockSupabase().supabase as never)
  const upload = (args: Record<string, unknown>) =>
    tool('gnubok_upload_document').execute({ file_content_base64: PNG, ...args }, 'company-1', 'user-1', createQueuedMockSupabase().supabase as never)

  it.each([
    ['a CSV bank statement', () => upload({ file_name: 'kontoutdrag.csv', mime_type: 'text/csv' }), 'Unsupported file type: text/csv. Allowed: PDF, JPEG, PNG, HEIC, WebP'],
    ['an Excel file by extension', () => reserve({ file_name: 'kontoutdrag.xls' }), 'Cannot infer MIME type from extension: .xls. Allowed: PDF, JPEG, PNG, HEIC, WebP'],
    ['a text file', () => reserve({ file_name: 'anteckning.txt', mime_type: 'text/plain' }), 'Unsupported file type: text/plain. Allowed: PDF, JPEG, PNG, HEIC, WebP'],
  ])('%s: DOC_UPLOAD_UNSUPPORTED_TYPE, with where a bank file goes', async (_label, call, message) => {
    const error = await refusal(call())
    expect(error).toMatchObject({ code: 'DOC_UPLOAD_UNSUPPORTED_TYPE', message_sv: 'Filtypen stöds inte.', message_en: message, retryable: false })
    expect(error.remediation?.description).toMatch(/gnubok_create_transactions/)
    expect(error.remediation?.description).toMatch(/Importera bankfil/)
  })
})
