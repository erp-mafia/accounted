import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const listAccountsMock = vi.fn()
const snapshotMock = vi.fn()
const specMock = vi.fn()
const latestSignoffsMock = vi.fn()
const attachmentsMock = vi.fn()
const checklistMock = vi.fn()

vi.mock('@/lib/reconciliation/service', () => ({
  listReconciliationAccounts: (...args: unknown[]) => listAccountsMock(...args),
}))
vi.mock('@/lib/reconciliation/manual-reconciliation', async () => {
  const actual = await vi.importActual<typeof import('@/lib/reconciliation/manual-reconciliation')>('@/lib/reconciliation/manual-reconciliation')
  return {
    ...actual,
    loadBalanceSheetSnapshot: (...args: unknown[]) => snapshotMock(...args),
    loadSpecificationAmounts: (...args: unknown[]) => specMock(...args),
  }
})
vi.mock('@/lib/reconciliation/signoff-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/reconciliation/signoff-store')>('@/lib/reconciliation/signoff-store')
  return { ...actual, getLatestSignoffs: (...args: unknown[]) => latestSignoffsMock(...args) }
})
vi.mock('@/lib/reconciliation/attachments-store', () => ({
  listAttachmentRowsInRange: (...args: unknown[]) => attachmentsMock(...args),
}))
vi.mock('@/lib/bokslut/checklist', () => ({
  buildBokslutChecklist: (...args: unknown[]) => checklistMock(...args),
}))

import { generateBokslutsbilagor } from '../bokslutsbilagor'

const COMPANY = 'company-1'
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
    status: null,
    superseded_by: null,
    signed_off_through: null,
    ...overrides,
  }
}

function signoffRow(overrides: Record<string, unknown>) {
  return {
    id: 's1',
    account_key: 'manual:2350',
    through_date: '2026-12-31',
    external_balance: -250000,
    ledger_balance: -250000,
    unexplained_difference: 0,
    note: 'Enligt engagemangsbesked',
    signed_by: 'u1',
    signed_at: '2027-01-10T08:00:00Z',
    reopened_at: null,
    reopened_by: null,
    reopen_reason: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const m of [listAccountsMock, snapshotMock, specMock, latestSignoffsMock, attachmentsMock, checklistMock]) m.mockReset()
  listAccountsMock.mockResolvedValue([
    account({ account_key: 'bank:11111111-1111-4111-8111-111111111111', kind: 'bank', account_number: '1930', name: 'Företagskonto' }),
    account({ account_key: 'manual:1510', account_number: '1510', name: 'Kundfordringar' }),
    account({}),
  ])
  snapshotMock.mockResolvedValue({
    period: PERIOD,
    as_of: '2026-12-31',
    rows: new Map([
      ['1930', { account_number: '1930', account_name: 'Företagskonto', opening_balance: 50000, movement: 12000, closing_balance: 62000 }],
      ['1510', { account_number: '1510', account_name: 'Kundfordringar', opening_balance: 8000, movement: 4000, closing_balance: 12000 }],
      ['2350', { account_number: '2350', account_name: 'Banklån', opening_balance: -260000, movement: 10000, closing_balance: -250000 }],
    ]),
  })
  specMock.mockResolvedValue(new Map([['1510', { amount: 11500, unconverted_fx_count: 0 }]]))
  latestSignoffsMock.mockResolvedValue(new Map([['bank:11111111-1111-4111-8111-111111111111', signoffRow({ id: 's-bank', account_key: 'bank:11111111-1111-4111-8111-111111111111', through_date: '2026-11-30', external_balance: 61000, ledger_balance: 61000, note: null, signed_by: 'u2' })]]))
  attachmentsMock.mockResolvedValue([
    { id: 'a1', account_key: 'manual:2350', through_date: '2026-12-31', file_name: 'engagemangsbesked.pdf', mime_type: 'application/pdf', size_bytes: 100, storage_bucket: 'documents', storage_path: 'x', sha256: 'ab'.repeat(32), note: null, uploaded_by: 'u1', uploaded_at: '2027-01-09T08:00:00Z', removed_at: null, removed_by: null, removed_reason: null },
    { id: 'a2', account_key: 'manual:2350', through_date: '2026-12-31', file_name: 'fel.pdf', mime_type: 'application/pdf', size_bytes: 100, storage_bucket: 'documents', storage_path: 'y', sha256: 'cd'.repeat(32), note: null, uploaded_by: 'u1', uploaded_at: '2027-01-09T08:00:00Z', removed_at: '2027-01-09T09:00:00Z', removed_by: 'u1', removed_reason: 'fel fil' },
  ])
  checklistMock.mockResolvedValue({
    period: PERIOD,
    items: [{ key: 'inventory_valued', group: 'vardering', label_sv: 'Varulager', label_en: 'Inventory', auto: false, auto_state: null, stored_state: 'done', effective_state: 'done', note: null, done_by: 'u1', done_at: '2027-01-06T08:00:00Z' }],
    summary: { total: 1, done: 1, not_applicable: 0, open: 0 },
  })
})

