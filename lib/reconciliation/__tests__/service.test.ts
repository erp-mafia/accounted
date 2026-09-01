import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const skattekontoStatusMock = vi.fn()
const bankStatusMock = vi.fn()

vi.mock('../skattekonto-reconciliation', () => ({
  getSkattekontoReconciliationStatus: (...args: unknown[]) => skattekontoStatusMock(...args),
}))
vi.mock('../bank-reconciliation', () => ({
  getReconciliationStatus: (...args: unknown[]) => bankStatusMock(...args),
}))
const listManualMock = vi.fn()
const manualStatusMock = vi.fn()
vi.mock('../manual-reconciliation', () => ({
  listManualAccounts: (...args: unknown[]) => listManualMock(...args),
  getManualReconciliationStatus: (...args: unknown[]) => manualStatusMock(...args),
}))

import { bankAccountKey, parseAccountKey } from '../schemas'
import { getAccountStatus, listReconciliationAccounts } from '../service'

const COMPANY = 'company-1'
const ID_A = '11111111-1111-4111-8111-111111111111'
const ID_B = '22222222-2222-4222-8222-222222222222'
const ID_C = '33333333-3333-4333-8333-333333333333'

function cashAccount(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `Konto ${id.slice(0, 2)}`,
    ledger_account: '1930',
    currency: 'SEK',
    iban: null,
    enabled: true,
    is_primary: false,
    source: 'enable_banking',
    bank_connection_id: 'conn-1',
    updated_at: '2026-08-01T00:00:00Z',
    ...overrides,
  }
}

function bankStatus(overrides: Record<string, unknown> = {}) {
  return {
    currency: 'SEK',
    bank_transaction_total: 100,
    ignored_transaction_total: 0,
    ignored_transaction_count: 0,
    gl_1930_balance: 100,
    gl_1930_period_movement: 100,
    gl_1930_opening_balance: 0,
    gl_1930_correction_adjustment: 0,
    difference: 0,
    is_reconciled: true,
    matched_count: 3,
    unmatched_transaction_count: 0,
    unmatched_transaction_total: 0,
    unmatched_gl_line_count: 0,
    unmatched_gl_line_total: 0,
    unexplained_difference: 0,
    unconvertible_gl_line_count: 0,
    not_reconcilable_reason: null,
    ...overrides,
  }
}

describe('account keys', () => {
  it('parses the three kinds and rejects anything else', () => {
    expect(parseAccountKey(bankAccountKey(ID_A))).toEqual({ kind: 'bank', cashAccountId: ID_A })
    expect(parseAccountKey('skattekonto')).toEqual({ kind: 'skattekonto' })
    expect(parseAccountKey('manual:1910')).toEqual({ kind: 'manual', accountNumber: '1910' })
    expect(parseAccountKey('bank:not-a-uuid')).toBeNull()
    expect(parseAccountKey('1930')).toBeNull()
    expect(parseAccountKey('')).toBeNull()
  })
})

