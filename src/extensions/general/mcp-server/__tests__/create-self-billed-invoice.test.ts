import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase, makeCustomer, makeInvoice, makeJournalEntry } from '@/tests/helpers'
import { createInvoiceJournalEntry } from '@/lib/bookkeeping/invoice-entries'
import { hashRequest } from '@/lib/api/idempotency'
import { fetchExchangeRate } from '@/lib/currency/riksbanken'
import { startPackageForTool } from '@/lib/modules/package-doors'
import { packageOffRefusal, packageStartRefusal } from '@/lib/modules/package-gate'
import { commitPendingOperation } from '@/lib/pending-operations/commit'
import type { PendingOperation } from '@/types'
import { STAGE_BRIDGE_TARGETS, tools } from '../server'

vi.mock('@/lib/bookkeeping/invoice-entries', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/bookkeeping/invoice-entries')>(),
  createInvoiceJournalEntry: vi.fn(),
}))

vi.mock('@/lib/currency/riksbanken', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/currency/riksbanken')>(),
  fetchExchangeRate: vi.fn(),
}))

const createInvoice = tools.find((tool) => tool.name === 'gnubok_create_self_billed_invoice')!
const approve = tools.find((tool) => tool.name === 'gnubok_approve_pending_operation')!
const customer = makeCustomer({ id: '4cf22bcf-df63-4650-ae22-004d290f8310' })
const input = {
  customer_id: customer.id,
  external_invoice_number: 'SB-42',
  self_billing_agreement_ref: 'AV-1',
  invoice_date: '2026-10-02',
  received_date: '2026-10-03',
  due_date: '2026-11-02',
  currency: 'SEK',
  items: [{ description: 'Konsulttid', quantity: 2, unit_price: 1000, vat_rate: 25 }],
}

beforeEach(() => vi.clearAllMocks())

async function stage(accountingMethod: 'accrual' | 'cash', dryRun: boolean, currency = 'SEK') {
  const mock = createQueuedMockSupabase()
  mock.enqueueMany([{ data: customer }, { data: { accounting_method: accountingMethod } }])
  if (accountingMethod === 'accrual') {
    mock.enqueueMany([{ data: {} }, { data: { id: 'period-1', is_closed: false } }])
  }
  if (!dryRun) mock.enqueue({ data: { id: 'op-1' } })
  const result = await createInvoice.execute({ ...input, currency, dry_run: dryRun }, 'company-1', 'user-1', mock.supabase as never)
  return { ...mock, result }
}

async function stageForApproval(accountingMethod: 'accrual' | 'cash', currency = 'SEK'): Promise<PendingOperation> {
  const staged = await stage(accountingMethod, false, currency)
  const row = staged.findCall('pending_operations', 'insert')?.[0] as PendingOperation
  return { ...row, id: 'op-1', status: 'pending' }
}

