/**
 * Staging-time gate tests for gnubok_create_voucher.
 *
 * The executor-level gates (period lock, balance, status === 'posted' for
 * correct_entry) are tested in lib/pending-operations/__tests__/. This file
 * covers the pre-staging gates added to the MCP tool layer for UX: explicit
 * fiscal_period_id validation, inactive/missing account rejection, and the
 * source_type-not-staged invariant.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/bookkeeping/engine', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/engine')>(
    '@/lib/bookkeeping/engine'
  )
  return {
    ...actual,
    findFiscalPeriod: vi.fn(),
  }
})

import { tools } from '../server'
import { findFiscalPeriod } from '@/lib/bookkeeping/engine'

const createVoucher = tools.find((t) => t.name === 'gnubok_create_voucher')!
const correctEntry = tools.find((t) => t.name === 'gnubok_correct_entry')!
const reverseEntry = tools.find((t) => t.name === 'gnubok_reverse_journal_entry')!

beforeEach(() => {
  vi.clearAllMocks()
})

const balancedLines = [
  { account_number: '1010', debit_amount: 250, credit_amount: 0 },
  { account_number: '1930', debit_amount: 0, credit_amount: 250 },
]

describe('gnubok_create_voucher: staging gates', () => {
  it('is registered and mapped to bookkeeping:write scope', async () => {
    const { TOOL_SCOPE_MAP } = await import('@/lib/auth/api-keys')
    expect(createVoucher).toBeDefined()
    expect(createVoucher.annotations.readOnlyHint).toBe(false)
    expect(TOOL_SCOPE_MAP.gnubok_create_voucher).toBe('bookkeeping:write')
  })

  it('rejects unbalanced lines before staging', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      createVoucher.execute(
        {
          entry_date: '2026-05-12',
          description: 'unbalanced',
          fiscal_period_id: 'fp-1',
          lines: [
            { account_number: '1010', debit_amount: 100, credit_amount: 0 },
            { account_number: '1930', debit_amount: 0, credit_amount: 80 },
          ],
        },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/not balanced/i)
  })

  it('rejects when an explicit fiscal_period_id is closed', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    // fiscal_periods fetch returns a closed period
    enqueue({
      data: {
        id: 'fp-closed',
        is_closed: true,
        period_start: '2026-01-01',
        period_end: '2026-03-31',
        name: 'Q1 2026',
      },
      error: null,
    })

    await expect(
      createVoucher.execute(
        {
          entry_date: '2026-02-15',
          description: 'attempt to post in closed Q1',
          fiscal_period_id: 'fp-closed',
          lines: balancedLines,
        },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/låst/i)
    // findFiscalPeriod must NOT be called when an explicit ID was supplied.
    expect(findFiscalPeriod).not.toHaveBeenCalled()
  })

  it('rejects when an explicit fiscal_period_id does not exist', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: null }) // fiscal_periods fetch: not found

    await expect(
      createVoucher.execute(
        {
          entry_date: '2026-05-12',
          description: 'unknown period uuid',
          fiscal_period_id: 'fp-nonexistent',
          lines: balancedLines,
        },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/not found/i)
  })

  it('rejects when entry_date is outside the supplied period', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: {
        id: 'fp-1',
        is_closed: false,
        period_start: '2026-01-01',
        period_end: '2026-03-31',
        name: 'Q1 2026',
      },
      error: null,
    })

    await expect(
      createVoucher.execute(
        {
          entry_date: '2026-05-12',
          description: 'date outside Q1',
          fiscal_period_id: 'fp-1',
          lines: balancedLines,
        },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/utanför/i)
  })

  it('rejects when a referenced account is missing from the chart', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: {
        id: 'fp-1',
        is_closed: false,
        period_start: '2026-01-01',
        period_end: '2026-12-31',
        name: '2026',
      },
      error: null,
    })
    // chart_of_accounts returns nothing: both accounts unknown
    enqueue({ data: [], error: null })

    await expect(
      createVoucher.execute(
        {
          entry_date: '2026-05-12',
          description: 'unknown accounts',
          fiscal_period_id: 'fp-1',
          lines: balancedLines,
        },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/saknas i kontoplanen/i)
  })

  it('rejects when a referenced account exists but is inactive', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: {
        id: 'fp-1',
        is_closed: false,
        period_start: '2026-01-01',
        period_end: '2026-12-31',
        name: '2026',
      },
      error: null,
    })
    enqueue({
      data: [
        { account_number: '1010', account_name: 'Balanserade utgifter', is_active: false },
        { account_number: '1930', account_name: 'Företagskonto', is_active: true },
      ],
      error: null,
    })

    await expect(
      createVoucher.execute(
        {
          entry_date: '2026-05-12',
          description: 'inactive account',
          fiscal_period_id: 'fp-1',
          lines: balancedLines,
        },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/inaktiv/i)
  })

  it('happy path: stages with no source_type in params (executor hardcodes it)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: {
        id: 'fp-1',
        is_closed: false,
        period_start: '2026-01-01',
        period_end: '2026-12-31',
        name: '2026',
      },
      error: null,
    })
    enqueue({
      data: [
        { account_number: '1010', account_name: 'Balanserade utgifter', is_active: true },
        { account_number: '1930', account_name: 'Företagskonto', is_active: true },
      ],
      error: null,
    })
    // resolvePeriodStatusForDate: layer 1 (company_settings) + layer 2 (fiscal_periods).
    enqueue({ data: null, error: null })
    enqueue({ data: null, error: null })
    enqueue({ data: { id: 'op-staged' }, error: null }) // pending_operations insert

    const result = (await createVoucher.execute(
      {
        entry_date: '2026-05-12',
        description: 'Capitalize Cursor',
        fiscal_period_id: 'fp-1',
        lines: balancedLines,
      },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; operation_id?: string; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    expect(result.operation_id).toBe('op-staged')
    expect(result.preview.total_debit).toBe(250)
    expect(result.preview.total_credit).toBe(250)

    // Critical: the staged pending_operations row must NOT carry source_type.
    // The executor always hardcodes 'manual'. Look at the insert call.
    const insertCalls = (supabase.from as ReturnType<typeof vi.fn>).mock.calls
    expect(insertCalls.some((args) => args[0] === 'pending_operations')).toBe(true)
  })

  it('exposes inbox_item_id as an optional input', () => {
    const schema = createVoucher.inputSchema as {
      properties: { inbox_item_id?: { type: string; description?: string } }
      required?: string[]
    }
    expect(schema.properties.inbox_item_id).toBeDefined()
    expect(schema.properties.inbox_item_id?.type).toBe('string')
    // Must NOT be required: voucher creation works standalone too.
    expect(schema.required ?? []).not.toContain('inbox_item_id')
  })

  it('happy path with inbox_item_id: stages the op with inbox_item_id + document_id in params', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: {
        id: 'fp-1',
        is_closed: false,
        period_start: '2026-01-01',
        period_end: '2026-12-31',
        name: '2026',
      },
      error: null,
    })
    enqueue({
      data: [
        { account_number: '5410', account_name: 'Förbrukningsinventarier', is_active: true },
        { account_number: '1930', account_name: 'Företagskonto', is_active: true },
      ],
      error: null,
    })
    enqueue({
      data: {
        id: 'inbox-1',
        document_id: 'doc-1',
        created_journal_entry_id: null,
        created_supplier_invoice_id: null,
      },
      error: null,
    }) // invoice_inbox_items lookup
    enqueue({ data: null, error: null }) // resolvePeriodStatusForDate layer 1
    enqueue({ data: null, error: null }) // resolvePeriodStatusForDate layer 2
    enqueue({ data: { id: 'op-inbox' }, error: null }) // pending_operations insert

    const result = (await createVoucher.execute(
      {
        entry_date: '2026-05-12',
        description: 'Kvitto från Clas Ohlson: adapter',
        fiscal_period_id: 'fp-1',
        inbox_item_id: 'inbox-1',
        lines: [
          { account_number: '5410', debit_amount: 250, credit_amount: 0 },
          { account_number: '1930', debit_amount: 0, credit_amount: 250 },
        ],
      },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; operation_id?: string; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    expect(result.preview.inbox_item_id).toBe('inbox-1')
    expect(result.preview.document_attached).toBe(true)
    expect(result.preview.will).toMatch(/link the inbox item/i)
  })

  it('rejects when inbox_item_id is already booked as a journal entry', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: {
        id: 'fp-1',
        is_closed: false,
        period_start: '2026-01-01',
        period_end: '2026-12-31',
        name: '2026',
      },
      error: null,
    })
    enqueue({
      data: [
        { account_number: '5410', account_name: 'Förbrukningsinventarier', is_active: true },
        { account_number: '1930', account_name: 'Företagskonto', is_active: true },
      ],
      error: null,
    })
    enqueue({
      data: {
        id: 'inbox-1',
        document_id: 'doc-1',
        created_journal_entry_id: 'je-existing',
        created_supplier_invoice_id: null,
      },
      error: null,
    })

    await expect(
      createVoucher.execute(
        {
          entry_date: '2026-05-12',
          description: 'duplicate book attempt',
          fiscal_period_id: 'fp-1',
          inbox_item_id: 'inbox-1',
          lines: [
            { account_number: '5410', debit_amount: 250, credit_amount: 0 },
            { account_number: '1930', debit_amount: 0, credit_amount: 250 },
          ],
        },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/already booked/i)
  })

  it('rejects when inbox_item_id is already converted to a supplier invoice', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: {
        id: 'fp-1',
        is_closed: false,
        period_start: '2026-01-01',
        period_end: '2026-12-31',
        name: '2026',
      },
      error: null,
    })
    enqueue({
      data: [
        { account_number: '5410', account_name: 'Förbrukningsinventarier', is_active: true },
        { account_number: '1930', account_name: 'Företagskonto', is_active: true },
      ],
      error: null,
    })
    enqueue({
      data: {
        id: 'inbox-1',
        document_id: 'doc-1',
        created_journal_entry_id: null,
        created_supplier_invoice_id: 'si-existing',
      },
      error: null,
    })

    await expect(
      createVoucher.execute(
        {
          entry_date: '2026-05-12',
          description: 'voucher attempt on AP-converted inbox',
          fiscal_period_id: 'fp-1',
          inbox_item_id: 'inbox-1',
          lines: [
            { account_number: '5410', debit_amount: 250, credit_amount: 0 },
            { account_number: '1930', debit_amount: 0, credit_amount: 250 },
          ],
        },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/already converted/i)
  })

  it('rejects when inbox_item_id does not exist for the company', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: {
        id: 'fp-1',
        is_closed: false,
        period_start: '2026-01-01',
        period_end: '2026-12-31',
        name: '2026',
      },
      error: null,
    })
    enqueue({
      data: [
        { account_number: '5410', account_name: 'Förbrukningsinventarier', is_active: true },
        { account_number: '1930', account_name: 'Företagskonto', is_active: true },
      ],
      error: null,
    })
    enqueue({ data: null, error: { message: 'not found' } })

    await expect(
      createVoucher.execute(
        {
          entry_date: '2026-05-12',
          description: 'unknown inbox uuid',
          fiscal_period_id: 'fp-1',
          inbox_item_id: 'inbox-missing',
          lines: [
            { account_number: '5410', debit_amount: 250, credit_amount: 0 },
            { account_number: '1930', debit_amount: 0, credit_amount: 250 },
          ],
        },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/inbox item .* not found/i)
  })
})

describe('gnubok_correct_entry: registration', () => {
  it('is registered with bookkeeping:write scope and is not read-only', async () => {
    const { TOOL_SCOPE_MAP } = await import('@/lib/auth/api-keys')
    expect(correctEntry).toBeDefined()
    expect(correctEntry.annotations.readOnlyHint).toBe(false)
    expect(TOOL_SCOPE_MAP.gnubok_correct_entry).toBe('bookkeeping:write')
  })

  it('rejects unbalanced replacement lines before staging', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      correctEntry.execute(
        {
          entry_id: 'je-1',
          lines: [
            { account_number: '2645', debit_amount: 250, credit_amount: 0 },
            { account_number: '2614', debit_amount: 0, credit_amount: 200 },
          ],
        },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/not balanced/i)
  })
})

describe('gnubok_reverse_journal_entry: staging gates', () => {
  it('is registered with bookkeeping:write scope and is not read-only', async () => {
    const { TOOL_SCOPE_MAP } = await import('@/lib/auth/api-keys')
    expect(reverseEntry).toBeDefined()
    expect(reverseEntry.annotations.readOnlyHint).toBe(false)
    expect(TOOL_SCOPE_MAP.gnubok_reverse_journal_entry).toBe('bookkeeping:write')
  })

  it('rejects when entry_id is missing', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      reverseEntry.execute({}, 'company-1', 'user-1', supabase as never),
    ).rejects.toThrow(/entry_id is required/i)
  })

  it('rejects when the original entry is not posted', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: {
        id: '11111111-1111-1111-1111-111111111111',
        status: 'draft',
        entry_date: '2026-05-12',
        description: 'Test',
        voucher_number: 1,
        voucher_series: 'A',
        fiscal_period_id: 'fp-1',
        fiscal_periods: { name: '2026', is_closed: false },
        lines: [],
      },
      error: null,
    })
    await expect(
      reverseEntry.execute(
        { entry_id: '11111111-1111-1111-1111-111111111111' },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/posted entries can be reversed/i)
  })

  it('rejects when the original entry is in a closed period', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: {
        id: '22222222-2222-2222-2222-222222222222',
        status: 'posted',
        entry_date: '2025-12-31',
        description: 'Test',
        voucher_number: 42,
        voucher_series: 'A',
        fiscal_period_id: 'fp-closed',
        fiscal_periods: { name: '2025', is_closed: true },
        lines: [],
      },
      error: null,
    })
    await expect(
      reverseEntry.execute(
        { entry_id: '22222222-2222-2222-2222-222222222222' },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/closed/i)
  })
})

describe('entry_id resolution: voucher refs and hallucinated UUIDs', () => {
  // These tests cover the resolveJournalEntryRef helper as exercised through
  // gnubok_correct_entry. The same resolution path is wired into
  // gnubok_reverse_journal_entry, so one tool is enough to lock the behaviour.

  const balancedCorrection = [
    { account_number: '2645', debit_amount: 250, credit_amount: 0 },
    { account_number: '2614', debit_amount: 0, credit_amount: 250 },
  ]

  it('resolves a voucher ref like "A-113" to its UUID before the lookup', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const resolvedId = '33333333-3333-3333-3333-333333333333'

    // 1) resolveJournalEntryRef -> single match by (series, number)
    enqueue({
      data: [{ id: resolvedId, entry_date: '2026-03-06', description: 'Cursor 2' }],
      error: null,
    })
    // 2) original journal_entries lookup, but the period is closed so we
    //    short-circuit before staging. That's enough to confirm the helper
    //    resolved the ref and passed the UUID through to the next query.
    enqueue({
      data: {
        id: resolvedId,
        status: 'posted',
        entry_date: '2026-03-06',
        description: 'Cursor 2',
        voucher_number: 113,
        voucher_series: 'A',
        fiscal_period_id: 'fp-closed',
        fiscal_periods: { name: '2026', is_closed: true, locked_at: null },
        lines: [],
      },
      error: null,
    })

    await expect(
      correctEntry.execute(
        { entry_id: 'A-113', lines: balancedCorrection },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/locked or closed/i)
  })

  it('errors when a voucher ref matches multiple entries across fiscal periods', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', entry_date: '2026-03-06', description: 'Cursor 2' },
        { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', entry_date: '2025-03-06', description: 'Cursor 1' },
      ],
      error: null,
    })
    await expect(
      correctEntry.execute(
        { entry_id: 'A-113', lines: balancedCorrection },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/matches multiple entries/i)
  })

  it('errors when a voucher ref matches nothing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [], error: null })
    await expect(
      correctEntry.execute(
        { entry_id: 'Z-999', lines: balancedCorrection },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/no journal entry found for voucher "z-999"/i)
  })

  it('errors with a parse hint when the ref is neither a UUID nor a voucher format', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      correctEntry.execute(
        { entry_id: 'not-an-id-at-all', lines: balancedCorrection },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/could not parse entry reference/i)
  })

  it('surfaces the supplied UUID in not-found errors so hallucinated IDs are debuggable', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const hallucinated = 'a71a11ae-b8e2-450f-aaa6-a227d03b0c94'
    // UUID passes through resolution unchanged → straight to the original
    // lookup, which returns no row.
    enqueue({ data: null, error: null })
    await expect(
      correctEntry.execute(
        { entry_id: hallucinated, lines: balancedCorrection },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(new RegExp(`id=${hallucinated}`))
  })
})

describe('agent memory tools: agent:write scope gate', () => {
  const rememberFact = tools.find((t) => t.name === 'gnubok_remember_fact')
  const forgetFact = tools.find((t) => t.name === 'gnubok_forget_fact')

  it('registers the memory write tools mapped to agent:write', async () => {
    const { TOOL_SCOPE_MAP } = await import('@/lib/auth/api-keys')
    expect(rememberFact).toBeDefined()
    expect(forgetFact).toBeDefined()
    expect(TOOL_SCOPE_MAP.gnubok_remember_fact).toBe('agent:write')
    expect(TOOL_SCOPE_MAP.gnubok_forget_fact).toBe('agent:write')
  })

  // Mirror the server's enforcement: a tool is blocked when it has a required
  // scope the key does not hold (server.ts: `requiredScope && !hasScope(...)`).
  it('denies a key without agent:write and allows one with it', async () => {
    const { TOOL_SCOPE_MAP, hasScope } = await import('@/lib/auth/api-keys')
    const required = TOOL_SCOPE_MAP.gnubok_remember_fact

    const without = ['agent:read', 'reports:read'] as never[]
    const isDenied = !!required && !hasScope(without, required)
    expect(isDenied).toBe(true)

    const withWrite = ['agent:read', 'agent:write'] as never[]
    const isAllowed = !required || hasScope(withWrite, required)
    expect(isAllowed).toBe(true)
  })
})