describe('listReconciliationAccounts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    skattekontoStatusMock.mockReset()
    bankStatusMock.mockReset()
    listManualMock.mockReset()
    listManualMock.mockResolvedValue([])
  })

  it('appends the manual accounts after the fed ones, excluding the accounts the feeds own', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [cashAccount(ID_A, { is_primary: true }), cashAccount(ID_C, { ledger_account: '1931', iban: 'SE2' })] })
    enqueue({ data: [{ id: 's1', account_key: 'manual:2440', through_date: '2026-06-30', reopened_at: null }] }) // latest sign-offs
    enqueue({ data: [] }) // bank names for logos
    enqueue({ data: null })
    enqueue({ data: null })
    skattekontoStatusMock.mockResolvedValue({
      account_key: 'skattekonto',
      kind: 'skattekonto',
      account_number: '1630',
      currency: 'SEK',
      as_of: '2026-08-20T04:00:00.000Z',
      stale: false,
      is_reconciled: true,
      unexplained_difference: 0,
      counts: { proposed: 0, unmatched_external: 0, unmatched_ledger: 0, matched: 1, ignored: 0 },
      skattekonto: { fetched_at: '2026-08-20T04:00:00.000Z' },
    })
    listManualMock.mockResolvedValue([
      { account_key: 'manual:1510', kind: 'manual', account_number: '1510', name: 'Kundfordringar' },
      { account_key: 'manual:2440', kind: 'manual', account_number: '2440', name: 'Leverantörsskulder' },
    ])

    const accounts = await listReconciliationAccounts(supabase as never, COMPANY, {
      today: '2026-08-20',
      windowFrom: '2026-01-01',
      windowTo: '2026-07-31',
      withStatus: false,
    })

    expect(accounts.map((a) => a.account_key)).toEqual([
      bankAccountKey(ID_A),
      bankAccountKey(ID_C),
      'skattekonto',
      'manual:1510',
      'manual:2440',
    ])
    const [, , opts] = listManualMock.mock.calls[0] as [unknown, unknown, { asOf: string; exclude: Set<string>; withStatus: boolean; signoffs: Map<string, unknown> }]
    expect(opts.asOf).toBe('2026-07-31')
    expect([...opts.exclude].sort()).toEqual(['1630', '1930', '1931'])
    expect(opts.withStatus).toBe(false)
    expect(opts.signoffs.has('manual:2440')).toBe(true)
  })

  it('keeps the fed accounts when the manual read fails', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [cashAccount(ID_A, { is_primary: true })] })
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ data: null })
    skattekontoStatusMock.mockResolvedValue(null)
    listManualMock.mockRejectedValue(new Error('trial balance down'))

    const accounts = await listReconciliationAccounts(supabase as never, COMPANY, { today: '2026-08-20', withStatus: false })
    expect(accounts.map((a) => a.account_key)).toEqual([bankAccountKey(ID_A)])
  })

  it('lists enabled cash accounts, folds reconnect duplicates by IBAN, and appends the skattekonto when configured', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        cashAccount(ID_A, { is_primary: true, iban: 'SE1', updated_at: '2026-08-10T00:00:00Z' }),
        cashAccount(ID_B, { iban: 'SE1', updated_at: '2026-06-01T00:00:00Z' }),
        cashAccount(ID_C, { ledger_account: '1931', iban: 'SE2' }),
      ],
    })
    enqueue({ data: [] }) // latest sign-offs (none)
    enqueue({ data: [{ id: 'conn-1', bank_name: 'Swedbank' }] }) // bank names for logos
    // latestBankSyncAt per account (withStatus=false skips bankStatus): three maybeSingle reads
    enqueue({ data: { created_at: '2026-08-19T06:00:00Z' } })
    enqueue({ data: { created_at: '2026-06-01T06:00:00Z' } })
    enqueue({ data: null })
    skattekontoStatusMock.mockResolvedValue({
      account_key: 'skattekonto',
      kind: 'skattekonto',
      account_number: '1630',
      currency: 'SEK',
      as_of: '2026-08-20T04:00:00.000Z',
      stale: false,
      is_reconciled: false,
      unexplained_difference: 0,
      counts: { proposed: 2, unmatched_external: 3, unmatched_ledger: 1, matched: 41, ignored: 0 },
      skattekonto: { fetched_at: '2026-08-20T04:00:00.000Z' },
    })

    const accounts = await listReconciliationAccounts(supabase as never, COMPANY, {
      today: '2026-08-20',
      withStatus: false,
    })

    expect(accounts.map((a) => a.account_key)).toEqual([
      bankAccountKey(ID_A),
      bankAccountKey(ID_B),
      bankAccountKey(ID_C),
      'skattekonto',
    ])
    const byKey = Object.fromEntries(accounts.map((a) => [a.account_key, a]))
    // The older duplicate is marked, never dropped.
    expect(byKey[bankAccountKey(ID_B)].superseded_by).toBe(bankAccountKey(ID_A))
    expect(byKey[bankAccountKey(ID_A)].superseded_by).toBeNull()
    expect(byKey[bankAccountKey(ID_C)].superseded_by).toBeNull()
    // The connection's bank name resolves to the committed brand icon.
    expect(byKey[bankAccountKey(ID_A)].logo_url).toBe('/logos/banks/swedbank.png')
    // Sync age drives staleness (7 days).
    expect(byKey[bankAccountKey(ID_A)].source).toMatchObject({ type: 'psd2', stale: false })
    expect(byKey[bankAccountKey(ID_B)].source.stale).toBe(true)
    expect(byKey[bankAccountKey(ID_C)].source).toMatchObject({ synced_at: null, stale: true })
    expect(byKey[bankAccountKey(ID_A)].status).toBeNull()
    // Skattekonto row carries the logo and the open counts.
    expect(byKey.skattekonto).toMatchObject({
      logo_url: '/logos/skatteverket_color.svg',
      source: { type: 'skatteverket_api', stale: false },
      status: { state: 'open', open_counts: { proposed: 2, unmatched_external: 3, unmatched_ledger: 1 } },
    })
  })

  it('omits the skattekonto when the company has neither snapshot nor rows', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [cashAccount(ID_A, { is_primary: true })] })
    enqueue({ data: [] }) // latest sign-offs (none)
    enqueue({ data: [] }) // bank names for logos
    enqueue({ data: null })
    skattekontoStatusMock.mockResolvedValue(null)

    const accounts = await listReconciliationAccounts(supabase as never, COMPANY, {
      today: '2026-08-20',
      withStatus: false,
    })
    expect(accounts.map((a) => a.kind)).toEqual(['bank'])
  })

  it('computes the bank status through the existing engine with the account scope and maps it to the common shape', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [cashAccount(ID_A, { is_primary: true, currency: 'SEK' })] })
    enqueue({ data: [] }) // latest sign-offs (none)
    enqueue({ data: [] }) // bank names for logos
    bankStatusMock.mockResolvedValue(bankStatus({ unmatched_transaction_count: 2, unmatched_transaction_total: -1046, is_reconciled: false }))
    enqueue({ data: { created_at: '2026-08-20T06:00:00Z' } }) // latestBankSyncAt inside bankStatus
    enqueue({ data: { created_at: '2026-08-20T06:00:00Z' } }) // latestBankSyncAt for the account row
    skattekontoStatusMock.mockResolvedValue(null)

    const accounts = await listReconciliationAccounts(supabase as never, COMPANY, {
      today: '2026-08-20',
      windowFrom: '2026-01-01',
      windowTo: '2026-08-20',
    })

    expect(bankStatusMock).toHaveBeenCalledWith(
      supabase,
      COMPANY,
      '2026-01-01',
      '2026-08-20',
      '1930',
      'SEK',
      ID_A,
      true,
    )
    expect(accounts[0].status).toMatchObject({
      state: 'open',
      open_counts: { proposed: 0, unmatched_external: 2, unmatched_ledger: 0 },
      unexplained_difference: 0,
    })
  })
})