describe('MCP received self-billed invoice', () => {
  it('is reachable via the staging bridge and previews totals without writing', async () => {
    expect(STAGE_BRIDGE_TARGETS).toContain(createInvoice)
    const mock = await stage('accrual', true)
    expect(mock.result).toMatchObject({
      staged: false,
      dry_run: true,
      risk_level: 'high',
      period_status: { period_id: 'period-1', status: 'open' },
      preview: {
        external_invoice_number: 'SB-42', subtotal: 2000, vat_amount: 500, total: 2500,
        posts_on_approval: true,
      },
    })
    expect(mock.calls.filter(({ method }) => method === 'insert')).toEqual([])
    expect(mock.findCalls('fiscal_periods', 'lte')).toEqual([['period_start', input.invoice_date]])
  })

  it('stages a cash-method invoice without a posting-period check', async () => {
    const mock = await stage('cash', false)
    expect(mock.result).toMatchObject({ staged: true, risk_level: 'high', preview: { posts_on_approval: false } })
    expect(mock.result).not.toHaveProperty('period_status')
    expect(mock.findCall('pending_operations', 'insert')?.[0]).toMatchObject({
      operation_type: 'create_self_billed_invoice', risk_level: 'high', params: {
        ...input, items: [{ ...input.items[0], unit: 'st' }],
      },
    })
    expect(mock.findCalls('invoices', 'insert')).toEqual([])
  })

  it.each([
    { external_invoice_number: ' ' },
    { received_date: '2026-02-30' },
    { items: [{ ...input.items[0], article_id: 'ignored-field' }] },
    { items: [{ ...input.items[0], vat_rate: 10 }] },
  ])('rejects invalid input before reading company data (%j)', async (overrides) => {
    const { supabase } = createQueuedMockSupabase()
    await expect(createInvoice.execute({ ...input, ...overrides }, 'company-1', 'user-1', supabase as never))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('refuses an unknown customer within the selected company', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: null })
    await expect(createInvoice.execute(input, 'company-1', 'user-1', supabase as never))
      .rejects.toMatchObject({ code: 'INVOICE_CUSTOMER_NOT_FOUND' })
    expect(findCalls('customers', 'eq')).toEqual([['id', customer.id], ['company_id', 'company-1']])
  })

  it('requires explicit confirmation on MCP approval', async () => {
    const staged = await stage('accrual', false)
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    const stagedRow = staged.findCall('pending_operations', 'insert')?.[0] as PendingOperation
    enqueue({ data: { ...stagedRow, id: 'op-1' } })
    await expect(approve.execute({ operation_id: 'op-1' }, 'company-1', 'user-1', supabase as never))
      .rejects.toThrow(/confirmed=true/)
    expect(findCalls('pending_operations', 'update')).toEqual([])
  })

  it.each(['accrual', 'cash'] as const)('registers the customer number on approval (%s)', async (accountingMethod) => {
    const operation = await stageForApproval(accountingMethod)
    const { supabase, enqueueMany, findCall } = createQueuedMockSupabase()
    const invoice = makeInvoice({
      id: 'invoice-1', invoice_number: null, external_invoice_number: 'SB-42', is_self_billed: true,
      status: 'sent', total: 2500,
    })
    const journalEntry = makeJournalEntry({ id: 'journal-1' })
    vi.mocked(createInvoiceJournalEntry).mockResolvedValue(journalEntry)
    enqueueMany([
      { data: { id: operation.id } },
      { data: customer },
      { data: { accounting_method: accountingMethod, entity_type: 'aktiebolag' } },
      { data: invoice },
      {},
      { data: invoice },
      ...(accountingMethod === 'accrual' ? [{}] : []),
      { data: { ...invoice, journal_entry_id: accountingMethod === 'accrual' ? journalEntry.id : null } },
      {},
    ])

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', operation)
    expect(result).toMatchObject({ status: 'committed', data: {
      invoice_id: invoice.id, external_invoice_number: 'SB-42',
      journal_entry_id: accountingMethod === 'accrual' ? journalEntry.id : null,
    } })
    expect(findCall('invoices', 'insert')?.[0]).toMatchObject({
      company_id: 'company-1', invoice_number: null, is_self_billed: true, external_invoice_number: 'SB-42',
      received_date: input.received_date, status: 'sent',
    })
    expect(findCall('invoice_items', 'insert')?.[0]).toMatchObject([{ vat_rate: 25, vat_amount: 500 }])
    if (accountingMethod === 'accrual') {
      expect(createInvoiceJournalEntry).toHaveBeenCalledWith(
        supabase, 'company-1', 'user-1', invoice, 'aktiebolag', customer.name,
        expect.objectContaining({ descriptionPrefix: 'Självfaktura', numberOverride: 'SB-42' }),
      )
    } else {
      expect(createInvoiceJournalEntry).not.toHaveBeenCalled()
    }
  })

  it('records the posted voucher in the approval receipt when linking the invoice fails', async () => {
    const operation = await stageForApproval('accrual')
    const { supabase, enqueueMany, findCall, findCalls } = createQueuedMockSupabase()
    const invoice = makeInvoice({ id: 'invoice-1', journal_entry_id: null })
    const journalEntry = makeJournalEntry({ id: '550e8400-e29b-41d4-a716-446655440000' })
    vi.mocked(createInvoiceJournalEntry).mockResolvedValue(journalEntry)
    enqueueMany([
      { data: { id: operation.id, updated_at: '2026-10-03T10:00:00Z' } },
      { data: customer },
      { data: { accounting_method: 'accrual', entity_type: 'aktiebolag' } },
      { data: invoice },
      {},
      { data: invoice },
      { error: { message: 'Invoice link update failed' } },
      { data: invoice },
      {},
      { data: [{ id: journalEntry.id }] },
      { data: [] },
      {},
    ])

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', operation)

    expect(result).toMatchObject({ status: 'committed', data: { journal_entry_id: journalEntry.id } })
    expect(findCalls('invoices', 'delete')).toEqual([])
    expect(findCall('suggestion_log', 'insert')?.[0]).toMatchObject([
      { final: { journal_entry_id: journalEntry.id } },
    ])
  })

  it('refuses approval when the customer-invoices package is disabled', async () => {
    expect(startPackageForTool(createInvoice.name)).toBe('customer-invoices')
    const operation = await stageForApproval('cash')
    const { supabase, findCalls } = createQueuedMockSupabase()
    vi.mocked(packageStartRefusal).mockResolvedValueOnce(packageOffRefusal('customer-invoices', 'turned_off_by_company'))

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', operation)

    expect(result).toMatchObject({ code: 'PACKAGE_OFF', operation_status: 'pending' })
    expect(findCalls('pending_operations', 'update')).toEqual([])
    expect(findCalls('invoices', 'insert')).toEqual([])
  })

  it('requires a new review when the actual SEK amount crosses the key ceiling', async () => {
    vi.mocked(fetchExchangeRate)
      .mockResolvedValueOnce({ currency: 'EUR', rate: 10, date: input.invoice_date })
      .mockResolvedValueOnce({ currency: 'EUR', rate: 12, date: input.invoice_date })
    const operation = await stageForApproval('accrual', 'EUR')
    expect(operation.preview_data).toMatchObject({ total_sek: 25000 })
    const { supabase, enqueueMany, findCalls } = createQueuedMockSupabase()
    enqueueMany([{ data: { id: operation.id } }, { data: customer }])

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', operation, {
      actor: { type: 'api_key', unattendedCommitLimit: 26000 },
    })

    expect(result).toMatchObject({ code: 'SELF_BILLED_INVOICE_REVIEW_CHANGED', operation_status: 'rejected' })
    expect(findCalls('invoices', 'insert')).toEqual([])
    expect(createInvoiceJournalEntry).not.toHaveBeenCalled()
  })

  it('replays the SEK amount attached to the original proposal after an FX change', async () => {
    vi.mocked(fetchExchangeRate).mockResolvedValueOnce({ currency: 'EUR', rate: 12, date: input.invoice_date })
    const original = createQueuedMockSupabase()
    const args = { ...input, currency: 'EUR', items: [{ ...input.items[0], unit: 'st' }] }
    original.enqueueMany([
      { data: customer },
      { data: { accounting_method: 'cash' } },
      {
        data: {
          request_hash: hashRequest({ operationType: 'create_self_billed_invoice', params: args, companyId: 'company-1' }),
          response_body: { staged: true, operation_id: 'op-original', preview: { total_sek: 25000, exchange_rate: 10 } },
        },
      },
    ])

    const result = await createInvoice.execute(
      { ...args, idempotency_key: '45cbb6ec-f7d8-48e0-b654-24388d87af9f' },
      'company-1', 'user-1', original.supabase as never,
    )

    expect(result).toMatchObject({
      staged: true,
      idempotency_replay: true,
      operation_id: 'op-original',
      preview: { total_sek: 25000, exchange_rate: 10 },
    })
    expect(original.findCalls('pending_operations', 'insert')).toEqual([])
  })

  it('requires a new review when the accounting method has changed', async () => {
    const operation = await stageForApproval('cash')
    const { supabase, enqueueMany, findCalls } = createQueuedMockSupabase()
    enqueueMany([
      { data: { id: operation.id } }, { data: customer },
      { data: { accounting_method: 'accrual', entity_type: 'aktiebolag' } },
    ])

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', operation)

    expect(result).toMatchObject({ code: 'SELF_BILLED_INVOICE_REVIEW_CHANGED', operation_status: 'rejected' })
    expect(findCalls('invoices', 'insert')).toEqual([])
  })

  it('keeps the proposal pending when the exchange rate is temporarily unavailable', async () => {
    vi.mocked(fetchExchangeRate)
      .mockResolvedValueOnce({ currency: 'EUR', rate: 10, date: input.invoice_date })
      .mockResolvedValueOnce(null)
    const operation = await stageForApproval('accrual', 'EUR')
    const { supabase, enqueueMany, findCalls } = createQueuedMockSupabase()
    enqueueMany([{ data: { id: operation.id } }, { data: customer }])

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', operation)

    expect(result).toMatchObject({ code: 'SELF_BILLED_INVOICE_FX_RATE_UNAVAILABLE', operation_status: 'pending' })
    expect(findCalls('invoices', 'insert')).toEqual([])
  })
})
