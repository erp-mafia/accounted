import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const listAccountsMock = vi.fn()
const readinessMock = vi.fn()
vi.mock('@/lib/reconciliation/service', () => ({
  listReconciliationAccounts: (...args: unknown[]) => listAccountsMock(...args),
}))
vi.mock('@/lib/core/bookkeeping/year-end-service', () => ({
  validateYearEndReadiness: (...args: unknown[]) => readinessMock(...args),
}))

import {
  BOKSLUT_CHECKLIST,
  assembleChecklist,
  buildBokslutChecklist,
  computeAutoStates,
  setChecklistItem,
  type ChecklistRow,
} from '../checklist'

const COMPANY = 'company-1'
const USER = 'user-1'
const PERIOD = { id: 'fy-2026', name: 'Räkenskapsår 2026', period_start: '2026-01-01', period_end: '2026-12-31' }

function account(overrides: Record<string, unknown>) {
  return {
    account_key: 'manual:2350',
    kind: 'manual',
    account_number: '2350',
    name: 'Banklån',
    currency: 'SEK',
    logo_url: null,
    source: { type: 'manual', synced_at: null, stale: false },
    status: { state: 'open', as_of: '2026-12-31T00:00:00.000Z', unexplained_difference: null, open_counts: { proposed: 0, unmatched_external: 0, unmatched_ledger: 0 } },
    superseded_by: null,
    signed_off_through: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  listAccountsMock.mockReset()
  readinessMock.mockReset()
})

describe('catalogue', () => {
  it('has unique keys that satisfy the table CHECK, in work order', () => {
    const keys = BOKSLUT_CHECKLIST.map((d) => d.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const k of keys) expect(k).toMatch(/^[a-z0-9_]{1,64}$/)
    expect(keys[0]).toBe('bank_signed')
    expect(keys[keys.length - 1]).toBe('annual_accounts_reviewed')
  })
})

describe('computeAutoStates', () => {
  it('judges sign-offs through the balansdag, tie-outs, and readiness counts', () => {
    const accounts = [
      account({ account_key: 'bank:1', kind: 'bank', account_number: '1930', signed_off_through: '2026-12-31' }),
      account({ account_key: 'bank:2', kind: 'bank', account_number: '1931', signed_off_through: '2026-11-30', superseded_by: 'bank:1' }),
      account({ account_key: 'skattekonto', kind: 'skattekonto', account_number: '1630', signed_off_through: null }),
      account({ account_key: 'manual:1510', account_number: '1510', status: { state: 'reconciled', as_of: 'x', unexplained_difference: 0, open_counts: { proposed: 0, unmatched_external: 0, unmatched_ledger: 0 } } }),
      account({ account_key: 'manual:2350', signed_off_through: '2026-12-31' }),
      account({ account_key: 'manual:2990', account_number: '2990', signed_off_through: '2026-06-30' }),
    ]
    const states = computeAutoStates(accounts as never, { draftCount: 2, unexplainedGaps: 0, trialBalanceBalanced: true }, '2026-12-31')
    expect(Object.fromEntries(states)).toEqual({
      bank_signed: 'done',
      skattekonto_signed: 'open',
      ar_reconciled: 'done',
      ap_reconciled: 'not_applicable',
      balance_accounts_signed: 'open',
      no_drafts: 'open',
      voucher_gaps_explained: 'done',
      trial_balance_balanced: 'done',
    })
  })

  it('marks feeds the company does not have as not applicable and leaves unknown inputs out', () => {
    const states = computeAutoStates([], null, '2026-12-31')
    expect(states.get('bank_signed')).toBe('not_applicable')
    expect(states.get('skattekonto_signed')).toBe('not_applicable')
    expect(states.has('no_drafts')).toBe(false)
    expect(computeAutoStates(null, null, '2026-12-31').size).toBe(0)
  })
})

describe('assembleChecklist', () => {
  it('lets a stored row override the computed state and counts the summary', () => {
    const rows: ChecklistRow[] = [
      { item_key: 'skattekonto_signed', state: 'not_applicable', note: 'Inget skattekonto kopplat', done_by: USER, done_at: '2027-01-05T08:00:00Z', updated_by: USER, updated_at: '2027-01-05T08:00:00Z' },
      { item_key: 'inventory_valued', state: 'done', note: null, done_by: USER, done_at: '2027-01-06T08:00:00Z', updated_by: USER, updated_at: '2027-01-06T08:00:00Z' },
    ]
    const auto = new Map([['skattekonto_signed', 'open' as const], ['no_drafts', 'done' as const]])
    const list = assembleChecklist(PERIOD, auto, rows)
    const byKey = Object.fromEntries(list.items.map((i) => [i.key, i]))
    expect(byKey.skattekonto_signed).toMatchObject({ auto_state: 'open', stored_state: 'not_applicable', effective_state: 'not_applicable', note: 'Inget skattekonto kopplat' })
    expect(byKey.inventory_valued).toMatchObject({ auto_state: null, effective_state: 'done', done_at: '2027-01-06T08:00:00Z' })
    expect(byKey.no_drafts).toMatchObject({ auto_state: 'done', stored_state: null, effective_state: 'done' })
    expect(byKey.accruals_posted.effective_state).toBe('open')
    expect(list.summary).toEqual({ total: BOKSLUT_CHECKLIST.length, done: 2, not_applicable: 1, open: BOKSLUT_CHECKLIST.length - 3 })
  })
})

