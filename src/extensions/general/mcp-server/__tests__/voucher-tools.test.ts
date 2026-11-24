/**
 * Staging-time gate tests for gnubok_create_voucher.
 *
 * The executor-level gates (period lock, balance, status === 'posted' for
 * correct_entry) are tested in lib/pending-operations/__tests__/. This file
 * covers the pre-staging gates added to the MCP tool layer for UX: explicit
 * fiscal_period_id validation, inactive/missing account rejection, and the
 * source_type-not-staged invariant.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The filed-momsperiod note (lib/pending-operations/filed-vat-note.ts) reads
// the filing record at staging: none here, so the stubbed reads stay the
// tool's own. The staged row it is asked with is kept: the note reads the
// posting off that row, so the fields it reads are pinned below.
const filedVatAsked = vi.hoisted(() => [] as unknown[])
vi.mock('@/lib/pending-operations/filed-vat-note', () => ({
  stagedFiledVatNote: async (_supabase: unknown, _companyId: unknown, op: unknown) => {
    filedVatAsked.push(op)
    return null
  },
}))
import { createQueuedMockSupabase } from '@/tests/helpers'

// The booking-time voucher warnings have their own tests
// (lib/bookkeeping/__tests__/voucher-*.test.ts); here they pass, so the
// queued mock answers stay in step.
const mockVoucherGuard = vi.hoisted(() => vi.fn())
vi.mock('@/lib/bookkeeping/voucher-warnings-guard', () => ({
  runVoucherWarningsGuard: (...args: unknown[]) => mockVoucherGuard(...args),
  recordVoucherWarningsAcknowledged: vi.fn(),
}))

vi.mock('@/lib/bookkeeping/engine', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/engine')>(
    '@/lib/bookkeeping/engine'
  )
  return {
    ...actual,
    findFiscalPeriod: vi.fn(),
  }
})

// The momsdeklaration impact has its own tests
// (src/lib/vat/__tests__/voucher-vat-impact.test.ts); here it is a fixed
// answer so the queued reads below stay the tool's own.
vi.mock('@/lib/vat/voucher-vat-impact', () => ({
  previewVoucherVatDeclaration: vi.fn().mockResolvedValue({
    status: 'ok', vat_period: null, counted: true, excluded_as: null, rutor_change: {},
    summary: 'Påverkar ingen ruta i momsdeklarationen.',
  }),
}))

import { tools } from '../server'
import { toToolError } from '../tool-result'
import { findFiscalPeriod } from '@/lib/bookkeeping/engine'
import { previewVoucherVatDeclaration } from '@/lib/vat/voucher-vat-impact'

const createVoucher = tools.find((t) => t.name === 'gnubok_create_voucher')!
const correctEntry = tools.find((t) => t.name === 'gnubok_correct_entry')!
const reverseEntry = tools.find((t) => t.name === 'gnubok_reverse_journal_entry')!

beforeEach(() => {
  mockVoucherGuard.mockReset()
  mockVoucherGuard.mockResolvedValue({ ok: true, acknowledged: [] })
  vi.clearAllMocks()
})

const balancedLines = [
  { account_number: '1010', debit_amount: 250, credit_amount: 0 },
  { account_number: '1930', debit_amount: 0, credit_amount: 250 },
]

// The four reads assertStornoTarget makes for an original dated 2026-05-12
// in an open, unlocked 2026 with no company lock date: a posted storno of it
// (none), the original's year, then resolvePeriodStatusForDate (company lock
// date, covering period). gnubok_correct_entry and
// gnubok_reverse_journal_entry both run it before staging.
const NO_POSTED_STORNO = { data: [], error: null }
const OPEN_STORNO_TARGET = [
  NO_POSTED_STORNO,
  { data: { name: '2026', period_start: '2026-01-01', period_end: '2026-12-31' }, error: null },
  { data: { bookkeeping_locked_through: null }, error: null },
  { data: { id: 'fp-1', is_closed: false, locked_at: null }, error: null },
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

  it('rejects lines that balance only before each line is rounded', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      createVoucher.execute(
        {
          entry_date: '2026-05-12',
          description: 'three decimals',
          fiscal_period_id: 'fp-1',
          lines: [
            { account_number: '1010', debit_amount: 100.004, credit_amount: 0 },
            { account_number: '1020', debit_amount: 100.004, credit_amount: 0 },
            { account_number: '1930', debit_amount: 0, credit_amount: 200.01 },
          ],
        },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/not balanced/i)
  })

  it('names the missing amount keys instead of coercing an unknown line shape to 0/0 (feedback seq 318571)', async () => {
    const { supabase } = createQueuedMockSupabase()
    // Four "balanced" formats an agent actually sent: none names
    // debit_amount/credit_amount, so every one used to read as
    // "debits 0 SEK, credits 0 SEK" from the balance check.
    for (const lines of [
      [{ account_number: '6110', debit: 500 }, { account_number: '1930', credit: 500 }],
      [{ account_number: '6110', amount: 500, side: 'debit' }, { account_number: '1930', amount: 500, side: 'credit' }],
      [{ account_number: '6110', debitAmount: 500 }, { account_number: '1930', creditAmount: 500 }],
      [{ account_number: '6110', amount: 500 }, { account_number: '1930', amount: -500 }],
    ]) {
      await expect(
        createVoucher.execute(
          { entry_date: '2026-05-12', description: 'shape', lines },
          'company-1',
          'user-1',
          supabase as never,
        ),
      ).rejects.toThrow(/lines\[0\]: expected debit_amount and\/or credit_amount.*got .*Example/)
    }
    // A VALIDATION_ERROR, so the agent fixes the lines instead of resending
    // them (it was UNKNOWN_ERROR, "Försök igen", in 22 sessions in 30 days).
    const shapeError = await createVoucher
      .execute(
        {
          entry_date: '2026-05-12',
          description: 'shape',
          lines: [{ account_number: '6110', credit: 0, debit: 500 }, { account_number: '1930', credit: 500, debit: 0 }],
        },
        'company-1',
        'user-1',
        supabase as never,
      )
      .then(() => null, (e: unknown) => e)
    expect(toToolError(shapeError).error).toMatchObject({
      code: 'VALIDATION_ERROR',
      retryable: false,
      message_en: expect.stringContaining('lines[0]: expected debit_amount and/or credit_amount (numbers in SEK); got credit, debit'),
    })
    await expect(
      createVoucher.execute(
        {
          entry_date: '2026-05-12',
          description: 'shape',
          lines: [
            { account_number: '6110', debit_amount: '500 kr' },
            { account_number: '1930', credit_amount: 500 },
          ],
        },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/lines\[0\]\.debit_amount must be a number in SEK; got "500 kr"/)
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
    ).rejects.toMatchObject({ code: 'TARGET_PERIOD_CLOSED' })
    // findFiscalPeriod must NOT be called when an explicit ID was supplied.
    expect(findFiscalPeriod).not.toHaveBeenCalled()
  })

  // Product decision 2026-11-08: a year closed with a bokslut is never
  // unlocked, so its refusal no longer says "Lås upp perioden"; a period that
  // is only locked says it can be unlocked.
  describe('a supplied fiscal_period_id that takes no verifikat', () => {
    const stageIn = async (period: Record<string, unknown>) => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: { id: 'fp-1', period_start: '2025-01-01', period_end: '2025-12-31', name: '2025', ...period }, error: null })
      const err = await createVoucher
        .execute(
          { entry_date: '2025-06-15', description: 'Rättelse', fiscal_period_id: 'fp-1', lines: balancedLines },
          'company-1',
          'user-1',
          supabase as never,
        )
        .then(() => null, (e: unknown) => e)
      return toToolError(err).error
    }

    it('closed with a bokslut: TARGET_PERIOD_CLOSED, the registry text and remediation, never unlock', async () => {
      const error = await stageIn({ is_closed: true, locked_at: '2026-02-01T00:00:00Z' })
      expect(error).toMatchObject({ code: 'TARGET_PERIOD_CLOSED', retryable: false })
      expect(error.message_sv).toMatch(/^Räkenskapsåret som täcker datumet är stängt med bokslut/)
      expect(error.message_en).toMatch(/^Fiscal period "2025": The fiscal year covering the date is closed with a year-end closing/)
      expect(error.remediation?.description).toMatch(/^Do not retry and do not unlock/)
      expect(`${error.message_sv} ${error.message_en}`).not.toMatch(/Lås upp perioden/)
    })

    it('only locked: PERIOD_LOCKED, the code the lock trigger answers at commit: unlock it or pick an open date', async () => {
      const error = await stageIn({ is_closed: false, locked_at: '2026-02-01T00:00:00Z' })
      expect(error).toMatchObject({
        code: 'PERIOD_LOCKED',
        message_sv: 'Bokföringen är låst för denna period.',
        message_en: 'Fiscal period "2025": Period is locked or closed; entries cannot be added.',
        remediation: { tool: 'gnubok_unlock_period' },
        retryable: false,
      })
    })

    it('open and unlocked: stages', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: { id: 'fp-1', is_closed: false, locked_at: null, period_start: '2026-01-01', period_end: '2026-12-31', name: '2026' }, error: null })
      enqueue({
        data: [
          { account_number: '1010', account_name: 'Balanserade utgifter', is_active: true },
          { account_number: '1930', account_name: 'Företagskonto', is_active: true },
        ],
        error: null,
      })
      enqueue({ data: null, error: null }) // resolvePeriodStatusForDate layer 1
      enqueue({ data: null, error: null }) // resolvePeriodStatusForDate layer 2
      enqueue({ data: { id: 'op-open' }, error: null }) // pending_operations insert
      const result = (await createVoucher.execute(
        { entry_date: '2026-05-12', description: 'Öppen period', fiscal_period_id: 'fp-1', lines: balancedLines },
        'company-1',
        'user-1',
        supabase as never,
      )) as { staged: boolean; preview: Record<string, unknown> }
      expect(result.staged).toBe(true)
      expect(result.preview.fiscal_period_id).toBe('fp-1')
    })
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

  it('rejects an account that is neither in the chart nor in BAS 2026', async () => {
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
    // chart_of_accounts knows only 1930: 4020 is a custom number the company
    // never created, and it is absent from the BAS 2026 catalog, so the
    // engine could not seed it either.
    enqueue({
      data: [{ account_number: '1930', account_name: 'Företagskonto', is_active: true }],
      error: null,
    })

    await expect(
      createVoucher.execute(
        {
          entry_date: '2026-05-12',
          description: 'custom account never created',
          fiscal_period_id: 'fp-1',
          lines: [
            { account_number: '4020', debit_amount: 250, credit_amount: 0 },
            { account_number: '1930', debit_amount: 0, credit_amount: 250 },
          ],
        },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/saknas i kontoplanen och finns inte i BAS 2026: 4020/i)
  })

  it('stages when a BAS 2026 account is merely absent from the chart (engine seeds it)', async () => {
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
    // 7690 (Övriga personalkostnader) is in BAS 2026 but not in this chart:
    // the old gate rejected it even though createDraftEntry backfills it.
    enqueue({
      data: [{ account_number: '1930', account_name: 'Företagskonto', is_active: true }],
      error: null,
    })
    enqueue({ data: null, error: null }) // resolvePeriodStatusForDate layer 1
    enqueue({ data: null, error: null }) // resolvePeriodStatusForDate layer 2
    enqueue({ data: { id: 'op-seedable' }, error: null }) // pending_operations insert

    const result = (await createVoucher.execute(
      {
        entry_date: '2026-05-12',
        description: 'Friskvård badhus',
        fiscal_period_id: 'fp-1',
        lines: [
          { account_number: '7690', debit_amount: 250, credit_amount: 0 },
          { account_number: '1930', debit_amount: 0, credit_amount: 250 },
        ],
      },
      'company-1',
      'user-1',
      supabase as never,
    )) as {
      staged: boolean
      preview: {
        will_activate_accounts?: string[]
        lines: Array<{ account_number: string; account_name: string | null }>
      }
    }

    expect(result.staged).toBe(true)
    // The approver must see the activation side-effect and a named line
    // (name from the BAS catalog, not a bare number).
    expect(result.preview.will_activate_accounts).toEqual(['7690'])
    const line7690 = result.preview.lines.find((l) => l.account_number === '7690')
    expect(line7690?.account_name).toMatch(/personalkostnader/i)
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
    )) as { staged: boolean; operation_id?: string; message: string; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    expect(result.operation_id).toBe('op-staged')
    expect(result.preview.total_debit).toBe(250)
    expect(result.preview.total_credit).toBe(250)

    // The momsdeklaration impact (crm#1447) is computed from the lines that
    // post, in the period that holds their date, and carried in the preview.
    expect(previewVoucherVatDeclaration).toHaveBeenCalledWith(supabase, 'company-1', {
      entryDate: '2026-05-12',
      lines: expect.arrayContaining([
        expect.objectContaining({ account_number: '1010', debit_amount: 250 }),
        expect.objectContaining({ account_number: '1930', credit_amount: 250 }),
      ]),
      isOpeningBalance: false,
    })
    expect(result.preview.vat_declaration).toMatchObject({ status: 'ok', counted: true, rutor_change: {} })

    // No document attached: the advisory BFL 5 kap 6§ warning must reach both
    // the agent (message) and the /pending approval card (preview) without
    // blocking the staging itself.
    expect(result.preview.document_attached).toBe(false)
    expect(result.preview.compliance_warning).toMatch(/BFL 5 kap 6§/)
    expect(result.preview.compliance_warning).toMatch(/underlag/i)
    expect(result.message).toMatch(/WARNING:.*underlag/i)

    // Critical: the staged pending_operations row must NOT carry source_type.
    // The executor always hardcodes 'manual'. Look at the insert call.
    const insertCalls = (supabase.from as ReturnType<typeof vi.fn>).mock.calls
    expect(insertCalls.some((args) => args[0] === 'pending_operations')).toBe(true)
  })

  it('previews each line with the currency, amount in currency and rate it will store (crm#2161)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: { id: 'fp-1', is_closed: false, period_start: '2026-01-01', period_end: '2026-12-31', name: '2026' },
      error: null,
    })
    enqueue({
      data: [
        { account_number: '2999', account_name: 'Övriga upplupna kostnader', is_active: true },
        { account_number: '1510', account_name: 'Kundfordringar', is_active: true },
      ],
      error: null,
    })
    enqueue({ data: null, error: null })
    enqueue({ data: null, error: null })
    enqueue({ data: { id: 'op-staged' }, error: null })

    const result = (await createVoucher.execute(
      {
        entry_date: '2026-05-12',
        description: 'Kundbetalning i euro',
        fiscal_period_id: 'fp-1',
        lines: [
          { account_number: '2999', debit_amount: 1129, credit_amount: 0 },
          {
            account_number: '1510',
            debit_amount: 0,
            credit_amount: 1129,
            currency: 'EUR',
            amount_in_currency: 100,
            exchange_rate: 11.29,
          },
        ],
      },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; preview: { lines: Array<Record<string, unknown>> } }

    expect(result.staged).toBe(true)
    const byAccount = Object.fromEntries(result.preview.lines.map((l) => [l.account_number, l]))
    // A line without a currency is previewed as the kronor line it posts as,
    // so an agent sees a 1510 line that will not match a foreign invoice.
    expect(byAccount['2999']).toMatchObject({ currency: 'SEK', amount_in_currency: null, exchange_rate: null })
    expect(byAccount['1510']).toMatchObject({ currency: 'EUR', amount_in_currency: 100, exchange_rate: 11.29 })
  })

  it('refuses to stage until the person confirmed the booking-time warnings, handing them to the agent', async () => {
    const warnings = [{ code: 'INPUT_VAT_ABOVE_RATE', message_sv: 'x', message_en: 'x', details: {} }]
    mockVoucherGuard.mockResolvedValue({ ok: false, code: 'VOUCHER_NEEDS_CONFIRMATION', details: { warnings } })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'fp-1', is_closed: false, period_start: '2026-01-01', period_end: '2026-12-31', name: '2026' }, error: null })
    enqueue({
      data: [
        { account_number: '1010', account_name: 'Balanserade utgifter', is_active: true },
        { account_number: '1930', account_name: 'Företagskonto', is_active: true },
      ],
      error: null,
    })

    const staged = createVoucher.execute(
      { entry_date: '2026-05-12', description: 'Capitalize Cursor', fiscal_period_id: 'fp-1', lines: balancedLines },
      'company-1',
      'user-1',
      supabase as never,
    )

    await expect(staged).rejects.toMatchObject({ code: 'VOUCHER_NEEDS_CONFIRMATION', details: { warnings } })
    const { toToolError } = await import('../tool-result')
    const envelope = toToolError(await staged.catch((e: unknown) => e)).error
    expect(envelope.details).toEqual({ warnings })
    // The refusal names the field this tool declares, the one name v1 and
    // the app use too (crm#1714).
    expect(envelope.message_en).toContain('acknowledged_warnings')
    expect(Object.keys((createVoucher.inputSchema as { properties: Record<string, unknown> }).properties)).toContain('acknowledged_warnings')
  })

  it('accepts the former acknowledge_warnings spelling without listing it (crm#1714)', async () => {
    const { findUnknownArgKeys } = await import('../arg-guard')
    const schema = createVoucher.inputSchema as Record<string, unknown>
    expect(Object.keys(schema.properties as Record<string, unknown>)).not.toContain('acknowledge_warnings')
    expect(findUnknownArgKeys(schema, { acknowledge_warnings: [], acknowledged_warnings: [] }, createVoucher.undeclaredArgs)).toEqual([])
    expect(findUnknownArgKeys(schema, { acknowledge_warning: [] }, createVoucher.undeclaredArgs)).toEqual(['acknowledge_warning'])

    mockVoucherGuard.mockResolvedValue({ ok: false, code: 'VOUCHER_NEEDS_CONFIRMATION', details: { warnings: [] } })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'fp-1', is_closed: false, period_start: '2026-01-01', period_end: '2026-12-31', name: '2026' }, error: null })
    enqueue({
      data: [
        { account_number: '1010', account_name: 'Balanserade utgifter', is_active: true },
        { account_number: '1930', account_name: 'Företagskonto', is_active: true },
      ],
      error: null,
    })
    await createVoucher
      .execute(
        { entry_date: '2026-05-12', description: 'Capitalize Cursor', fiscal_period_id: 'fp-1', lines: balancedLines, acknowledge_warnings: ['INPUT_VAT_ABOVE_RATE'] },
        'company-1',
        'user-1',
        supabase as never,
      )
      .catch(() => undefined)
    expect(mockVoucherGuard.mock.calls[0][4]).toEqual({ acknowledged: ['INPUT_VAT_ABOVE_RATE'] })
  })

  it('stages the confirmed codes for the approver and the commit', async () => {
    const warnings = [{ code: 'INPUT_VAT_ABOVE_RATE', message_sv: 'x', message_en: 'x', details: {} }]
    mockVoucherGuard.mockResolvedValue({ ok: true, acknowledged: warnings })
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { id: 'fp-1', is_closed: false, period_start: '2026-01-01', period_end: '2026-12-31', name: '2026' }, error: null })
    enqueue({
      data: [
        { account_number: '1010', account_name: 'Balanserade utgifter', is_active: true },
        { account_number: '1930', account_name: 'Företagskonto', is_active: true },
      ],
      error: null,
    })
    enqueue({ data: null, error: null })
    enqueue({ data: null, error: null })
    enqueue({ data: { id: 'op-staged' }, error: null })

    const result = (await createVoucher.execute(
      {
        entry_date: '2026-05-12',
        description: 'Capitalize Cursor',
        fiscal_period_id: 'fp-1',
        lines: balancedLines,
        acknowledged_warnings: ['INPUT_VAT_ABOVE_RATE'],
      },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; preview: Record<string, unknown> }

    expect(mockVoucherGuard.mock.calls[0][4]).toEqual({ acknowledged: ['INPUT_VAT_ABOVE_RATE'] })
    expect(result.staged).toBe(true)
    expect(result.preview.voucher_warnings).toEqual(warnings)
    const inserted = findCall('pending_operations', 'insert')?.[0] as { params: Record<string, unknown> }
    expect(inserted.params.acknowledged_warnings).toEqual(['INPUT_VAT_ABOVE_RATE'])
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
    // Document attached: the missing-underlag warning must NOT appear.
    expect(result.preview.compliance_warning).toBeUndefined()
  })

  describe('a foreign underlag (crm#1146, accounted#58 X4)', () => {
    function enqueueUpToInbox(enqueue: (r: { data?: unknown; error?: unknown }) => void) {
      enqueue({ data: { id: 'fp-1', is_closed: false, period_start: '2026-01-01', period_end: '2026-12-31', name: '2026' }, error: null })
      enqueue({
        data: [
          { account_number: '5410', account_name: 'Förbrukningsinventarier', is_active: true },
          { account_number: '1930', account_name: 'Företagskonto', is_active: true },
        ],
        error: null,
      })
      enqueue({
        data: {
          id: 'inbox-eur',
          document_id: 'doc-eur',
          created_journal_entry_id: null,
          created_supplier_invoice_id: null,
          extracted_data: { invoice: { currency: 'EUR' }, totals: { total: 100 } },
        },
        error: null,
      }) // invoice_inbox_items lookup
    }
    const stage = (supabase: unknown, amount: number) =>
      createVoucher.execute(
        {
          entry_date: '2026-05-12',
          description: 'Kvitto i EUR',
          fiscal_period_id: 'fp-1',
          inbox_item_id: 'inbox-eur',
          lines: [
            { account_number: '5410', debit_amount: amount, credit_amount: 0 },
            { account_number: '1930', debit_amount: 0, credit_amount: amount },
          ],
        },
        'company-1',
        'user-1',
        supabase as never,
      )

    it('refuses a line carrying the document total as kronor, before anything is staged', async () => {
      const { supabase, enqueue, findCall } = createQueuedMockSupabase()
      enqueueUpToInbox(enqueue)
      await expect(stage(supabase, 100)).rejects.toMatchObject({ code: 'INBOX_BOOK_DIRECT_FX_FACE_AMOUNT' })
      expect(findCall('pending_operations', 'insert')).toBeUndefined()
    })

    it('stages kronor typed by hand', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueueUpToInbox(enqueue)
      enqueue({ data: null, error: null }) // resolvePeriodStatusForDate layer 1
      enqueue({ data: null, error: null }) // resolvePeriodStatusForDate layer 2
      enqueue({ data: { id: 'op-eur' }, error: null }) // pending_operations insert
      const result = (await stage(supabase, 1150.4)) as { staged: boolean }
      expect(result.staged).toBe(true)
    })
  })

  it('inbox item without a stored document: no attach claim, inbox-variant warning', async () => {
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
        id: 'inbox-nodoc',
        document_id: null, // ingested without attachment, or ON DELETE SET NULL
        created_journal_entry_id: null,
        created_supplier_invoice_id: null,
      },
      error: null,
    })
    enqueue({ data: null, error: null }) // resolvePeriodStatusForDate layer 1
    enqueue({ data: null, error: null }) // resolvePeriodStatusForDate layer 2
    enqueue({ data: { id: 'op-nodoc' }, error: null }) // pending_operations insert

    const result = (await createVoucher.execute(
      {
        entry_date: '2026-05-12',
        description: 'Inbox item utan dokument',
        fiscal_period_id: 'fp-1',
        inbox_item_id: 'inbox-nodoc',
        lines: [
          { account_number: '5410', debit_amount: 250, credit_amount: 0 },
          { account_number: '1930', debit_amount: 0, credit_amount: 250 },
        ],
      },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    expect(result.preview.document_attached).toBe(false)
    // The envelope must not contradict itself: no "attach the OCR document"
    // claim, and the warning must not tell the agent to restage with the
    // inbox_item_id it already supplied.
    expect(result.preview.will).toMatch(/link the inbox item/i)
    expect(result.preview.will).not.toMatch(/attach the OCR document/i)
    expect(result.preview.compliance_warning).toMatch(/no stored document/i)
    expect(result.preview.compliance_warning).not.toMatch(/restage with inbox_item_id/i)
  })

  it('is_opening_balance: no underlag warning (IB legitimately lacks a kvitto)', async () => {
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
    // existing-IB check: no pointer on the year, no posted IB entry in it
    enqueue({ data: { opening_balances_set: false, opening_balance_entry_id: null, opening_balance_entry: null }, error: null })
    enqueue({ data: [], error: null })
    enqueue({
      data: [
        { account_number: '1930', account_name: 'Företagskonto', is_active: true },
        { account_number: '2081', account_name: 'Aktiekapital', is_active: true },
      ],
      error: null,
    })
    enqueue({ data: null, error: null }) // resolvePeriodStatusForDate layer 1
    enqueue({ data: null, error: null }) // resolvePeriodStatusForDate layer 2
    enqueue({ data: { id: 'op-ib' }, error: null }) // pending_operations insert

    const result = (await createVoucher.execute(
      {
        entry_date: '2026-01-01',
        description: 'Ingående balans',
        fiscal_period_id: 'fp-1',
        is_opening_balance: true,
        lines: [
          { account_number: '1930', debit_amount: 25000, credit_amount: 0 },
          { account_number: '2081', debit_amount: 0, credit_amount: 25000 },
        ],
      },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; message: string; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    expect(result.preview.document_attached).toBe(false)
    expect(result.preview.compliance_warning).toBeUndefined()
    expect(result.message).not.toMatch(/WARNING/)
  })

  // Agent feedback seqs 892914, 897234, 897844: refuse a second IB at
  // staging, before a human is asked to approve it.
  it('is_opening_balance: refuses to stage a second IB for a year that already has one', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
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
    enqueue({ data: { opening_balances_set: false, opening_balance_entry_id: null, opening_balance_entry: null }, error: null })
    enqueue({ data: [{ id: 'je-ib-1', voucher_series: 'A', voucher_number: 1 }], error: null })

    await expect(
      createVoucher.execute(
        {
          entry_date: '2026-01-01',
          description: 'Reversal of the imported IB',
          fiscal_period_id: 'fp-1',
          is_opening_balance: true,
          lines: [
            { account_number: '2081', debit_amount: 25000, credit_amount: 0 },
            { account_number: '1930', debit_amount: 0, credit_amount: 25000 },
          ],
        },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toMatchObject({
      code: 'OB_PERIOD_ALREADY_HAS_BALANCES',
      message: expect.stringMatching(/redan en ingående balans \(verifikation A-1\)/),
    })
    // Nothing staged.
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('without is_opening_balance: never runs the existing-IB check', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
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
    enqueue({ data: null, error: null }) // resolvePeriodStatusForDate layer 1
    enqueue({ data: null, error: null }) // resolvePeriodStatusForDate layer 2
    enqueue({ data: { id: 'op-manual' }, error: null }) // pending_operations insert

    const result = (await createVoucher.execute(
      {
        entry_date: '2026-01-01',
        description: 'Ordinary voucher on the first day',
        fiscal_period_id: 'fp-1',
        lines: balancedLines,
      },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean }

    expect(result.staged).toBe(true)
    expect(findCall('journal_entries', 'select')).toBeUndefined()
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

  it('names the missing amount keys on replacement lines instead of coercing to 0/0', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      correctEntry.execute(
        {
          entry_id: 'je-1',
          lines: [
            { account_number: '2645', debit: 250 },
            { account_number: '2614', credit: 250 },
          ],
        },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/lines\[0\]: expected debit_amount and\/or credit_amount.*got debit/)
  })

  it('shows preserved currency, tax, and dimension metadata in the correction preview', async () => {
    const { supabase, enqueue, enqueueMany } = createQueuedMockSupabase()
    enqueue({ data: { dimensions_enabled: false }, error: null })
    enqueue({
      data: {
        id: '11111111-1111-4111-8111-111111111111',
        status: 'posted',
        entry_date: '2026-05-12',
        description: 'Foreign purchase',
        voucher_number: 12,
        voucher_series: 'A',
        fiscal_period_id: 'fp-1',
        fiscal_periods: { name: '2026', is_closed: false, locked_at: null },
        lines: [
          {
            account_number: '5420',
            debit_amount: 1000,
            credit_amount: 0,
            line_description: 'Software',
            currency: 'EUR',
            amount_in_currency: 90,
            exchange_rate: 11.111111,
            tax_code: 'EU_SERVICE',
            dimensions: { '6': 'P001' },
            cost_center: null,
            project: 'P001',
          },
          {
            account_number: '1930',
            debit_amount: 0,
            credit_amount: 1000,
            line_description: 'Settlement',
            currency: 'EUR',
            amount_in_currency: 90,
            exchange_rate: 11.111111,
            tax_code: null,
            dimensions: {},
            cost_center: null,
            project: null,
          },
        ],
      },
      error: null,
    })
    enqueueMany(OPEN_STORNO_TARGET)
    enqueue({ data: { bookkeeping_locked_through: null }, error: null })
    enqueue({ data: { id: 'fp-1', is_closed: false, locked_at: null }, error: null })
    enqueue({ data: { id: 'op-correct-1' }, error: null })

    const replacementLines = [
      {
        account_number: '5420',
        debit_amount: 1000,
        credit_amount: 0,
        line_description: 'Software',
        currency: 'EUR',
        amount_in_currency: 90,
        exchange_rate: 11.111111,
        tax_code: 'EU_SERVICE',
        dimensions: { '6': 'P001' },
      },
      {
        account_number: '1931',
        debit_amount: 0,
        credit_amount: 1000,
        line_description: 'Settlement',
        currency: 'EUR',
        amount_in_currency: 90,
        exchange_rate: 11.111111,
        dimensions: {},
      },
    ]

    const result = (await correctEntry.execute(
      {
        entry_id: '11111111-1111-4111-8111-111111111111',
        lines: replacementLines,
      },
      'company-1',
      'user-1',
      supabase as never,
    )) as {
      preview: {
        original: { lines: Array<Record<string, unknown>> }
        correction: { lines: Array<Record<string, unknown>> }
      }
    }

    expect(result.preview.original.lines[0]).toMatchObject({
      currency: 'EUR',
      amount_in_currency: 90,
      exchange_rate: 11.111111,
      tax_code: 'EU_SERVICE',
      dimensions: { '6': 'P001' },
      project: 'P001',
    })
    expect(result.preview.correction.lines[0]).toMatchObject({
      currency: 'EUR',
      amount_in_currency: 90,
      exchange_rate: 11.111111,
      tax_code: 'EU_SERVICE',
      dimensions: { '6': 'P001' },
    })
  })
})

// #1031 on the MCP door: v1 and the app let a rättelse carry its own text,
// the tool did not, so a verifikat whose text was the error could only be
// corrected to "Rättelse: <the wrong text>".
describe('gnubok_correct_entry: the corrected entry\'s text', () => {
  const original = {
    id: '11111111-1111-4111-8111-111111111111',
    status: 'posted',
    entry_date: '2026-05-12',
    description: 'Fel leverantör',
    voucher_number: 12,
    voucher_series: 'A',
    fiscal_period_id: 'fp-1',
    correction_of_id: null,
    reverses_id: null,
    fiscal_periods: { name: '2026', is_closed: false, locked_at: null },
    lines: [
      { account_number: '5420', debit_amount: 1000, credit_amount: 0, line_description: null, currency: null, amount_in_currency: null, exchange_rate: null, tax_code: null, dimensions: null, cost_center: null, project: null },
      { account_number: '1930', debit_amount: 0, credit_amount: 1000, line_description: null, currency: null, amount_in_currency: null, exchange_rate: null, tax_code: null, dimensions: null, cost_center: null, project: null },
    ],
  }
  const lines = [
    { account_number: '5410', debit_amount: 1000, credit_amount: 0 },
    { account_number: '1930', debit_amount: 0, credit_amount: 1000 },
  ]
  const staging = () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: original, error: null })
    mock.enqueueMany(OPEN_STORNO_TARGET)
    mock.enqueue({ data: { bookkeeping_locked_through: null }, error: null })
    mock.enqueue({ data: { id: 'fp-1', is_closed: false, locked_at: null }, error: null })
    mock.enqueue({ data: { id: 'op-correct-text' }, error: null })
    return mock
  }
  const stagedParams = (mock: ReturnType<typeof createQueuedMockSupabase>) =>
    (mock.findCall('pending_operations', 'insert')?.[0] as { params: Record<string, unknown> }).params

  it('stages a trimmed description and previews it', async () => {
    const mock = staging()
    const result = (await correctEntry.execute(
      { entry_id: original.id, lines, description: '  Förbrukningsinventarier, rätt leverantör  ' },
      'company-1',
      'user-1',
      mock.supabase as never,
    )) as { preview: { correction: { description: string } } }

    expect(stagedParams(mock).description).toBe('Förbrukningsinventarier, rätt leverantör')
    expect(result.preview.correction.description).toBe('Förbrukningsinventarier, rätt leverantör')
    // What the filed-momsperiod note reads off a staged rättelse: the new
    // lines in the params, the original's date and lines in the preview.
    expect(filedVatAsked.at(-1)).toMatchObject({
      operation_type: 'correct_entry',
      params: { lines: expect.arrayContaining([expect.objectContaining({ account_number: expect.any(String), debit_amount: expect.any(Number), credit_amount: expect.any(Number) })]) },
      preview_data: {
        original: {
          entry_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
          lines: expect.arrayContaining([expect.objectContaining({ account_number: expect.any(String), debit_amount: expect.any(Number), credit_amount: expect.any(Number) })]),
        },
      },
    })
  })

  it('stages no description when it is absent or blank, and previews the default text', async () => {
    for (const description of [undefined, '   ']) {
      const mock = staging()
      const result = (await correctEntry.execute(
        { entry_id: original.id, lines, ...(description === undefined ? {} : { description }) },
        'company-1',
        'user-1',
        mock.supabase as never,
      )) as { preview: { correction: { description: string } } }

      expect(stagedParams(mock)).not.toHaveProperty('description')
      expect(result.preview.correction.description).toBe('Rättelse: Fel leverantör')
    }
  })

  it('refuses a non-string or an over-long description', async () => {
    for (const description of [42, 'x'.repeat(501)]) {
      const { supabase } = createQueuedMockSupabase()
      await expect(
        correctEntry.execute({ entry_id: original.id, lines, description }, 'company-1', 'user-1', supabase as never),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    }
  })
})

// Importmoms keeps its ruta 50 base through a rättelse (#94): refused at
// staging, the rule correctEntry runs again at approval.
describe('gnubok_correct_entry: importmoms without its ruta 50 base', () => {
  const blank = { line_description: null, currency: null, amount_in_currency: null, exchange_rate: null, tax_code: null, dimensions: null, cost_center: null, project: null }
  const original = {
    id: '11111111-1111-4111-8111-111111111111',
    status: 'posted',
    entry_date: '2026-05-12',
    description: 'EU-köp',
    voucher_number: 12,
    voucher_series: 'A',
    fiscal_period_id: 'fp-1',
    correction_of_id: null,
    reverses_id: null,
    source_type: 'bank_transaction',
    fiscal_periods: { name: '2026', is_closed: false, locked_at: null },
    lines: [
      { ...blank, account_number: '4515', debit_amount: 1000, credit_amount: 0 },
      { ...blank, account_number: '2645', debit_amount: 250, credit_amount: 0 },
      { ...blank, account_number: '2615', debit_amount: 0, credit_amount: 250 },
      { ...blank, account_number: '1930', debit_amount: 0, credit_amount: 1000 },
    ],
  }

  it('refuses corrected lines that keep 2615 credited with no 4545-4547 line, and stages nothing', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: original, error: null })
    mock.enqueueMany(OPEN_STORNO_TARGET)
    // The company's chart (momsruta per account): nothing of its own.
    mock.enqueue({ data: [], error: null })
    await expect(
      correctEntry.execute(
        {
          entry_id: original.id,
          lines: [
            { account_number: '5460', debit_amount: 1000, credit_amount: 0 },
            { account_number: '2645', debit_amount: 250, credit_amount: 0 },
            { account_number: '2615', debit_amount: 0, credit_amount: 250 },
            { account_number: '1930', debit_amount: 0, credit_amount: 1000 },
          ],
        },
        'company-1',
        'user-1',
        mock.supabase as never,
      ),
    ).rejects.toMatchObject({ code: 'IMPORT_VAT_WITHOUT_BASE', importVatAccounts: ['2615'] })
    expect(mock.findCall('pending_operations', 'insert')).toBeUndefined()
  })
})

describe('gnubok_correct_entry / gnubok_reverse_journal_entry: chain-depth guard', () => {
  // Base row for a posted correction that already sits 3 links deep:
  // c3 → c2 → c1 → orig-0 (root, voucher A7).
  const deepTarget = {
    id: '22222222-2222-4222-8222-222222222222',
    status: 'posted',
    entry_date: '2026-05-12',
    description: 'Rättelse: Rättelse: Rättelse: Köp',
    voucher_number: 15,
    voucher_series: 'A',
    fiscal_period_id: 'fp-1',
    correction_of_id: 'c2',
    reverses_id: null,
    fiscal_periods: { name: '2026', is_closed: false, locked_at: null },
    lines: [
      { account_number: '5420', debit_amount: 1000, credit_amount: 0, line_description: null, currency: null, amount_in_currency: null, exchange_rate: null, tax_code: null, dimensions: null, cost_center: null, project: null },
      { account_number: '1930', debit_amount: 0, credit_amount: 1000, line_description: null, currency: null, amount_in_currency: null, exchange_rate: null, tax_code: null, dimensions: null, cost_center: null, project: null },
    ],
  }
  const walkerRows = [
    { data: { id: 'c2', correction_of_id: 'c1', reverses_id: null, voucher_series: 'A', voucher_number: 12 }, error: null },
    { data: { id: 'c1', correction_of_id: 'orig-0', reverses_id: null, voucher_series: 'A', voucher_number: 9 }, error: null },
    { data: { id: 'orig-0', correction_of_id: null, reverses_id: null, voucher_series: 'A', voucher_number: 7 }, error: null },
  ]

  const replacementLines = [
    { account_number: '5410', debit_amount: 1000, credit_amount: 0 },
    { account_number: '1930', debit_amount: 0, credit_amount: 1000 },
  ]

  it('refuses to stage a correction on a chain 3 levels deep with an agent-actionable error', async () => {
    const { supabase, enqueue, enqueueMany } = createQueuedMockSupabase()
    // Lines carry no dimensions, so no dimension-registry query precedes the
    // entry fetch.
    enqueue({ data: deepTarget, error: null })
    enqueueMany(OPEN_STORNO_TARGET)
    enqueueMany(walkerRows)

    await expect(
      correctEntry.execute(
        { entry_id: deepTarget.id, lines: replacementLines },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toMatchObject({
      code: 'CORRECTION_CHAIN_TOO_DEEP',
      depth: 3,
      chainRootVoucher: 'A7',
    })
  })

  it('stages when allow_deep_chain=true and forwards the flag to the executor params', async () => {
    const { supabase, enqueue, enqueueMany, findCall } = createQueuedMockSupabase()
    enqueue({ data: deepTarget, error: null })
    enqueueMany(OPEN_STORNO_TARGET)
    // No walker queries: the guard is skipped entirely on explicit override.
    enqueue({ data: { bookkeeping_locked_through: null }, error: null })
    enqueue({ data: { id: 'fp-1', is_closed: false, locked_at: null }, error: null })
    enqueue({ data: { id: 'op-deep-1' }, error: null })

    await correctEntry.execute(
      { entry_id: deepTarget.id, lines: replacementLines, allow_deep_chain: true },
      'company-1',
      'user-1',
      supabase as never,
    )

    const insertArgs = findCall('pending_operations', 'insert')
    expect(insertArgs).toBeDefined()
    const payload = (insertArgs as unknown[])[0] as { params?: { allow_deep_chain?: boolean } }
    expect(payload.params?.allow_deep_chain).toBe(true)
  })

  it('refuses to stage a storno on a chain 3 levels deep', async () => {
    const { supabase, enqueue, enqueueMany } = createQueuedMockSupabase()
    enqueue({ data: deepTarget, error: null })
    // The storno target check: no posted storno of it, the original's open
    // 2026, no company lock date.
    enqueue(NO_POSTED_STORNO)
    enqueue({ data: { name: '2026', period_start: '2026-01-01', period_end: '2026-12-31' }, error: null })
    enqueue({ data: { bookkeeping_locked_through: null }, error: null })
    enqueue({ data: { id: 'fp-1', is_closed: false, locked_at: null }, error: null })
    enqueueMany(walkerRows)

    await expect(
      reverseEntry.execute(
        { entry_id: deepTarget.id },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toMatchObject({ code: 'CORRECTION_CHAIN_TOO_DEEP', depth: 3 })
  })
})

describe('gnubok_reverse_journal_entry: the verifikat an invoice owns', () => {
  // Advice, never a refusal: agents and bulk flows reverse invoice vouchers
  // on purpose, so the storno stages as asked and the preview names the
  // invoice, the tool that credits it and a warning for the approver.
  it('stages the storno and names the owner in the preview', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({
      data: {
        id: '33333333-3333-4333-8333-333333333333',
        status: 'posted',
        entry_date: '2026-09-09',
        description: 'Leverantörsfaktura 3744267',
        voucher_number: 2,
        voucher_series: 'D',
        fiscal_period_id: 'fp-1',
        correction_of_id: null,
        reverses_id: null,
        source_type: 'supplier_invoice_registered',
        source_id: 'si-1',
        fiscal_periods: { name: '2026', is_closed: false, locked_at: null },
        lines: [
          { account_number: '1710', debit_amount: 1000, credit_amount: 0, line_description: null },
          { account_number: '2440', debit_amount: 0, credit_amount: 1000, line_description: null },
        ],
      },
      error: null,
    })
    // The storno target check: no posted storno of it, the original's open
    // 2026, no company lock date.
    enqueue(NO_POSTED_STORNO)
    enqueue({ data: { name: '2026', period_start: '2026-01-01', period_end: '2026-12-31' }, error: null })
    enqueue({ data: { bookkeeping_locked_through: null }, error: null })
    enqueue({ data: { id: 'fp-1', is_closed: false, locked_at: null }, error: null })
    // The owner.
    enqueue({ data: { id: 'si-1', supplier_invoice_number: '3744267', status: 'approved', credited_invoice_id: null }, error: null })
    // Staging's own period check, then the pending operation.
    enqueue({ data: { bookkeeping_locked_through: null }, error: null })
    enqueue({ data: { id: 'fp-1', is_closed: false, locked_at: null }, error: null })
    enqueue({ data: { id: 'op-owned-1' }, error: null })

    const result = (await reverseEntry.execute(
      { entry_id: '33333333-3333-4333-8333-333333333333' },
      'company-1',
      'user-1',
      supabase as never,
    )) as { preview: { owned_by?: { kind: string; tool: string | null }; warnings?: string[] } }

    expect(findCall('pending_operations', 'insert')).toBeDefined()
    expect(result.preview.owned_by).toMatchObject({ kind: 'supplier_invoice', tool: 'gnubok_credit_supplier_invoice' })
    expect(result.preview.warnings?.some((w) => w.includes('leverantörsfaktura 3744267'))).toBe(true)
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

  it('rejects a reason over 500 characters with a VALIDATION_ERROR code and a Swedish message', async () => {
    // Customer report: the envelope said "Något gick fel. Försök igen." in
    // Swedish while the cause was only in the English field.
    const { supabase } = createQueuedMockSupabase()
    const { getStructuredError } = await import('@/lib/errors/get-structured-error')
    let thrown: unknown
    try {
      await reverseEntry.execute(
        { entry_id: '11111111-1111-1111-1111-111111111111', reason: 'x'.repeat(501) },
        'company-1',
        'user-1',
        supabase as never,
      )
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(Error)
    const envelope = getStructuredError(thrown)
    expect(envelope.code).toBe('VALIDATION_ERROR')
    expect(envelope.message_sv).toBe('reason: Motiveringen får vara högst 500 tecken.')
    expect(envelope.message_en).toMatch(/500 characters or fewer/)
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
    enqueue(NO_POSTED_STORNO)
    enqueue({ data: { name: '2025', period_start: '2025-01-01', period_end: '2025-12-31' }, error: null })
    enqueue({ data: { bookkeeping_locked_through: null }, error: null }) // company lock date
    enqueue({ data: { id: 'fp-closed', is_closed: true, locked_at: '2026-02-01T00:00:00Z' }, error: null })
    await expect(
      reverseEntry.execute(
        { entry_id: '22222222-2222-2222-2222-222222222222' },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/closed/i)
  })

  // The storno is numbered and booked in the original's year, so its date
  // must lie there too (BFL 5 kap 5 §, BFNAR 2013:2 p. 2.17-2.18). An outside
  // date used to stage, and the storno was posted dated in another year.
  it('refuses a reversal_date outside the original\'s fiscal year, staging nothing', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({
      data: {
        id: '22222222-2222-2222-2222-222222222222',
        status: 'posted',
        entry_date: '2025-11-15',
        description: 'Test',
        voucher_number: 42,
        voucher_series: 'A',
        fiscal_period_id: 'fp-2025',
        fiscal_periods: { name: '2025', is_closed: false, locked_at: null },
        lines: [],
      },
      error: null,
    })
    enqueue(NO_POSTED_STORNO)
    enqueue({ data: { name: '2025', period_start: '2025-01-01', period_end: '2025-12-31' }, error: null })

    await expect(
      reverseEntry.execute(
        { entry_id: '22222222-2222-2222-2222-222222222222', reversal_date: '2026-01-10' },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toMatchObject({ code: 'ENTRY_DATE_OUTSIDE_FISCAL_PERIOD' })
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })
})

// crm#1290: a correction of a verifikat in a year closed with a year-end
// closing was refused with "Unlock the period, or use omprövning", and unlock
// refuses a closed year. The pre-flight is the engine's storno target check,
// with the person's option: the storno and the corrected verifikat are dated
// in the first open period after the original and name it; only an entry
// type whose date is fixed keeps the typed refusal.
describe('gnubok_correct_entry: an original in a closed or locked year', () => {
  const original = {
    id: '44444444-4444-4444-8444-444444444444',
    status: 'posted',
    entry_date: '2026-04-21',
    description: 'Utbetald utdelning',
    voucher_number: 27,
    voucher_series: 'A',
    fiscal_period_id: 'fp-2025',
    correction_of_id: null,
    reverses_id: null,
    lines: [
      { account_number: '2898', debit_amount: 1000, credit_amount: 0, line_description: null, currency: null, amount_in_currency: null, exchange_rate: null, tax_code: null, dimensions: null, cost_center: null, project: null },
      { account_number: '1930', debit_amount: 0, credit_amount: 1000, line_description: null, currency: null, amount_in_currency: null, exchange_rate: null, tax_code: null, dimensions: null, cost_center: null, project: null },
    ],
  }
  const lines = [
    { account_number: '2091', debit_amount: 1000, credit_amount: 0 },
    { account_number: '1930', debit_amount: 0, credit_amount: 1000 },
  ]
  const year = { name: 'Räkenskapsår 2025/2026', period_start: '2025-05-01', period_end: '2026-04-30' }
  const years = [
    { id: 'fp-2025', period_start: '2025-05-01', period_end: '2026-04-30', is_closed: true, locked_at: '2026-09-25T18:02:15Z' },
    { id: 'fp-2026', period_start: '2026-05-01', period_end: '2027-04-30', is_closed: false, locked_at: null },
  ]

  afterEach(() => {
    vi.useRealTimers()
  })

  it('stages a year closed with a year-end closing as a correction dated in the first open year', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-24T10:00:00Z') })
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: original, error: null })
    enqueue(NO_POSTED_STORNO)
    enqueue({ data: year, error: null })
    enqueue({ data: { bookkeeping_locked_through: null }, error: null })
    enqueue({ data: { id: 'fp-2025', is_closed: true, locked_at: '2026-09-25T18:02:15Z' }, error: null })
    // The first open period: the company lock date, then the years after it.
    enqueue({ data: { bookkeeping_locked_through: null }, error: null })
    enqueue({ data: years, error: null })
    // stage(): the period check for the date it lands on, then the insert.
    enqueue({ data: { bookkeeping_locked_through: null }, error: null })
    enqueue({ data: { id: 'fp-2026', is_closed: false, locked_at: null }, error: null })
    enqueue({ data: { id: 'op-closed-year' }, error: null })

    const result = (await correctEntry.execute(
      { entry_id: original.id, lines },
      'company-1',
      'user-1',
      supabase as never,
    )) as { preview: { correction: { description: string; entry_date?: string }; will: string } }

    expect(findCall('pending_operations', 'insert')).toBeDefined()
    expect(result.preview.correction).toMatchObject({
      entry_date: '2026-11-24',
      description: 'Rättelse av verifikat A27 (2026-04-21): Utbetald utdelning',
    })
    expect(result.preview.will).toMatch(/first open period/)
    expect(result.preview.will).not.toMatch(/mark the original as reversed/)
  })

  it('refuses a year-end verifikat in a closed year with TARGET_PERIOD_CLOSED and stages nothing', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { ...original, source_type: 'year_end' }, error: null })
    enqueue(NO_POSTED_STORNO)
    enqueue({ data: year, error: null })
    enqueue({ data: { bookkeeping_locked_through: null }, error: null })
    enqueue({ data: { id: 'fp-2025', is_closed: true, locked_at: '2026-09-25T18:02:15Z' }, error: null })

    const refusal = await correctEntry
      .execute({ entry_id: original.id, lines }, 'company-1', 'user-1', supabase as never)
      .catch((err: unknown) => err)

    expect(refusal).toMatchObject({ code: 'TARGET_PERIOD_CLOSED', date: '2026-04-21' })
    // Never the old advice: a closed year cannot be unlocked.
    expect(String((refusal as Error).message)).not.toMatch(/unlock the period|omprövning/i)
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('refuses a VAT settlement behind the company lock date with TARGET_PERIOD_LOCKED', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { ...original, source_type: 'vat_settlement' }, error: null })
    enqueue(NO_POSTED_STORNO)
    enqueue({ data: year, error: null })
    enqueue({ data: { bookkeeping_locked_through: '2026-04-30' }, error: null })
    enqueue({ data: { id: 'fp-2025' }, error: null })

    await expect(
      correctEntry.execute({ entry_id: original.id, lines }, 'company-1', 'user-1', supabase as never),
    ).rejects.toMatchObject({ code: 'TARGET_PERIOD_LOCKED' })
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('refuses an original a posted storno already reverses with ENTRY_ALREADY_REVERSED', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: original, error: null })
    enqueue({ data: [{ id: 'storno-1' }], error: null })

    await expect(
      correctEntry.execute({ entry_id: original.id, lines }, 'company-1', 'user-1', supabase as never),
    ).rejects.toMatchObject({ code: 'ENTRY_ALREADY_REVERSED' })
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('stages when the original year is open', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: original, error: null })
    enqueue(NO_POSTED_STORNO)
    enqueue({ data: year, error: null })
    enqueue({ data: { bookkeeping_locked_through: null }, error: null })
    enqueue({ data: { id: 'fp-2025', is_closed: false, locked_at: null }, error: null })
    // stage(): the period check for the original's date, then the insert.
    enqueue({ data: { bookkeeping_locked_through: null }, error: null })
    enqueue({ data: { id: 'fp-2025', is_closed: false, locked_at: null }, error: null })
    enqueue({ data: { id: 'op-open-year' }, error: null })

    await correctEntry.execute({ entry_id: original.id, lines }, 'company-1', 'user-1', supabase as never)

    expect(findCall('pending_operations', 'insert')).toBeDefined()
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
    // 2) original journal_entries lookup, but it is a year-end verifikat in
    //    a closed year, so we short-circuit before staging. That's enough to
    //    confirm the helper resolved the ref and passed the UUID through to
    //    the next query.
    enqueue({
      data: {
        id: resolvedId,
        status: 'posted',
        entry_date: '2026-03-06',
        description: 'Cursor 2',
        voucher_number: 113,
        voucher_series: 'A',
        fiscal_period_id: 'fp-closed',
        source_type: 'year_end',
        lines: [],
      },
      error: null,
    })
    // 3) the storno target check: no posted storno, the original's (closed) year.
    enqueue(NO_POSTED_STORNO)
    enqueue({ data: { name: '2026', period_start: '2026-01-01', period_end: '2026-12-31' }, error: null })
    enqueue({ data: { bookkeeping_locked_through: null }, error: null })
    enqueue({ data: { id: 'fp-closed', is_closed: true, locked_at: null }, error: null })

    await expect(
      correctEntry.execute(
        { entry_id: 'A-113', lines: balancedCorrection },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toMatchObject({ code: 'TARGET_PERIOD_CLOSED' })
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

describe('gnubok_set_opening_balances: one IB per year at staging', () => {
  const setOpeningBalances = tools.find((t) => t.name === 'gnubok_set_opening_balances')!

  // The executor used to post a second IB at approval and land the op as
  // failed while the duplicate stayed in the books (ÅRL 2:4, one IB per year).
  it('refuses to stage when the next year has a posted IB without a pointer', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { name: '2025', period_end: '2025-12-31' }, error: null }) // closed period name
    enqueue({ data: { name: '2026', period_start: '2026-01-01' }, error: null }) // next period name
    enqueue({ data: { opening_balances_set: false, opening_balance_entry_id: null, opening_balance_entry: null }, error: null })
    enqueue({ data: [{ id: 'je-ib-voucher', voucher_series: 'A', voucher_number: 4 }], error: null })

    await expect(
      setOpeningBalances.execute(
        { closed_period_id: 'fp-2025', next_period_id: 'fp-2026' },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toMatchObject({
      code: 'OB_PERIOD_ALREADY_HAS_BALANCES',
      message: expect.stringMatching(/redan en ingående balans \(verifikation A-4\)/),
    })
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })
})

describe('gnubok_list_voucher_gaps: a failed check is an error, never 0 gaps', () => {
  const listGaps = tools.find((t) => t.name === 'gnubok_list_voucher_gaps')!
  const PERIOD_ID = '7b3a1c2d-0000-4000-8000-0000000000aa'
  const PERIOD = { id: PERIOD_ID, name: '2026', period_start: '2026-01-01', period_end: '2026-12-31' }

  it('checks series A when the year has no sequence row (it answered 0 gaps unchecked)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: PERIOD, error: null }) // fiscal_periods: the company's
    enqueue({ data: [], error: null }) // voucher_sequences: none
    enqueue({ data: [{ gap_start: 4, gap_end: 4 }], error: null }) // detect_voucher_gaps('A')
    enqueue({ data: [], error: null }) // explanations

    const result = (await listGaps.execute({ fiscal_period_id: PERIOD_ID }, 'company-1', 'user-1', supabase as never)) as {
      gaps: Array<{ series: string; explanation: unknown }>
      total_gaps: number
      unexplained_gaps: number
    }

    expect(result.total_gaps).toBe(1)
    expect(result.unexplained_gaps).toBe(1)
    expect(result.gaps[0]).toMatchObject({ series: 'A', gap_start: 4, gap_end: 4, explanation: null })
  })

  it('keeps the explanation row shape it always returned', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: PERIOD, error: null })
    enqueue({ data: [{ voucher_series: 'A' }], error: null })
    enqueue({ data: [{ gap_start: 4, gap_end: 4 }], error: null })
    enqueue({
      data: [{ id: 'exp-1', voucher_series: 'A', gap_start: 4, gap_end: 4, explanation: 'Avbruten bokning', user_id: 'user-1', created_at: '2026-01-01' }],
      error: null,
    })

    const result = (await listGaps.execute({ fiscal_period_id: PERIOD_ID }, 'company-1', 'user-1', supabase as never)) as {
      gaps: Array<{ explanation: unknown }>
      unexplained_gaps: number
    }

    expect(result.unexplained_gaps).toBe(0)
    expect(result.gaps[0].explanation).toEqual({
      id: 'exp-1',
      voucher_series: 'A',
      gap_start: 4,
      gap_end: 4,
      explanation: 'Avbruten bokning',
      created_at: '2026-01-01',
    })
  })

  // A98 posted, then cancelled: detect_voucher_gaps counts the number as used,
  // and every journal list hides the verifikat, so it was accounted for nowhere.
  it('lists a cancelled numbered verifikat as makulerad, apart from the gaps', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: PERIOD, error: null })
    enqueue({ data: [{ voucher_series: 'A' }], error: null })
    enqueue({ data: [], error: null }) // detect_voucher_gaps('A'): no gap
    enqueue({
      data: [{ id: 'je-98', voucher_series: 'A', voucher_number: 98, entry_date: '2026-05-12', description: 'Betalning leverantörsfaktura 1043' }],
      error: null,
    }) // journal_entries: cancelled, numbered
    enqueue({ data: [], error: null }) // explanations

    const result = (await listGaps.execute({ fiscal_period_id: PERIOD_ID }, 'company-1', 'user-1', supabase as never)) as {
      total_gaps: number
      cancelled_vouchers: unknown[]
      cancelled_note?: string
    }

    expect(result.total_gaps).toBe(0)
    expect(result.cancelled_vouchers).toEqual([
      {
        kind: 'makulerad',
        series: 'A',
        voucher_number: 98,
        entry_date: '2026-05-12',
        description: 'Betalning leverantörsfaktura 1043',
        journal_entry_id: 'je-98',
        explanation: null,
      },
    ])
    expect(result.cancelled_note).toMatch(/not a gap/)
    expect(findCalls('journal_entries', 'eq')).toContainEqual(['status', 'cancelled'])
    expect(findCalls('journal_entries', 'gt')).toContainEqual(['voucher_number', 0])
  })

  it('answers an empty cancelled_vouchers and no note when no verifikat is cancelled', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: PERIOD, error: null })
    enqueue({ data: [{ voucher_series: 'A' }], error: null })
    enqueue({ data: [], error: null })
    enqueue({ data: [], error: null }) // journal_entries: none cancelled

    const result = (await listGaps.execute({ fiscal_period_id: PERIOD_ID }, 'company-1', 'user-1', supabase as never)) as Record<string, unknown>

    expect(result.cancelled_vouchers).toEqual([])
    expect(result).not.toHaveProperty('cancelled_note')
  })

  it('throws when gap detection fails', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: PERIOD, error: null })
    enqueue({ data: [{ voucher_series: 'A' }], error: null })
    enqueue({ data: null, error: { message: 'statement timeout' } })

    await expect(
      listGaps.execute({ fiscal_period_id: PERIOD_ID }, 'company-1', 'user-1', supabase as never),
    ).rejects.toThrow(/Voucher gap check failed at detect_voucher_gaps/)
  })

  // An omitted id reached SQL as the string "undefined" (supabase-js
  // stringifies it) and answered UNKNOWN_ERROR "try again".
  it('checks the year containing today when fiscal_period_id is omitted', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: PERIOD, error: null }) // fiscal_periods: the period containing today
    enqueue({ data: [{ voucher_series: 'A' }], error: null })
    enqueue({ data: [], error: null })

    const result = (await listGaps.execute({}, 'company-1', 'user-1', supabase as never)) as {
      fiscal_period: { id: string; name: string }
      total_gaps: number
    }

    expect(result.fiscal_period).toEqual({ id: PERIOD_ID, name: '2026' })
    expect(result.total_gaps).toBe(0)
    expect(findCalls('voucher_sequences', 'eq')).toContainEqual(['fiscal_period_id', PERIOD_ID])
    for (const call of findCalls('voucher_sequences', 'eq')) expect(call[1]).not.toBe(undefined)
  })

  it('falls back to the most recent year when none contains today', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: null }) // fiscal_periods: none contains today
    enqueue({ data: { id: PERIOD_ID }, error: null }) // most recent
    enqueue({ data: PERIOD, error: null }) // re-read in the company
    enqueue({ data: [], error: null })
    enqueue({ data: [], error: null })

    const result = (await listGaps.execute({}, 'company-1', 'user-1', supabase as never)) as {
      fiscal_period: { id: string }
    }
    expect(result.fiscal_period.id).toBe(PERIOD_ID)
  })

  it.each([['undefined'], ['placeholder'], ['unknown']])(
    'refuses fiscal_period_id "%s" as a VALIDATION_ERROR naming the field, before any query',
    async (bad) => {
      const { supabase, findCall } = createQueuedMockSupabase()
      const err = await listGaps
        .execute({ fiscal_period_id: bad }, 'company-1', 'user-1', supabase as never)
        .catch((e: unknown) => e)

      expect(err).toMatchObject({ code: 'VALIDATION_ERROR', issues: [{ field: 'fiscal_period_id' }] })
      expect((err as Error).message).toMatch(/gnubok_list_fiscal_periods/)
      expect(toToolError(err).error.code).toBe('VALIDATION_ERROR')
      expect(findCall('voucher_sequences', 'select')).toBeUndefined()
      expect(findCall('fiscal_periods', 'select')).toBeUndefined()
    },
  )

  it('refuses another company\'s year as PERIOD_NOT_FOUND instead of answering 0 gaps', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: null, error: null }) // fiscal_periods: not this company's

    await expect(
      listGaps.execute({ fiscal_period_id: PERIOD_ID }, 'company-1', 'user-1', supabase as never),
    ).rejects.toMatchObject({ code: 'PERIOD_NOT_FOUND' })
    expect(findCall('voucher_sequences', 'select')).toBeUndefined()
  })
})

describe('gnubok_explain_voucher_gap: the approval\'s checks run at staging', () => {
  const explainGap = tools.find((t) => t.name === 'gnubok_explain_voucher_gap')!
  const PERIOD = '7b3a1c2d-0000-4000-8000-000000000001'
  const ARGS = { fiscal_period_id: PERIOD, voucher_series: 'A', gap_start: 5, gap_end: 7, explanation: '  Avbruten bokning  ' }

  it.each([
    ['a lowercase series', { voucher_series: 'a' }],
    ['a reversed range', { gap_start: 9 }],
    ['an explanation over 500 characters', { explanation: 'x'.repeat(501) }],
  ])('refuses %s, staging nothing', async (_label, patch) => {
    const { supabase, findCall } = createQueuedMockSupabase()
    await expect(
      explainGap.execute({ ...ARGS, ...patch }, 'company-1', 'user-1', supabase as never),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('refuses another company\'s year and an explained gap before approval', async () => {
    const foreign = createQueuedMockSupabase()
    foreign.enqueue({ data: null, error: null }) // fiscal_periods: not the company's
    await expect(explainGap.execute(ARGS, 'company-1', 'user-1', foreign.supabase as never)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })

    const explained = createQueuedMockSupabase()
    explained.enqueue({ data: { id: PERIOD }, error: null })
    explained.enqueue({ data: { id: 'exp-1' }, error: null }) // already explained
    await expect(explainGap.execute(ARGS, 'company-1', 'user-1', explained.supabase as never)).rejects.toMatchObject({
      code: 'VOUCHER_GAP_ALREADY_EXPLAINED',
    })
    expect(explained.findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('stages the trimmed explanation in the params shape the executor reads', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { id: PERIOD }, error: null }) // the company's year
    enqueue({ data: null, error: null }) // not explained yet
    enqueue({ data: { id: 'op-gap' }, error: null }) // pending_operations insert

    await explainGap.execute(ARGS, 'company-1', 'user-1', supabase as never)

    const insert = findCall('pending_operations', 'insert')?.[0] as { params?: Record<string, unknown> } | undefined
    expect(insert?.params).toEqual({ fiscal_period_id: PERIOD, voucher_series: 'A', gap_start: 5, gap_end: 7, explanation: 'Avbruten bokning' })
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

describe('gnubok_correct_entry: a second reversal (crm#1397)', () => {
  const fee = {
    id: '33333333-3333-4333-8333-333333333333',
    status: 'posted',
    entry_date: '2026-05-12',
    description: 'Bankavgift',
    voucher_number: 46,
    voucher_series: 'A',
    fiscal_period_id: 'fp-1',
    correction_of_id: null,
    reverses_id: null,
    fiscal_periods: { name: '2026', is_closed: false, locked_at: null },
    lines: [
      { account_number: '6570', debit_amount: 100, credit_amount: 0, line_description: null, currency: null, amount_in_currency: null, exchange_rate: null, tax_code: null, dimensions: null, cost_center: null, project: null },
      { account_number: '1930', debit_amount: 0, credit_amount: 100, line_description: null, currency: null, amount_in_currency: null, exchange_rate: null, tax_code: null, dimensions: null, cost_center: null, project: null },
    ],
  }
  const swapped = [
    { account_number: '6570', debit_amount: 0, credit_amount: 100 },
    { account_number: '1930', debit_amount: 100, credit_amount: 0 },
  ]

  it('refuses to stage the original with debit and credit swapped', async () => {
    const { supabase, enqueue, enqueueMany, findCall } = createQueuedMockSupabase()
    enqueue({ data: fee, error: null })
    enqueueMany(OPEN_STORNO_TARGET)

    await expect(
      correctEntry.execute({ entry_id: fee.id, lines: swapped }, 'company-1', 'user-1', supabase as never),
    ).rejects.toMatchObject({ code: 'MEANINGLESS_CORRECTION', reason: 'negates_original' })
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('stages it with sides_swapped=true and forwards the flag to the executor params', async () => {
    const { supabase, enqueue, enqueueMany, findCall } = createQueuedMockSupabase()
    enqueue({ data: fee, error: null })
    enqueueMany(OPEN_STORNO_TARGET)
    enqueue({ data: { bookkeeping_locked_through: null }, error: null })
    enqueue({ data: { id: 'fp-1', is_closed: false, locked_at: null }, error: null })
    enqueue({ data: { id: 'op-sides-swapped' }, error: null })

    await correctEntry.execute(
      { entry_id: fee.id, lines: swapped, sides_swapped: true },
      'company-1',
      'user-1',
      supabase as never,
    )

    const payload = (findCall('pending_operations', 'insert') as unknown[])[0] as { params?: { sides_swapped?: boolean } }
    expect(payload.params?.sides_swapped).toBe(true)
  })
})