describe('getAccountStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    skattekontoStatusMock.mockReset()
    bankStatusMock.mockReset()
    manualStatusMock.mockReset()
  })

  function manualStatus(overrides: Record<string, unknown> = {}) {
    return {
      account_key: 'manual:2350',
      kind: 'manual',
      account_number: '2350',
      currency: 'SEK',
      as_of: '2026-07-31T00:00:00.000Z',
      stale: false,
      external_balance: null,
      ledger_balance: -250000,
      difference: null,
      unexplained_difference: null,
      is_reconciled: false,
      bridge: [],
      counts: { proposed: 0, unmatched_external: 0, unmatched_ledger: 0, matched: 0, ignored: 0 },
      skattekonto: null,
      bank: null,
      manual: { specification: null },
      ...overrides,
    }
  }

  it('dispatches manual keys to the manual adapter with the window end as the balansdag', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    manualStatusMock.mockResolvedValue(manualStatus())
    enqueue({ data: null }) // latest sign-off
    const s = await getAccountStatus(supabase as never, COMPANY, 'manual:2350', { today: '2026-08-20', windowTo: '2026-07-31' })
    expect(manualStatusMock).toHaveBeenCalledWith(supabase, COMPANY, '2350', { today: '2026-08-20', asOf: '2026-07-31' })
    expect(s).toMatchObject({ account_key: 'manual:2350', external_balance: null, signoff: null })
  })

  it('shows the stated balance from a sign-off made for the same balansdag as the outside side', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    manualStatusMock.mockResolvedValue(manualStatus())
    enqueue({
      data: {
        id: 's1',
        account_key: 'manual:2350',
        through_date: '2026-07-31',
        external_balance: -250000,
        ledger_balance: -250000,
        unexplained_difference: 0,
        note: 'Enligt engagemangsbesked',
        signed_by: 'u1',
        signed_at: '2026-08-01T08:00:00Z',
        reopened_at: null,
        reopened_by: null,
        reopen_reason: null,
      },
    })
    const s = await getAccountStatus(supabase as never, COMPANY, 'manual:2350', { today: '2026-08-20', windowTo: '2026-07-31' })
    expect(s).toMatchObject({ external_balance: -250000, difference: 0, unexplained_difference: 0, is_reconciled: true })
  })

  it('leaves the outside side unknown when the sign-off was for another date', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    manualStatusMock.mockResolvedValue(manualStatus())
    enqueue({ data: { id: 's1', account_key: 'manual:2350', through_date: '2026-06-30', external_balance: -260000, reopened_at: null } })
    const s = await getAccountStatus(supabase as never, COMPANY, 'manual:2350', { today: '2026-08-20', windowTo: '2026-07-31' })
    expect(s).toMatchObject({ external_balance: null, unexplained_difference: null, is_reconciled: false })
  })

  it('returns null for an invalid key and for an unknown cash account', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    expect(await getAccountStatus(supabase as never, COMPANY, 'nope')).toBeNull()
    enqueue({ data: null })
    expect(await getAccountStatus(supabase as never, COMPANY, bankAccountKey(ID_A))).toBeNull()
  })

  it('dispatches skattekonto to its engine with the window', async () => {
    const { supabase } = createQueuedMockSupabase()
    skattekontoStatusMock.mockResolvedValue({ account_key: 'skattekonto' })
    const s = await getAccountStatus(supabase as never, COMPANY, 'skattekonto', {
      today: '2026-08-20',
      windowFrom: '2026-07-01',
      windowTo: '2026-07-31',
    })
    expect(s).toEqual({ account_key: 'skattekonto', signoff: null })
    expect(skattekontoStatusMock).toHaveBeenCalledWith(supabase, COMPANY, {
      today: '2026-08-20',
      windowFrom: '2026-07-01',
      windowTo: '2026-07-31',
    })
  })

  it('builds the bank bridge in the #1737 shape', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: cashAccount(ID_A, { is_primary: true }) })
    bankStatusMock.mockResolvedValue(
      bankStatus({
        bank_transaction_total: 122288,
        gl_1930_period_movement: 122334,
        difference: -46,
        unmatched_transaction_total: -1046,
        unmatched_transaction_count: 1,
        unmatched_gl_line_total: -1000,
        unmatched_gl_line_count: 1,
        unexplained_difference: 0,
        is_reconciled: false,
      }),
    )
    enqueue({ data: { created_at: '2026-08-20T06:00:00Z' } })

    const s = await getAccountStatus(supabase as never, COMPANY, bankAccountKey(ID_A), { today: '2026-08-20' })
    if (!s) throw new Error('expected status')
    expect(s.kind).toBe('bank')
    expect(s.bridge.map((b) => [b.key, b.amount])).toEqual([
      ['bank_transactions', 122288],
      ['unmatched_external', 1046],
      ['unmatched_ledger', -1000],
      ['ledger_balance', 122334],
    ])
    expect(s.unexplained_difference).toBe(0)
    expect(s.bank).toMatchObject({ bank_transaction_total: 122288 })
  })

  it('exposes the bank-reported balance from cash_accounts on the bank kind (F7)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: cashAccount(ID_A, {
        balance: 125430.5,
        available_balance: 123930.5,
        balance_updated_at: '2026-08-20T05:12:00Z',
      }),
    })
    bankStatusMock.mockResolvedValue(bankStatus({ difference: -46, unexplained_difference: 0 }))
    enqueue({ data: { created_at: '2026-08-20T06:00:00Z' } })

    const s = await getAccountStatus(supabase as never, COMPANY, bankAccountKey(ID_A), { today: '2026-08-20' })
    if (!s) throw new Error('expected status')
    // external_balance is the reported point-in-time balance; the movement-based
    // difference figures stay exactly what the engine computed.
    expect(s.external_balance).toBe(125430.5)
    expect(s.difference).toBe(-46)
    expect(s.unexplained_difference).toBe(0)
    expect(s.bank).toMatchObject({
      bank_reported_balance: 125430.5,
      bank_reported_available_balance: 123930.5,
      bank_balance_updated_at: '2026-08-20T05:12:00Z',
    })
  })

  it('leaves external_balance null on the bank kind when no balance was ever synced', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: cashAccount(ID_A, { balance: null, available_balance: null, balance_updated_at: null }) })
    bankStatusMock.mockResolvedValue(bankStatus())
    enqueue({ data: { created_at: '2026-08-20T06:00:00Z' } })

    const s = await getAccountStatus(supabase as never, COMPANY, bankAccountKey(ID_A), { today: '2026-08-20' })
    if (!s) throw new Error('expected status')
    expect(s.external_balance).toBeNull()
    expect(s.bank).toMatchObject({
      bank_reported_balance: null,
      bank_reported_available_balance: null,
      bank_balance_updated_at: null,
    })
  })
})