describe('generateBokslutsbilagor', () => {
  it('builds one bilaga per account from the snapshot, the sign-offs, the specification and the files', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: PERIOD }) // fiscal period
    enqueue({ data: { name: 'Väla Redovisning AB', org_number: '5592383508' } }) // company
    enqueue({ data: [signoffRow({})] }) // sign-offs on the balansdag

    const report = await generateBokslutsbilagor(supabase as never, COMPANY, 'fy-2026', {
      userId: 'u1',
      appVersion: '1.2.3',
      resolveUserLabels: async (ids) => new Map(ids.map((id) => [id, `${id}@example.se`])),
    })
    expect(report).not.toBeNull()
    expect(report!.company).toEqual({ name: 'Väla Redovisning AB', org_number: '5592383508' })
    expect(report!.accounts.map((a) => a.account_number)).toEqual(['1930', '1510', '2350'])

    const [bank, ar, loan] = report!.accounts
    // Bank: latest sign-off is not the balansdag, so it is flagged; the outside balance is unknown for the balansdag.
    expect(bank).toMatchObject({ closing_balance: 62000, external_balance: null, difference: null })
    expect(bank.signoff).toMatchObject({ on_balansdag: false, through_date: '2026-11-30', signed_by_label: 'u2@example.se' })
    // AR: system specification, difference against the booked balance.
    expect(ar).toMatchObject({ external_balance: 11500, closing_balance: 12000, difference: 500, external_label_sv: 'Kundreskontra, öppna fakturor' })
    expect(ar.signoff).toBeNull()
    // Loan: stated balance from the balansdag sign-off, one active file, one removed.
    expect(loan).toMatchObject({ opening_balance: -260000, movement: 10000, closing_balance: -250000, external_balance: -250000, difference: 0 })
    expect(loan.signoff).toMatchObject({ on_balansdag: true, note: 'Enligt engagemangsbesked', signed_by_label: 'u1@example.se' })
    expect(loan.attachments.map((a) => [a.file_name, a.removed_at != null])).toEqual([['engagemangsbesked.pdf', false], ['fel.pdf', true]])

    expect(report!.summary).toEqual({ accounts: 3, signed_on_balansdag: 1, signed_other_date: 1, unsigned: 1, attachments: 1 })
    expect(report!.checklist.items[0]).toMatchObject({ key: 'inventory_valued', state: 'done', done_by_label: 'u1@example.se' })
    expect(report!.app_version).toBe('1.2.3')
    expect(checklistMock).toHaveBeenCalledWith(supabase, COMPANY, 'u1', 'fy-2026', {})
    expect(listAccountsMock).toHaveBeenCalledWith(supabase, COMPANY, { today: '2026-12-31', windowFrom: '2026-01-01', windowTo: '2026-12-31' })
  })

  it('skips the readiness-derived checklist items without a user, and returns null for a foreign period', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: PERIOD })
    enqueue({ data: { name: 'X', org_number: null } })
    enqueue({ data: [] })
    await generateBokslutsbilagor(supabase as never, COMPANY, 'fy-2026')
    expect(checklistMock).toHaveBeenCalledWith(supabase, COMPANY, '', 'fy-2026', { readiness: null })

    enqueue({ data: null })
    enqueue({ data: null })
    expect(await generateBokslutsbilagor(supabase as never, COMPANY, 'nope')).toBeNull()
  })

  it('survives a failed snapshot, sign-off or attachment read', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: PERIOD })
    enqueue({ data: { name: 'X', org_number: null } })
    enqueue({ data: null, error: { message: 'boom' } })
    snapshotMock.mockRejectedValue(new Error('tb down'))
    attachmentsMock.mockRejectedValue(new Error('storage down'))
    latestSignoffsMock.mockRejectedValue(new Error('signoffs down'))
    const report = await generateBokslutsbilagor(supabase as never, COMPANY, 'fy-2026', { userId: 'u1' })
    expect(report!.accounts).toHaveLength(3)
    expect(report!.accounts.every((a) => a.closing_balance === null && a.signoff === null && a.attachments.length === 0)).toBe(true)
    expect(specMock).not.toHaveBeenCalled()
  })
})
