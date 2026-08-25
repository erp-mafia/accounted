/**
 * The account-keyed reconciliation tools: status (account_key branch), items,
 * reconcile_match (stages; dry_run previews), reconcile_unmatch (search-only).
 * Service functions are mocked; the staging path runs for real in dry_run
 * mode (no insert), so the STAGED_OPERATION_SCHEMA contract is exercised.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

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
    expect(isDefaultCatalogTool(tool('gnubok_reconcile_match'))).toBe(false)
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

  it('status with an unknown account_key throws', async () => {
    const { supabase } = createQueuedMockSupabase()
    statusMock.mockResolvedValue(null)
    await expect(
      tool('gnubok_get_reconciliation_status').execute({ account_key: 'skattekonto' }, COMPANY, USER, supabase as never),
    ).rejects.toThrow(/Unknown account_key/)
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

  it('reconcile_match refuses an empty request and a request with nothing linkable', async () => {
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
      { through_date: '2026-07-31', note: null, force: false },
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