describe('buildBokslutChecklist', () => {
  it('reads the period and rows, computes readiness when not given, and survives a failed reconciliation read', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: PERIOD })
    enqueue({ data: [{ item_key: 'inventory_valued', state: 'done', note: null, done_by: USER, done_at: '2027-01-06T08:00:00Z', updated_by: USER, updated_at: '2027-01-06T08:00:00Z' }] })
    listAccountsMock.mockRejectedValue(new Error('down'))
    readinessMock.mockResolvedValue({ draftCount: 0, unexplainedGaps: [{ series: 'A', from: 12, to: 12 }], trialBalanceBalanced: true })

    const list = await buildBokslutChecklist(supabase as never, COMPANY, USER, 'fy-2026')
    expect(list?.period.id).toBe('fy-2026')
    const byKey = Object.fromEntries(list!.items.map((i) => [i.key, i]))
    expect(byKey.inventory_valued.effective_state).toBe('done')
    expect(byKey.voucher_gaps_explained.effective_state).toBe('open')
    expect(byKey.bank_signed).toMatchObject({ auto_state: null, effective_state: 'open' })
    expect(listAccountsMock).toHaveBeenCalledWith(supabase, COMPANY, { today: '2026-12-31', windowFrom: '2026-01-01', windowTo: '2026-12-31' })
    expect(readinessMock).toHaveBeenCalledWith(supabase, COMPANY, USER, 'fy-2026')
  })

  it('skips the readiness computation when told to, and returns null for a foreign period', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: PERIOD })
    enqueue({ data: [] })
    listAccountsMock.mockResolvedValue([])
    await buildBokslutChecklist(supabase as never, COMPANY, USER, 'fy-2026', { readiness: null })
    expect(readinessMock).not.toHaveBeenCalled()

    enqueue({ data: null })
    expect(await buildBokslutChecklist(supabase as never, COMPANY, USER, 'nope')).toBeNull()
  })
})

describe('setChecklistItem', () => {
  it('upserts as the acting user with the done stamp, and refuses unknown items or bad states', async () => {
    const { supabase, enqueue, findCall, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { item_key: 'inventory_valued', state: 'done', note: 'Inventerat 2026-12-30', done_by: USER, done_at: 'x', updated_by: USER, updated_at: 'x' } })
    const row = await setChecklistItem(supabase as never, COMPANY, USER, 'fy-2026', { item_key: 'inventory_valued', state: 'done', note: ' Inventerat 2026-12-30 ' })
    expect(row.state).toBe('done')
    const [payload, opts] = findCall('bokslut_checklist_items', 'upsert') as [Record<string, unknown>, { onConflict: string }]
    expect(payload).toMatchObject({ company_id: COMPANY, fiscal_period_id: 'fy-2026', item_key: 'inventory_valued', state: 'done', note: 'Inventerat 2026-12-30', done_by: USER, updated_by: USER })
    expect(payload.done_at).toBeTruthy()
    expect(opts.onConflict).toBe('company_id,fiscal_period_id,item_key')

    enqueue({ data: { item_key: 'inventory_valued', state: 'open', note: null, done_by: null, done_at: null, updated_by: USER, updated_at: 'x' } })
    await setChecklistItem(supabase as never, COMPANY, USER, 'fy-2026', { item_key: 'inventory_valued', state: 'open' })
    const upserts = findCalls('bokslut_checklist_items', 'upsert')
    const [reopened] = upserts[upserts.length - 1] as [Record<string, unknown>]
    expect(reopened).toMatchObject({ done_by: null, done_at: null })

    await expect(setChecklistItem(supabase as never, COMPANY, USER, 'fy-2026', { item_key: 'nope', state: 'done' })).rejects.toMatchObject({ code: 'UNKNOWN_ITEM' })
    await expect(setChecklistItem(supabase as never, COMPANY, USER, 'fy-2026', { item_key: 'no_drafts', state: 'maybe' as never })).rejects.toMatchObject({ code: 'INVALID_STATE' })
  })
})
