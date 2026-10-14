/**
 * The account-keyed reconciliation tools: status (account_key branch), items,
 * reconcile_match (stages; dry_run previews; default catalog), reconcile_unmatch (search-only).
 * Service functions are mocked; the staging path runs for real in dry_run
 * mode (no insert), so the STAGED_OPERATION_SCHEMA contract is exercised.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

// The company's skattekonto account (lib/skatteverket/skattekonto-account.ts):
// 1630 here, what every company resolved to before the setting existed.
vi.mock('@/lib/skatteverket/skattekonto-account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/skatteverket/skattekonto-account')>()),
  resolveSkattekontoAccount: vi.fn(async () => '1630'),
}))

const statusMock = vi.fn()
const itemsMock = vi.fn()
const matchMock = vi.fn()
const signoffMock = vi.fn()
const residualMock = vi.fn()

vi.mock('@/lib/reconciliation/service', () => ({
  getAccountStatus: (...args: unknown[]) => statusMock(...args),
  listReconciliationAccounts: vi.fn(),
}))
vi.mock('@/lib/reconciliation/items', async () => {
  const actual = await vi.importActual<typeof import('@/lib/reconciliation/items')>('@/lib/reconciliation/items')
  return { ...actual, listAccountItems: (...args: unknown[]) => itemsMock(...args) }
})
vi.mock('@/lib/reconciliation/actions', () => ({
  matchPairs: (...args: unknown[]) => matchMock(...args),
  unmatchLink: vi.fn(),
  setItemIgnored: vi.fn(),
}))
vi.mock('@/lib/reconciliation/signoff', () => ({
  signOffAccount: (...args: unknown[]) => signoffMock(...args),
}))
vi.mock('@/lib/reconciliation/residual', async () => {
  const actual = await vi.importActual<typeof import('@/lib/reconciliation/residual')>('@/lib/reconciliation/residual')
  return { ...actual, bookResidualAndLink: (...args: unknown[]) => residualMock(...args) }
})

import { tools, isDefaultCatalogTool, deriveToolMeta } from '../server'
import { toToolError } from '../tool-result'

const COMPANY = 'company-1'
const USER = 'user-1'
const ROW = '22222222-2222-4222-8222-222222222222'
const ENTRY = '33333333-3333-4333-8333-333333333333'

function tool(name: string) {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`tool ${name} not registered`)
  return t
}

describe('reconciliation MCP tools', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    statusMock.mockReset()
    itemsMock.mockReset()
    matchMock.mockReset()
    signoffMock.mockReset()
  })

  it('registers the four tools with the intended catalog visibility and staging contract', () => {
    expect(isDefaultCatalogTool(tool('gnubok_get_reconciliation_status'))).toBe(true)
    expect(isDefaultCatalogTool(tool('gnubok_list_reconciliation_items'))).toBe(true)
    // Writes sit behind search to respect the tools/list payload ceiling.
    // Default since E2E #12: the onboarding efterkontroll instructs the
    // matching step and Claude.ai cannot call search-only tools.
    expect(isDefaultCatalogTool(tool('gnubok_reconcile_match'))).toBe(true)
    expect(isDefaultCatalogTool(tool('gnubok_reconcile_unmatch'))).toBe(false)
    expect(isDefaultCatalogTool(tool('gnubok_link_transaction_to_journal_entry'))).toBe(false)
    expect(deriveToolMeta(tool('gnubok_reconcile_match'))).toMatchObject({
      requires_approval: true,
      preflight: 'gnubok_get_reconciliation_status',
    })
    expect(deriveToolMeta(tool('gnubok_reconcile_unmatch'))).toMatchObject({ requires_approval: true })
    expect(deriveToolMeta(tool('gnubok_list_reconciliation_items'))).toBeUndefined()
  })

  it('status with account_key dispatches to the service and strips item lists', async () => {
    const { supabase } = createQueuedMockSupabase()
    statusMock.mockResolvedValue({ account_key: 'skattekonto', bridge: [{ key: 'x' }], items: { proposed: [] } })
    const out = (await tool('gnubok_get_reconciliation_status').execute(
      { account_key: 'skattekonto', date_from: '2026-07-01' },
      COMPANY,
      USER,
      supabase as never,
    )) as Record<string, unknown>
    expect(statusMock).toHaveBeenCalledWith(supabase, COMPANY, 'skattekonto', { windowFrom: '2026-07-01', windowTo: null })
    expect(out.items).toBeUndefined()
    expect(out.bridge).toEqual([{ key: 'x' }])
  })

  it('status with an unknown account_key names the format and what exists', async () => {
    const { supabase } = createQueuedMockSupabase()
    statusMock.mockResolvedValue(null)
    await expect(
      tool('gnubok_get_reconciliation_status').execute({ account_key: '1930' }, COMPANY, USER, supabase as never),
    ).rejects.toThrow(/Unknown account_key "1930" for this company\. Format: .*No reconciliation accounts yet/)
  })

  it('status for skattekonto with no Skatteverket token says so instead of "unknown"', async () => {
    // Easy Online Stores brief 2026-09-16, F6: "Unknown account_key" before
    // Skatteverket is connected cost the evaluator time. No token row is
    // queued, so the lookup resolves to null and the key is "not connected".
    const { supabase } = createQueuedMockSupabase()
    statusMock.mockResolvedValue(null)
    await expect(
      tool('gnubok_get_reconciliation_status').execute({ account_key: 'skattekonto' }, COMPANY, USER, supabase as never),
    ).rejects.toThrow(/Skattekontot är inte kopplat för bolaget/)
  })

  it('items and match share the same account_key explanation', async () => {
    const { supabase } = createQueuedMockSupabase()
    itemsMock.mockResolvedValue(null)
    await expect(
      tool('gnubok_list_reconciliation_items').execute({ account_key: 'skattekonto' }, COMPANY, USER, supabase as never),
    ).rejects.toThrow(/Skattekontot är inte kopplat/)
    matchMock.mockResolvedValue(null)
    await expect(
      tool('gnubok_reconcile_match').execute(
        { account_key: 'manual:1510', use_proposals: true, dry_run: true },
        COMPANY, USER, supabase as never, { type: 'api_key', id: 'key-1' } as never,
      ),
    ).rejects.toThrow(/Unknown account_key "manual:1510"/)
  })

  it('items forwards bucket and paging', async () => {
    const { supabase } = createQueuedMockSupabase()
    itemsMock.mockResolvedValue({ items: [], count: 0, total_count: 0, has_more: false, older_unmatched_count: 0 })
    const out = await tool('gnubok_list_reconciliation_items').execute(
      { account_key: 'skattekonto', bucket: 'proposed', limit: 10, offset: 5 },
      COMPANY,
      USER,
      supabase as never,
    )
    expect(itemsMock).toHaveBeenCalledWith(supabase, COMPANY, 'skattekonto', {
      bucket: 'proposed',
      windowFrom: null,
      windowTo: null,
      limit: 10,
      offset: 5,
    })
    expect(out).toMatchObject({ count: 0, total_count: 0, has_more: false })
  })

  describe('skattekonto rows before the history start (crm#1153, crm#1155)', () => {
    const summary = { count: 34, total: -1234.5, history_start: '2026-01-01' }

    it('items: the bucket is in the schema, and every skattekonto listing says where the rows are and what to do', async () => {
      const bucket = (tool('gnubok_list_reconciliation_items').inputSchema.properties as Record<string, { enum?: string[] }>).bucket
      expect(bucket.enum).toContain('before_history')
      const { supabase } = createQueuedMockSupabase()
      itemsMock.mockResolvedValue({
        items: [], count: 0, total_count: 0, has_more: false, older_unmatched_count: 0, before_history: summary,
      })
      const out = (await tool('gnubok_list_reconciliation_items').execute(
        { account_key: 'skattekonto', bucket: 'unmatched_external' },
        COMPANY,
        USER,
        supabase as never,
      )) as { before_history: Record<string, unknown> & { note: string } }
      expect(out.before_history).toMatchObject(summary)
      expect(out.before_history.note).toMatch(/^34 open Skatteverket row\(s\) are dated before history_start 2026-01-01/)
      expect(out.before_history.note).toContain('Att göra')
      expect(out.before_history.note).toContain('bucket "before_history"')
      expect(out.before_history.note).toContain('gnubok_reconcile_match')
      expect(out.before_history.note).toContain('do not book them')
    })

    it('items: no block when no row is before the history', async () => {
      const { supabase } = createQueuedMockSupabase()
      itemsMock.mockResolvedValue({ items: [], count: 0, total_count: 0, has_more: false, older_unmatched_count: 0 })
      const out = await tool('gnubok_list_reconciliation_items').execute(
        { account_key: 'skattekonto' }, COMPANY, USER, supabase as never,
      )
      expect(out).not.toHaveProperty('before_history')
    })

    it('status: the same block next to the bridge, which is passed through untouched', async () => {
      const { supabase } = createQueuedMockSupabase()
      const bridge = [{ key: 'external_balance', amount: 100 }]
      statusMock.mockResolvedValue({
        account_key: 'skattekonto',
        bridge,
        counts: { proposed: 0, unmatched_external: 0, unmatched_ledger: 0, matched: 3, ignored: 0 },
        skattekonto: { history_start: '2026-01-01', opening_difference: 0, before_history_count: 34, before_history_total: -1234.5 },
        items: { before_history: [] },
      })
      const out = (await tool('gnubok_get_reconciliation_status').execute(
        { account_key: 'skattekonto' }, COMPANY, USER, supabase as never,
      )) as Record<string, unknown> & { before_history: { note: string } }
      expect(out.items).toBeUndefined()
      expect(out.bridge).toBe(bridge)
      expect(out.counts).toEqual({ proposed: 0, unmatched_external: 0, unmatched_ledger: 0, matched: 3, ignored: 0 })
      expect(out.before_history).toMatchObject(summary)
      expect(out.before_history.note).toContain('bucket "before_history"')

      statusMock.mockResolvedValue({ account_key: 'skattekonto', bridge, skattekonto: { before_history_count: 0 } })
      const none = await tool('gnubok_get_reconciliation_status').execute(
        { account_key: 'skattekonto' }, COMPANY, USER, supabase as never,
      )
      expect(none).not.toHaveProperty('before_history')
    })
  })

  it('reconcile_match resolves pairs through a dry-run preview and stages them (dry_run returns staged: false)', async () => {
    const { supabase } = createQueuedMockSupabase()
    matchMock.mockResolvedValue({
      dry_run: true,
      considered: 2,
      applied: [{ external_id: ROW, journal_entry_id: ENTRY }],
      skipped: [{ pair: { external_ids: ['x'], journal_entry_ids: ['y'] }, code: 'ALREADY_LINKED', message: 'redan' }],
    })
    const out = (await tool('gnubok_reconcile_match').execute(
      { account_key: 'skattekonto', use_proposals: true, dry_run: true },
      COMPANY,
      USER,
      supabase as never,
      { type: 'api_key', id: 'key-1' } as never,
    )) as Record<string, unknown>
    expect(matchMock).toHaveBeenCalledWith(
      supabase,
      COMPANY,
      USER,
      'skattekonto',
      { pairs: [], use_proposals: true, confidence_threshold: 0.9 },
      { dryRun: true },
    )
    expect(out).toMatchObject({ staged: false, dry_run: true, risk_level: 'medium' })
    const preview = out.preview as Record<string, unknown>
    expect(preview).toMatchObject({ account_key: 'skattekonto', pair_count: 1, source: 'proposals' })
    expect(preview.pairs).toEqual([{ external_ids: [ROW], journal_entry_ids: [ENTRY] }])
    expect(out.next).toMatchObject({ tool: 'gnubok_get_reconciliation_status' })
  })

  it('reconcile_match folds the links of a bank 1:N split back into ONE staged pair with explicit allocations (#1553)', async () => {
    const { supabase } = createQueuedMockSupabase()
    const cash = '55555555-5555-4555-8555-555555555555'
    const entry2 = '44444444-4444-4444-8444-444444444444'
    const otherRow = '66666666-6666-4666-8666-666666666666'
    matchMock.mockResolvedValue({
      dry_run: true,
      considered: 2,
      applied: [
        { external_id: otherRow, journal_entry_id: ENTRY },
        { external_id: ROW, journal_entry_id: ENTRY, allocated_amount: -500 },
        { external_id: ROW, journal_entry_id: entry2, allocated_amount: -300 },
      ],
      skipped: [],
    })
    const out = (await tool('gnubok_reconcile_match').execute(
      {
        account_key: `bank:${cash}`,
        pairs: [
          { external_ids: [otherRow], journal_entry_ids: [ENTRY] },
          { external_ids: [ROW], journal_entry_ids: [ENTRY, entry2] },
        ],
        dry_run: true,
      },
      COMPANY,
      USER,
      supabase as never,
      { type: 'api_key', id: 'key-1' } as never,
    )) as Record<string, unknown>
    expect(matchMock).toHaveBeenCalledWith(
      supabase,
      COMPANY,
      USER,
      `bank:${cash}`,
      expect.objectContaining({
        pairs: [
          { external_ids: [otherRow], journal_entry_ids: [ENTRY] },
          { external_ids: [ROW], journal_entry_ids: [ENTRY, entry2] },
        ],
      }),
      { dryRun: true },
    )
    const preview = out.preview as Record<string, unknown>
    expect(preview.pair_count).toBe(2)
    // The 1:1 link stays a pair of its own; the two split links become one
    // pair carrying the slices the reviewer saw, so the executor re-validates
    // exactly those amounts (never two independent manualLink calls).
    expect(preview.pairs).toEqual([
      { external_ids: [otherRow], journal_entry_ids: [ENTRY] },
      {
        external_ids: [ROW],
        journal_entry_ids: [ENTRY, entry2],
        allocations: [
          { journal_entry_id: ENTRY, amount: -500 },
          { journal_entry_id: entry2, amount: -300 },
        ],
      },
    ])
  })

  it('reconcile_match stages one skattekonto event over two verifikat as ONE pair with the open amounts the reviewer saw (crm#1183)', async () => {
    const { supabase } = createQueuedMockSupabase()
    const entry2 = '44444444-4444-4444-8444-444444444444'
    matchMock.mockResolvedValue({
      dry_run: true,
      considered: 1,
      applied: [
        { external_id: ROW, journal_entry_id: ENTRY, via: 'split', allocated_amount: 37 },
        { external_id: ROW, journal_entry_id: entry2, via: 'split', allocated_amount: -8 },
      ],
      settled: [],
      skipped: [],
    })
    const out = (await tool('gnubok_reconcile_match').execute(
      { account_key: 'skattekonto', pairs: [{ external_ids: [ROW], journal_entry_ids: [ENTRY, entry2] }], dry_run: true },
      COMPANY,
      USER,
      supabase as never,
      { type: 'api_key', id: 'key-1' } as never,
    )) as Record<string, unknown>
    const preview = out.preview as Record<string, unknown>
    expect(preview.pairs).toEqual([
      {
        external_ids: [ROW],
        journal_entry_ids: [ENTRY, entry2],
        allocations: [
          { journal_entry_id: ENTRY, amount: 37 },
          { journal_entry_id: entry2, amount: -8 },
        ],
      },
    ])
    // A split leaves nothing on its verifikat: no remainder line for the reviewer.
    expect(preview).not.toHaveProperty('remainders')
  })

  it('reconcile_match keeps an N:1 group as ONE staged pair (feedback seq 292682: Skatteverket rows against one 1630 verifikat)', async () => {
    const { supabase } = createQueuedMockSupabase()
    const row2 = '77777777-7777-4777-8777-777777777777'
    const otherRow = '66666666-6666-4666-8666-666666666666'
    const entry2 = '44444444-4444-4444-8444-444444444444'
    // The dry run flattens a pair into one link per outside row and carries
    // no allocated_amount for a non-split pair.
    matchMock.mockResolvedValue({
      dry_run: true,
      considered: 2,
      applied: [
        { external_id: ROW, journal_entry_id: ENTRY },
        { external_id: row2, journal_entry_id: ENTRY },
        { external_id: otherRow, journal_entry_id: entry2 },
      ],
      skipped: [],
    })
    const out = (await tool('gnubok_reconcile_match').execute(
      {
        account_key: 'skattekonto',
        pairs: [
          { external_ids: [ROW, row2], journal_entry_ids: [ENTRY] },
          { external_ids: [otherRow], journal_entry_ids: [entry2] },
        ],
        dry_run: true,
      },
      COMPANY,
      USER,
      supabase as never,
      { type: 'api_key', id: 'key-1' } as never,
    )) as Record<string, unknown>
    const preview = out.preview as Record<string, unknown>
    // Staging the group as two 1:1 pairs made the executor ask each row alone
    // to settle the whole verifikat (PAIR_NOT_CLOSED on both). The group must
    // reach the executor as the all-or-nothing pair the reviewer approved.
    expect(preview.pair_count).toBe(2)
    expect(preview.pairs).toEqual([
      { external_ids: [ROW, row2], journal_entry_ids: [ENTRY] },
      { external_ids: [otherRow], journal_entry_ids: [entry2] },
    ])
  })

  it('reconcile_match stages what the reviewer reads: each pair\'s rows and its verifikat with amounts (crm#1147)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const row2 = '77777777-7777-4777-8777-777777777777'
    // Two Skatteverket rows of different days against one voucher that books
    // the payment and the debitering it paid (1630 debit and credit).
    matchMock.mockResolvedValue({
      dry_run: true,
      considered: 1,
      applied: [
        { external_id: ROW, journal_entry_id: ENTRY, via: 'lines' },
        { external_id: row2, journal_entry_id: ENTRY, via: 'lines' },
      ],
      skipped: [],
    })
    // describeMatchPairs: the rows, the verifikat with its lines, the rows already linked to it.
    enqueue({
      data: [
        { id: ROW, transaktionsdatum: '2026-09-14', transaktionstext: 'Avdragen skatt augusti 2026', belopp_skatteverket: -4521 },
        { id: row2, transaktionsdatum: '2026-09-16', transaktionstext: 'Arbetsgivaravgift augusti 2026', belopp_skatteverket: -7704 },
      ],
    })
    enqueue({
      data: [
        {
          id: ENTRY,
          voucher_series: 'A',
          voucher_number: 412,
          entry_date: '2026-09-14',
          description: 'Skattekonto september',
          lines: [
            { account_number: '1630', debit_amount: 12225, credit_amount: 0 },
            { account_number: '1630', debit_amount: 0, credit_amount: 12225 },
            { account_number: '1930', debit_amount: 0, credit_amount: 12225 },
          ],
        },
      ],
    })
    enqueue({ data: [{ id: 'payment-row', journal_entry_id: ENTRY, belopp_skatteverket: 12225 }] })

    const out = (await tool('gnubok_reconcile_match').execute(
      { account_key: 'skattekonto', pairs: [{ external_ids: [ROW, row2], journal_entry_ids: [ENTRY] }], dry_run: true },
      COMPANY,
      USER,
      supabase as never,
      { type: 'api_key', id: 'key-1' } as never,
    )) as Record<string, unknown>

    const preview = out.preview as Record<string, unknown>
    // The staged pairs stay ids only: they are what the executor re-validates.
    expect(preview.pairs).toEqual([{ external_ids: [ROW, row2], journal_entry_ids: [ENTRY] }])
    expect(preview.ledger_account).toBe('1630')
    expect(preview.pair_details).toEqual([
      {
        rows: [
          { external_id: ROW, date: '2026-09-14', text: 'Avdragen skatt augusti 2026', amount: -4521 },
          { external_id: row2, date: '2026-09-16', text: 'Arbetsgivaravgift augusti 2026', amount: -7704 },
        ],
        row_count: 2,
        rows_total: -12225,
        entries: [
          {
            journal_entry_id: ENTRY,
            voucher_series: 'A',
            voucher_number: 412,
            entry_date: '2026-09-14',
            description: 'Skattekonto september',
            account_debit: 12225,
            account_credit: 12225,
          },
        ],
        already_linked_count: 1,
        already_linked_total: 12225,
        // The dry run reported no remainder: the rows explain the verifikat.
        remainder_amount: 0,
      },
    ])
    expect(preview).not.toHaveProperty('pair_details_omitted')
  })

  it('reconcile_match still stages when the reviewer\'s details cannot be read (crm#1147)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    matchMock.mockResolvedValue({
      dry_run: true,
      considered: 1,
      applied: [{ external_id: ROW, journal_entry_id: ENTRY, via: 'line' }],
      skipped: [],
    })
    enqueue({ data: null, error: { message: 'statement timeout' } })

    const out = (await tool('gnubok_reconcile_match').execute(
      { account_key: 'skattekonto', pairs: [{ external_ids: [ROW], journal_entry_ids: [ENTRY] }], dry_run: true },
      COMPANY,
      USER,
      supabase as never,
      { type: 'api_key', id: 'key-1' } as never,
    )) as Record<string, unknown>

    expect(out).toMatchObject({ staged: false, dry_run: true })
    const preview = out.preview as Record<string, unknown>
    expect(preview).toMatchObject({ account_key: 'skattekonto', pair_count: 1 })
    expect(preview.pairs).toEqual([{ external_ids: [ROW], journal_entry_ids: [ENTRY] }])
    expect(preview).not.toHaveProperty('pair_details')
    expect(preview).not.toHaveProperty('ledger_account')
  })

  it('reconcile_match carries allow_remainder through staging and shows the reviewer what stays on the verifikat (crm#1043)', async () => {
    const { supabase } = createQueuedMockSupabase()
    const row2 = '77777777-7777-4777-8777-777777777777'
    const exactRow = '66666666-6666-4666-8666-666666666666'
    const exactEntry = '44444444-4444-4444-8444-444444444444'
    // Two rows against a summarised verifikat (linked with a remainder), and
    // one exact pair next to it.
    matchMock.mockResolvedValue({
      dry_run: true,
      considered: 2,
      applied: [
        { external_id: ROW, journal_entry_id: ENTRY, via: 'partial', remainder_amount: 17499.75 },
        { external_id: row2, journal_entry_id: ENTRY, via: 'partial', remainder_amount: 17499.75 },
        { external_id: exactRow, journal_entry_id: exactEntry, via: 'line' },
      ],
      skipped: [],
    })
    const pairs = [
      { external_ids: [ROW, row2], journal_entry_ids: [ENTRY], allow_remainder: true },
      { external_ids: [exactRow], journal_entry_ids: [exactEntry] },
    ]
    const out = (await tool('gnubok_reconcile_match').execute(
      { account_key: 'skattekonto', pairs, dry_run: true },
      COMPANY,
      USER,
      supabase as never,
      { type: 'api_key', id: 'key-1' } as never,
    )) as Record<string, unknown>
    // The caller's flag reaches the dry run untouched.
    expect(matchMock.mock.calls[0][4]).toMatchObject({ pairs })
    const preview = out.preview as Record<string, unknown>
    // The staged pair keeps the flag, or the commit would refuse what the
    // reviewer approved; the exact pair never gains it.
    expect(preview.pairs).toEqual([
      { external_ids: [ROW, row2], journal_entry_ids: [ENTRY], allow_remainder: true },
      { external_ids: [exactRow], journal_entry_ids: [exactEntry] },
    ])
    expect(preview.remainders).toEqual([{ journal_entry_id: ENTRY, remainder_amount: 17499.75 }])
  })

  it('reconcile_match exposes allow_remainder in its input schema, and an exact preview has no remainders', async () => {
    const schema = tool('gnubok_reconcile_match').inputSchema as {
      properties: { pairs: { items: { additionalProperties: boolean; properties: Record<string, { type?: string }> } } }
    }
    expect(schema.properties.pairs.items.additionalProperties).toBe(false)
    expect(schema.properties.pairs.items.properties.allow_remainder).toMatchObject({ type: 'boolean' })

    const { supabase } = createQueuedMockSupabase()
    matchMock.mockResolvedValue({
      dry_run: true,
      considered: 1,
      applied: [{ external_id: ROW, journal_entry_id: ENTRY, via: 'line' }],
      skipped: [],
    })
    const out = (await tool('gnubok_reconcile_match').execute(
      { account_key: 'skattekonto', pairs: [{ external_ids: [ROW], journal_entry_ids: [ENTRY] }], dry_run: true },
      COMPANY,
      USER,
      supabase as never,
      { type: 'api_key', id: 'key-1' } as never,
    )) as Record<string, unknown>
    const preview = out.preview as Record<string, unknown>
    expect(preview.pairs).toEqual([{ external_ids: [ROW], journal_entry_ids: [ENTRY] }])
    expect(preview.remainders).toBeUndefined()
  })

  it('reconcile_match refuses an empty request and a request with nothing linkable, naming the skip reason', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      tool('gnubok_reconcile_match').execute({ account_key: 'skattekonto' }, COMPANY, USER, supabase as never),
    ).rejects.toThrow(/pairs|use_proposals/)
    matchMock.mockResolvedValue({ dry_run: true, considered: 1, applied: [], skipped: [] })
    await expect(
      tool('gnubok_reconcile_match').execute(
        { account_key: 'skattekonto', pairs: [{ external_ids: [ROW], journal_entry_ids: [ENTRY] }] },
        COMPANY,
        USER,
        supabase as never,
      ),
    ).rejects.toThrow(/nothing to stage/i)
    // A bank 1:N whose dry run legitimately failed used to surface as a bare
    // "No linkable pairs"; the skipped list holds the actual reason.
    matchMock.mockResolvedValue({
      dry_run: true,
      considered: 1,
      applied: [],
      skipped: [
        {
          pair: { external_ids: [ROW], journal_entry_ids: [ENTRY] },
          code: 'PAIR_NOT_CLOSED',
          message: 'Verifikationen saknar rad på 1940',
        },
      ],
    })
    await expect(
      tool('gnubok_reconcile_match').execute(
        { account_key: 'skattekonto', pairs: [{ external_ids: [ROW], journal_entry_ids: [ENTRY] }] },
        COMPANY,
        USER,
        supabase as never,
      ),
    ).rejects.toThrow(/nothing to stage\. Skipped: PAIR_NOT_CLOSED: Verifikationen saknar rad på 1940/)
  })

  it('reconcile_match with nothing to stage is coded, never UNKNOWN_ERROR: the shared skip code, else VALIDATION_ERROR', async () => {
    const { supabase } = createQueuedMockSupabase()
    const refusal = async (args: Record<string, unknown>) => {
      const err = await tool('gnubok_reconcile_match')
        .execute(args, COMPANY, USER, supabase as never)
        .then(() => null, (e: unknown) => e)
      expect(err).toBeInstanceOf(Error)
      return toToolError(err, { toolName: 'gnubok_reconcile_match' }).error
    }
    const typo = 'ecb5d7ef-e0d1-4da6-ab18-5651c2c8ec9b'
    const pairArgs = { account_key: 'skattekonto', pairs: [{ external_ids: [ROW], journal_entry_ids: [typo] }] }

    // One reason for every skip is the code itself (feedback seq 740266: a
    // mistyped journal_entry_id), with the offending id in the message.
    matchMock.mockResolvedValueOnce({
      dry_run: true,
      considered: 1,
      applied: [],
      skipped: [
        {
          pair: { external_ids: [ROW], journal_entry_ids: [typo] },
          code: 'ENTRY_NOT_FOUND',
          message: `Verifikationen ${typo} finns inte i företaget. Kontrollera id:t.`,
        },
      ],
    })
    let error = await refusal(pairArgs)
    expect(error.code).toBe('ENTRY_NOT_FOUND')
    expect(error.retryable).toBe(false)
    expect(error.message_en).toContain(typo)

    // Mixed reasons: VALIDATION_ERROR, every reason listed.
    matchMock.mockResolvedValueOnce({
      dry_run: true,
      considered: 2,
      applied: [],
      skipped: [
        { pair: { external_ids: [ROW], journal_entry_ids: [typo] }, code: 'ENTRY_NOT_FOUND', message: 'saknas' },
        { pair: { external_ids: [ENTRY], journal_entry_ids: [typo] }, code: 'ALREADY_LINKED', message: 'redan kopplad' },
      ],
    })
    error = await refusal(pairArgs)
    expect(error.code).toBe('VALIDATION_ERROR')
    expect(error.message_en).toMatch(/ENTRY_NOT_FOUND: saknas \| ALREADY_LINKED: redan kopplad/)

    // use_proposals found nothing: say so instead of a bare "nothing to stage".
    matchMock.mockResolvedValueOnce({ dry_run: true, considered: 0, applied: [], skipped: [] })
    error = await refusal({ account_key: 'skattekonto', use_proposals: true })
    expect(error.code).toBe('VALIDATION_ERROR')
    expect(error.message_en).toMatch(/No proposal at or above confidence_threshold 0\.9 on skattekonto/)
    expect(error.message_en).toContain('gnubok_list_reconciliation_items')

    // An unexpected failure keeps no code, so a timeout still reads as transient.
    matchMock.mockResolvedValueOnce({
      dry_run: true,
      considered: 1,
      applied: [],
      skipped: [{ pair: { external_ids: [ROW], journal_entry_ids: [typo] }, code: 'UNKNOWN', message: 'fetch failed' }],
    })
    error = await refusal(pairArgs)
    expect(error.code).toBe('TRANSIENT_ERROR')
    expect(error.retryable).toBe(true)
  })

  it('reconcile_match refuses a pair without both id arrays as VALIDATION_ERROR before the engine runs', async () => {
    const { supabase } = createQueuedMockSupabase()
    const err = await tool('gnubok_reconcile_match')
      .execute(
        { account_key: 'skattekonto', pairs: [{ external_ids: [ROW], journal_entry_id: ENTRY }] },
        COMPANY,
        USER,
        supabase as never,
      )
      .then(() => null, (e: unknown) => e)
    const error = toToolError(err, { toolName: 'gnubok_reconcile_match' }).error
    expect(error.code).toBe('VALIDATION_ERROR')
    expect(error.message_en).toMatch(/^Invalid pairs: pairs\.0\.journal_entry_ids: /)
    expect(matchMock).not.toHaveBeenCalled()
  })

  it('reconcile_match refuses more pairs than the links routes accept, before any ledger read', async () => {
    // The stage-time dry run reads every id it is given, so the MCP door takes
    // the dashboard and v1 routes' limit: at most 200 pairs.
    const { supabase } = createQueuedMockSupabase()
    const pairs = Array.from({ length: 201 }, () => ({ external_ids: [ROW], journal_entry_ids: [ENTRY] }))
    const err = await tool('gnubok_reconcile_match')
      .execute({ account_key: 'skattekonto', pairs, dry_run: true }, COMPANY, USER, supabase as never)
      .then(() => null, (e: unknown) => e)
    const error = toToolError(err, { toolName: 'gnubok_reconcile_match' }).error
    expect(error.code).toBe('VALIDATION_ERROR')
    expect(error.message_en).toMatch(/^Invalid pairs: pairs: /)
    expect(matchMock).not.toHaveBeenCalled()
  })

  describe('verifikat with no outside row, settled against each other (crm#1074)', () => {
    const ENTRY_2 = '44444444-4444-4444-8444-444444444444'
    const CASH_KEY = 'bank:55555555-5555-4555-8555-555555555555'
    const SETTLEMENT_ID = '66666666-6666-4666-8666-666666666666'
    const previewSettlement = {
      settlement_id: null,
      account_number: '1930',
      entries: [
        { journal_entry_id: ENTRY, voucher_series: 'A', voucher_number: 12, entry_date: '2026-03-18', amount: -1250 },
        { journal_entry_id: ENTRY_2, voucher_series: 'A', voucher_number: 31, entry_date: '2026-04-21', amount: 1250 },
      ],
    }

    it('reconcile_match lets a pair omit external_ids, and says so in its schema', () => {
      const schema = tool('gnubok_reconcile_match').inputSchema as {
        properties: { pairs: { description: string; items: { required: string[] } } }
      }
      expect(schema.properties.pairs.items.required).toEqual(['journal_entry_ids'])
      expect(schema.properties.pairs.description).toMatch(/no rows/)
    })

    it('reconcile_match previews the pair through the same dry run and stages it as ONE pair with empty external_ids', async () => {
      const { supabase } = createQueuedMockSupabase()
      matchMock.mockResolvedValue({ dry_run: true, considered: 1, applied: [], settled: [previewSettlement], skipped: [] })

      const out = (await tool('gnubok_reconcile_match').execute(
        { account_key: CASH_KEY, pairs: [{ journal_entry_ids: [ENTRY, ENTRY_2] }], dry_run: true },
        COMPANY,
        USER,
        supabase as never,
        { type: 'api_key', id: 'key-1' } as never,
      )) as Record<string, unknown>

      // The engine sees the parsed pair: external_ids is an empty list, never undefined.
      expect(matchMock).toHaveBeenCalledWith(
        supabase,
        COMPANY,
        USER,
        CASH_KEY,
        { pairs: [{ external_ids: [], journal_entry_ids: [ENTRY, ENTRY_2] }], use_proposals: false, confidence_threshold: 0.9 },
        { dryRun: true },
      )
      expect(out).toMatchObject({ staged: false, dry_run: true, risk_level: 'medium' })
      const preview = out.preview as Record<string, unknown>
      expect(preview).toMatchObject({ account_key: CASH_KEY, pair_count: 1, source: 'explicit' })
      expect(preview.pairs).toEqual([{ external_ids: [], journal_entry_ids: [ENTRY, ENTRY_2] }])
      // The reviewer sees the verifikat and the amounts that sum to zero.
      expect(preview.settled).toEqual([previewSettlement])
    })

    it('reconcile_match stages a settlement next to an ordinary link in one operation', async () => {
      const { supabase } = createQueuedMockSupabase()
      matchMock.mockResolvedValue({
        dry_run: true,
        considered: 2,
        applied: [{ external_id: ROW, journal_entry_id: ENTRY }],
        settled: [previewSettlement],
        skipped: [],
      })
      const out = (await tool('gnubok_reconcile_match').execute(
        {
          account_key: CASH_KEY,
          pairs: [
            { external_ids: [ROW], journal_entry_ids: [ENTRY] },
            { external_ids: [], journal_entry_ids: [ENTRY, ENTRY_2] },
          ],
          dry_run: true,
        },
        COMPANY,
        USER,
        supabase as never,
      )) as Record<string, unknown>
      expect((out.preview as { pairs: unknown[] }).pairs).toEqual([
        { external_ids: [ROW], journal_entry_ids: [ENTRY] },
        { external_ids: [], journal_entry_ids: [ENTRY, ENTRY_2] },
      ])
    })

    it('reconcile_match refuses one verifikat with no outside row before the engine runs', async () => {
      const { supabase } = createQueuedMockSupabase()
      const err = await tool('gnubok_reconcile_match')
        .execute({ account_key: CASH_KEY, pairs: [{ journal_entry_ids: [ENTRY] }] }, COMPANY, USER, supabase as never)
        .then(() => null, (e: unknown) => e)
      const error = toToolError(err, { toolName: 'gnubok_reconcile_match' }).error
      expect(error.code).toBe('VALIDATION_ERROR')
      expect(error.message_en).toMatch(/^Invalid pairs: pairs\.0\.external_ids: /)
      expect(matchMock).not.toHaveBeenCalled()
    })

    it('reconcile_match with a refused settlement stages nothing and answers the policy code', async () => {
      const { supabase } = createQueuedMockSupabase()
      const pair = { external_ids: [], journal_entry_ids: [ENTRY, ENTRY_2] }
      matchMock.mockResolvedValue({
        dry_run: true,
        considered: 1,
        applied: [],
        settled: [],
        skipped: [{ pair, code: 'PAIR_NOT_CLOSED', message: 'Verifikaten tar inte ut varandra på konto 1930.' }],
      })
      const err = await tool('gnubok_reconcile_match')
        .execute({ account_key: CASH_KEY, pairs: [pair] }, COMPANY, USER, supabase as never)
        .then(() => null, (e: unknown) => e)
      const error = toToolError(err, { toolName: 'gnubok_reconcile_match' }).error
      expect(error.code).toBe('PAIR_NOT_CLOSED')
      expect(error.retryable).toBe(false)
    })

    it('reconcile_unmatch takes a settlement_id instead of external_id, and exactly one of them', async () => {
      const { supabase } = createQueuedMockSupabase()
      const out = (await tool('gnubok_reconcile_unmatch').execute(
        { account_key: CASH_KEY, settlement_id: SETTLEMENT_ID, dry_run: true },
        COMPANY,
        USER,
        supabase as never,
      )) as Record<string, unknown>
      expect(out).toMatchObject({ staged: false, dry_run: true, risk_level: 'low' })
      expect(out.preview).toEqual({ account_key: CASH_KEY, settlement_id: SETTLEMENT_ID })
      expect(out.next).toMatchObject({ args: { account_key: CASH_KEY, bucket: 'unmatched_ledger' } })

      for (const args of [
        { account_key: CASH_KEY, dry_run: true },
        { account_key: CASH_KEY, external_id: ROW, settlement_id: SETTLEMENT_ID, dry_run: true },
      ]) {
        const err = await tool('gnubok_reconcile_unmatch')
          .execute(args, COMPANY, USER, supabase as never)
          .then(() => null, (e: unknown) => e)
        expect(toToolError(err, { toolName: 'gnubok_reconcile_unmatch' }).error.code).toBe('VALIDATION_ERROR')
      }
    })
  })

  it('reconcile_unmatch dry-run returns the low-risk staging preview', async () => {
    const { supabase } = createQueuedMockSupabase()
    const out = (await tool('gnubok_reconcile_unmatch').execute(
      { account_key: 'skattekonto', external_id: ROW, dry_run: true },
      COMPANY,
      USER,
      supabase as never,
    )) as Record<string, unknown>
    expect(out).toMatchObject({ staged: false, dry_run: true, risk_level: 'low' })
    expect(out.preview).toEqual({ account_key: 'skattekonto', external_id: ROW })
  })
})

describe('gnubok_reconcile_signoff', () => {
  beforeEach(() => {
    signoffMock.mockReset()
  })

  it('is search-only, requires approval, and preflights on the status tool', () => {
    expect(isDefaultCatalogTool(tool('gnubok_reconcile_signoff'))).toBe(false)
    expect(deriveToolMeta(tool('gnubok_reconcile_signoff'))).toMatchObject({
      requires_approval: true,
      preflight: 'gnubok_get_reconciliation_status',
    })
  })

  it('dry-runs the policy first and stages reconciliation_signoff with the preview as the operation preview', async () => {
    const { supabase } = createQueuedMockSupabase()
    signoffMock.mockResolvedValue({
      dry_run: true,
      would_sign: { account_key: 'skattekonto', through_date: '2026-07-31', unexplained_difference: 0, is_reconciled: true, forced: false, previous_through_date: null },
    })
    const out = (await tool('gnubok_reconcile_signoff').execute(
      { account_key: 'skattekonto', through_date: '2026-07-31', dry_run: true },
      COMPANY,
      USER,
      supabase as never,
    )) as Record<string, unknown>
    expect(signoffMock).toHaveBeenCalledWith(
      supabase,
      COMPANY,
      USER,
      'skattekonto',
      { through_date: '2026-07-31', note: null, force: false, external_balance: null },
      { dryRun: true },
    )
    expect(out).toMatchObject({ staged: false, dry_run: true, risk_level: 'medium' })
    expect(out.next).toMatchObject({ tool: 'gnubok_get_reconciliation_status' })
    expect(out.preview).toMatchObject({ through_date: '2026-07-31', is_reconciled: true })
  })

  it('surfaces a policy refusal instead of staging', async () => {
    const { supabase } = createQueuedMockSupabase()
    signoffMock.mockRejectedValue(new Error('Kontot har en oförklarad differens.'))
    await expect(
      tool('gnubok_reconcile_signoff').execute(
        { account_key: 'skattekonto', through_date: '2026-07-31' },
        COMPANY,
        USER,
        supabase as never,
      ),
    ).rejects.toThrow(/oförklarad/)
  })

  it('rejects a malformed account_key before touching anything', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      tool('gnubok_reconcile_signoff').execute({ account_key: '1630', through_date: '2026-07-31' }, COMPANY, USER, supabase as never),
    ).rejects.toThrow(/Invalid account_key/)
    expect(signoffMock).not.toHaveBeenCalled()
  })
})

describe('gnubok_reconcile_residual', () => {
  const CASH = '11111111-1111-4111-8111-111111111111'
  const KEY = `bank:${CASH}`
  const T1 = '22222222-2222-4222-8222-222222222222'
  const E1 = '44444444-4444-4444-8444-444444444444'
  const wouldBook = {
    kind: 'bank_fee',
    counter_account: '6570',
    ledger_account: '1930',
    currency: 'SEK',
    transactions_total: -1010,
    entry_net: -1000,
    residual_amount: -10,
    entry_date: '2026-07-31',
    description: 'Bankavgift',
    lines: [
      { account_number: '6570', debit_amount: 10, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: 10 },
    ],
  }

  beforeEach(() => {
    residualMock.mockReset()
  })

  it('is search-only, requires approval, and preflights on the status tool', () => {
    expect(isDefaultCatalogTool(tool('gnubok_reconcile_residual'))).toBe(false)
    expect(deriveToolMeta(tool('gnubok_reconcile_residual'))).toMatchObject({
      requires_approval: true,
      preflight: 'gnubok_get_reconciliation_status',
    })
  })

  it('dry-runs the booking first and stages reconciliation_residual with the verifikat preview', async () => {
    const { supabase } = createQueuedMockSupabase()
    residualMock.mockResolvedValue({ dry_run: true, would_book: wouldBook })
    const out = (await tool('gnubok_reconcile_residual').execute(
      { account_key: KEY, external_ids: [T1], journal_entry_id: E1, kind: 'bank_fee', dry_run: true },
      COMPANY,
      USER,
      supabase as never,
    )) as Record<string, unknown>
    expect(residualMock).toHaveBeenCalledWith(
      supabase,
      COMPANY,
      USER,
      KEY,
      { external_ids: [T1], journal_entry_id: E1, kind: 'bank_fee', entry_date: undefined, description: undefined },
      { dryRun: true },
    )
    expect(out).toMatchObject({ staged: false, dry_run: true, risk_level: 'medium' })
    expect(out.next).toMatchObject({ tool: 'gnubok_get_reconciliation_status' })
    expect(out.preview).toMatchObject({ account_key: KEY, residual_amount: -10, counter_account: '6570', transaction_count: 1 })
  })

  it('surfaces a policy refusal (zero, cap, direction, skattekonto) instead of staging', async () => {
    const { supabase } = createQueuedMockSupabase()
    residualMock.mockRejectedValue(new Error('Restposten pekar åt fel håll för bank_fee.'))
    await expect(
      tool('gnubok_reconcile_residual').execute(
        { account_key: KEY, external_ids: [T1], journal_entry_id: E1, kind: 'bank_fee' },
        COMPANY,
        USER,
        supabase as never,
      ),
    ).rejects.toThrow(/fel håll/)
  })

  it('rejects a malformed account_key and an empty selection before touching anything', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      tool('gnubok_reconcile_residual').execute({ account_key: '1930', external_ids: [T1], journal_entry_id: E1, kind: 'bank_fee' }, COMPANY, USER, supabase as never),
    ).rejects.toThrow(/Invalid account_key/)
    await expect(
      tool('gnubok_reconcile_residual').execute({ account_key: KEY, external_ids: [], journal_entry_id: E1, kind: 'bank_fee' }, COMPANY, USER, supabase as never),
    ).rejects.toThrow(/1\.\.50/)
    expect(residualMock).not.toHaveBeenCalled()
  })
})
