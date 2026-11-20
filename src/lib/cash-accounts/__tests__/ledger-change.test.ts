import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import type { Logger } from '@/lib/logger'

const emit = vi.fn()
vi.mock('@/lib/events/bus', () => ({ eventBus: { emit: (...a: unknown[]) => emit(...a) } }))

const requireCompanyAdmin = vi.fn()
vi.mock('@/lib/operations/access', () => ({ requireCompanyAdmin: (...a: unknown[]) => requireCompanyAdmin(...a) }))

const prepareTwins = vi.fn()
const applyTwins = vi.fn()
vi.mock('@/lib/composition/ledger-move-twins', () => ({
  LEDGER_MOVE_TWINS: {
    module: 'transactions',
    prepare: (...a: unknown[]) => prepareTwins(...a),
    apply: (...a: unknown[]) => applyTwins(...a),
  },
}))

import { changeBankAccountLedgers, changeCashAccountLedgers } from '../ledger-change'
import { getErrorEntry } from '@/lib/errors/structured-errors'

const COMPANY = 'company-1'
const CONNECTION = 'conn-1'

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger

function account(uid: string, overrides: Record<string, unknown> = {}) {
  return { uid, name: `Konto ${uid}`, iban: `SE000000000000000000${uid}`, currency: 'SEK', enabled: true, ...overrides }
}

function cashRow(id: string, uid: string | null, ledger: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    ledger_account: ledger,
    bank_connection_id: uid ? CONNECTION : null,
    external_uid: uid,
    iban: uid ? `SE000000000000000000${uid}` : null,
    currency: 'SEK',
    ...overrides,
  }
}

function setup(options: {
  accounts: unknown[]
  cash: unknown[]
  status?: string
  aggregator?: string
  booked?: number
  unbooked?: number
  readError?: { code: string; message: string }
  saveError?: { code: string; message: string; details?: string }
  /** cash_account_retirement_dependencies() per cash account id. */
  dependencies?: Record<string, string[]>
  dependenciesError?: { code: string; message: string }
}) {
  const mock = createTableMockSupabase({
    'rpc:read_bank_configuration': options.readError
      ? { error: options.readError }
      : {
          data: {
            token: 'token-1',
            connection: {
              id: CONNECTION,
              status: options.status ?? 'active',
              session_id: 'session-1',
              bank_name: 'Testbanken',
              accounts_data: options.accounts,
              aggregator: options.aggregator ?? 'open_payments',
            },
          },
        },
    cash_accounts: { data: options.cash },
    'rpc:cash_account_booked_rows': { data: options.booked ?? 0 },
    open_bank_rows: { count: options.unbooked ?? 0 },
    'rpc:save_bank_account_selection': options.saveError
      ? { error: options.saveError }
      : { data: { status: 'active', accounts: options.accounts } },
  })
  // Answered per row: the service asks one row at a time.
  mock.setTable('rpc:cash_account_retirement_dependencies', () => {
    if (options.dependenciesError) return { error: options.dependenciesError }
    const args = mock.findCalls('rpc:cash_account_retirement_dependencies', 'rpc').at(-1)?.[0] as { p_cash_account_id: string }
    return { data: options.dependencies?.[args.p_cash_account_id] ?? [] }
  })
  const ctx = { supabase: mock.supabase as unknown as SupabaseClient, companyId: COMPANY, userId: 'user-1', log }
  const saved = () => mock.findCall('rpc:save_bank_account_selection', 'rpc')?.[0] as { p_selections: unknown[] } | undefined
  return { ...mock, ctx, saved }
}

beforeEach(() => {
  vi.clearAllMocks()
  requireCompanyAdmin.mockResolvedValue(null)
  prepareTwins.mockResolvedValue({ setAside: [], overBookedBuckets: 0 })
  applyTwins.mockResolvedValue(0)
})

describe('changeBankAccountLedgers', () => {
  // crm#1395 / PH 211: the plusgiro account was mapped onto 1931 at the first
  // connect, and an Open Payments connection offered no way to change it.
  it('previews a move with the rows that follow and the verifikat that stay, writing nothing', async () => {
    const { ctx, saved } = setup({
      accounts: [account('1111'), account('2222')],
      cash: [cashRow('cash-a', '1111', '1930'), cashRow('cash-b', '2222', '1931')],
      booked: 3,
      unbooked: 41,
    })

    const outcome = await changeBankAccountLedgers(ctx, { connectionId: CONNECTION, accounts: [{ uid: '2222', ledger_account: '1920' }] }, { dryRun: true })

    expect(outcome).toEqual({
      ok: true,
      dryRun: true,
      preview: {
        connection_id: CONNECTION,
        moves: [{
          uid: '2222',
          name: 'Konto 2222',
          iban_last4: '2222',
          currency: 'SEK',
          cash_account_id: 'cash-b',
          from_ledger: '1931',
          to_ledger: '1920',
          booked_rows: 3,
          unbooked_rows: 41,
          swapped: false,
        }],
      },
    })
    expect(saved()).toBeUndefined()
    expect(emit).not.toHaveBeenCalled()
  })

  it('saves the whole selection: the asked account moves in place, every other account stays as it is', async () => {
    const { ctx, saved } = setup({
      accounts: [account('1111'), account('2222'), account('3333', { enabled: false, ledger_account: '1935' })],
      cash: [cashRow('cash-a', '1111', '1930'), cashRow('cash-b', '2222', '1931')],
    })

    const outcome = await changeBankAccountLedgers(ctx, { connectionId: CONNECTION, accounts: [{ uid: '2222', ledger_account: '1920' }] })

    expect(outcome.ok && !outcome.dryRun && outcome.data.moves.map((m) => [m.uid, m.from_ledger, m.to_ledger])).toEqual([['2222', '1931', '1920']])
    expect(saved()).toMatchObject({
      p_company_id: COMPANY,
      p_connection_id: CONNECTION,
      p_expected_token: 'token-1',
      p_selections: [
        // Unchanged, and kept on its own row.
        { uid: '1111', enabled: true, currency: 'SEK', ledger_account: '1930', reuse_cash_account_id: 'cash-a' },
        // Moves: no row to reuse, so the save re-ledgers its own row in place.
        { uid: '2222', enabled: true, currency: 'SEK', ledger_account: '1920', reuse_cash_account_id: null },
        // Not synced: stays off and keeps its soft claim.
        { uid: '3333', enabled: false, currency: 'SEK', ledger_account: '1935', reuse_cash_account_id: null },
      ],
    })
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'bank_connection.account_selection_changed',
      payload: expect.objectContaining({
        connectionId: CONNECTION, previousStatus: 'active', newStatus: 'active', enabledCount: 2, totalCount: 3,
        // The behandlingshistorik of the change: which account, from where, to where.
        ledgerChanges: [{ cashAccountId: 'cash-b', uid: '2222', from: '1931', to: '1920' }],
      }),
    }))
  })

  // crm#1701: statement files on a manual 1930 account, the bank's feed
  // connected onto 1935 and then moved to 1930, where the save merges them.
  describe('rows of one bank account that no import compared', () => {
    const plan = { setAside: [{ transaction_id: 'feed-1', twin_transaction_id: 'file-1' }], overBookedBuckets: 0 }

    it('plans the copies before the save against the statement account on the target, and sets them aside after', async () => {
      prepareTwins.mockResolvedValue(plan)
      applyTwins.mockResolvedValue(1)
      const { ctx, saved } = setup({
        accounts: [account('1111')],
        cash: [cashRow('cash-a', '1111', '1935'), cashRow('cash-file', null, '1930')],
      })
      prepareTwins.mockImplementation(async () => {
        // Planned while the accounts are still apart: nothing saved yet.
        expect(saved()).toBeUndefined()
        return plan
      })

      const outcome = await changeBankAccountLedgers(ctx, { connectionId: CONNECTION, accounts: [{ uid: '1111', ledger_account: '1930' }] })

      expect(outcome.ok).toBe(true)
      expect(prepareTwins).toHaveBeenCalledWith(ctx.supabase, COMPANY, 'cash-a', ['cash-file'])
      expect(applyTwins).toHaveBeenCalledWith(ctx.supabase, COMPANY, plan, { actorUserId: 'user-1', correlationId: CONNECTION })
      expect(saved()).toBeDefined()
    })

    it('never compares with an account that has a bank identity or is this connection’s own', async () => {
      const { ctx } = setup({
        accounts: [account('1111'), account('2222')],
        cash: [
          cashRow('cash-a', '1111', '1935'),
          // Another synced account of this connection on 1930, even without an
          // IBAN: it trades places, it is never merged.
          cashRow('cash-b', '2222', '1930', { iban: null }),
          // Another bank account with its own IBAN: never the same account.
          cashRow('cash-other', null, '1930', { iban: 'SE4550000000058398257466' }),
        ],
      })
      await changeBankAccountLedgers(ctx, { connectionId: CONNECTION, accounts: [{ uid: '1111', ledger_account: '1930' }] })
      expect(prepareTwins).not.toHaveBeenCalled()
      expect(applyTwins).not.toHaveBeenCalled()
    })

    it('plans nothing on a dry run or when nothing moves', async () => {
      const { ctx } = setup({ accounts: [account('1111')], cash: [cashRow('cash-a', '1111', '1935'), cashRow('cash-file', null, '1930')] })
      await changeBankAccountLedgers(ctx, { connectionId: CONNECTION, accounts: [{ uid: '1111', ledger_account: '1930' }] }, { dryRun: true })
      await changeBankAccountLedgers(ctx, { connectionId: CONNECTION, accounts: [{ uid: '1111', ledger_account: '1935' }] })
      expect(prepareTwins).not.toHaveBeenCalled()
    })

    it('sets nothing aside when the save is refused', async () => {
      prepareTwins.mockResolvedValue(plan)
      const { ctx } = setup({
        accounts: [account('1111')],
        cash: [cashRow('cash-a', '1111', '1935'), cashRow('cash-file', null, '1930')],
        saveError: { code: '23505', message: 'BANK_SELECTION_LEDGER_CONFLICT' },
      })
      const outcome = await changeBankAccountLedgers(ctx, { connectionId: CONNECTION, accounts: [{ uid: '1111', ledger_account: '1930' }] })
      expect(outcome.ok).toBe(false)
      expect(applyTwins).not.toHaveBeenCalled()
    })

    it('never fails a move because the copies could not be planned or set aside', async () => {
      const cash = [cashRow('cash-a', '1111', '1935'), cashRow('cash-file', null, '1930')]
      prepareTwins.mockRejectedValueOnce(new Error('statement timeout'))
      const first = setup({ accounts: [account('1111')], cash })
      expect((await changeBankAccountLedgers(first.ctx, { connectionId: CONNECTION, accounts: [{ uid: '1111', ledger_account: '1930' }] })).ok).toBe(true)

      prepareTwins.mockResolvedValueOnce(plan)
      applyTwins.mockRejectedValueOnce(new Error('statement timeout'))
      const second = setup({ accounts: [account('1111')], cash })
      expect((await changeBankAccountLedgers(second.ctx, { connectionId: CONNECTION, accounts: [{ uid: '1111', ledger_account: '1930' }] })).ok).toBe(true)
      expect(log.error).toHaveBeenCalledWith('channel twins not set aside after a ledger move', expect.objectContaining({ connectionId: CONNECTION }))
    })
  })

  it('is provider-neutral: an Enable Banking connection changes the same way', async () => {
    const { ctx, saved } = setup({
      aggregator: 'enable_banking',
      accounts: [account('1111')],
      cash: [cashRow('cash-a', '1111', '1930')],
    })

    const outcome = await changeBankAccountLedgers(ctx, { connectionId: CONNECTION, accounts: [{ uid: '1111', ledger_account: '1940' }] })

    expect(outcome.ok).toBe(true)
    expect(saved()?.p_selections).toEqual([
      { uid: '1111', enabled: true, currency: 'SEK', ledger_account: '1940', reuse_cash_account_id: null },
    ])
  })

  it('trades places with a synced account of the same connection that sits on the wanted ledger account', async () => {
    const { ctx, saved } = setup({
      accounts: [account('1111'), account('2222')],
      cash: [cashRow('cash-a', '1111', '1930'), cashRow('cash-b', '2222', '1931')],
    })

    const outcome = await changeBankAccountLedgers(ctx, { connectionId: CONNECTION, accounts: [{ uid: '2222', ledger_account: '1930' }] })

    expect(outcome.ok && !outcome.dryRun && outcome.data.moves.map((m) => [m.uid, m.from_ledger, m.to_ledger, m.swapped])).toEqual([
      ['1111', '1930', '1931', true],
      ['2222', '1931', '1930', false],
    ])
    expect(saved()?.p_selections).toEqual([
      { uid: '1111', enabled: true, currency: 'SEK', ledger_account: '1931', reuse_cash_account_id: null },
      { uid: '2222', enabled: true, currency: 'SEK', ledger_account: '1930', reuse_cash_account_id: null },
    ])
  })

  it('lets an account that is not synced yield the wanted ledger account', async () => {
    const { ctx, saved } = setup({
      accounts: [account('1111'), account('2222', { enabled: false, ledger_account: '1940' })],
      cash: [cashRow('cash-a', '1111', '1930')],
    })

    await changeBankAccountLedgers(ctx, { connectionId: CONNECTION, accounts: [{ uid: '1111', ledger_account: '1940' }] })

    expect(saved()?.p_selections).toEqual([
      { uid: '1111', enabled: true, currency: 'SEK', ledger_account: '1940', reuse_cash_account_id: null },
      { uid: '2222', enabled: false, currency: 'SEK', reuse_cash_account_id: null },
    ])
  })

  it('keeps the row of the same physical account already on the wanted ledger account', async () => {
    const { ctx, saved } = setup({
      accounts: [account('1111')],
      cash: [cashRow('cash-a', '1111', '1931'), cashRow('manual-1920', null, '1920', { iban: 'SE0000000000000000001111' })],
    })

    await changeBankAccountLedgers(ctx, { connectionId: CONNECTION, accounts: [{ uid: '1111', ledger_account: '1920' }] })

    expect(saved()?.p_selections).toEqual([
      { uid: '1111', enabled: true, currency: 'SEK', ledger_account: '1920', reuse_cash_account_id: 'manual-1920' },
    ])
  })

  it('saves nothing when the account already books on that ledger account', async () => {
    const { ctx, saved } = setup({ accounts: [account('1111')], cash: [cashRow('cash-a', '1111', '1930')] })

    const outcome = await changeBankAccountLedgers(ctx, { connectionId: CONNECTION, accounts: [{ uid: '1111', ledger_account: '1930' }] })

    expect(outcome).toEqual({ ok: true, data: { connection_id: CONNECTION, moves: [] } })
    expect(saved()).toBeUndefined()
  })

  it.each(['pending_selection', 'expired', 'error'])('refuses a %s connection: nothing to change until it is chosen or renewed', async (status) => {
    const { ctx, saved } = setup({ status, accounts: [account('1111')], cash: [cashRow('cash-a', '1111', '1930')] })

    const outcome = await changeBankAccountLedgers(ctx, { connectionId: CONNECTION, accounts: [{ uid: '1111', ledger_account: '1940' }] })

    expect(outcome).toMatchObject({ ok: false, code: 'BANK_LEDGER_CHANGE_NOT_ACTIVE' })
    expect(saved()).toBeUndefined()
  })

  it('refuses an account that is not synced or not in the connection', async () => {
    const { ctx, saved } = setup({
      accounts: [account('1111'), account('2222', { enabled: false })],
      cash: [cashRow('cash-a', '1111', '1930')],
    })

    expect(await changeBankAccountLedgers(ctx, { connectionId: CONNECTION, accounts: [{ uid: '2222', ledger_account: '1940' }] }))
      .toMatchObject({ ok: false, code: 'VALIDATION_ERROR', details: { reason: 'not_synced', uid: '2222' } })
    expect(await changeBankAccountLedgers(ctx, { connectionId: CONNECTION, accounts: [{ uid: '9999', ledger_account: '1940' }] }))
      .toMatchObject({ ok: false, code: 'VALIDATION_ERROR', details: { reason: 'unknown_account' } })
    expect(saved()).toBeUndefined()
  })

  it('refuses two accounts on one ledger account and a ledger account outside 19xx before reading anything', async () => {
    const { ctx, findCall } = setup({ accounts: [account('1111'), account('2222')], cash: [] })

    expect(await changeBankAccountLedgers(ctx, {
      connectionId: CONNECTION,
      accounts: [{ uid: '1111', ledger_account: '1940' }, { uid: '2222', ledger_account: '1940' }],
    })).toMatchObject({ ok: false, code: 'BANK_SELECTION_LEDGER_CONFLICT' })
    expect(await changeBankAccountLedgers(ctx, { connectionId: CONNECTION, accounts: [{ uid: '1111', ledger_account: '3001' }] }))
      .toMatchObject({ ok: false, code: 'VALIDATION_ERROR', details: { field: 'ledger_account' } })
    expect(findCall('rpc:read_bank_configuration', 'rpc')).toBeUndefined()
  })

  it('answers 404 for a connection the company does not have', async () => {
    const { ctx } = setup({ accounts: [], cash: [], readError: { code: 'P0002', message: 'BANK_CONNECTION_NOT_FOUND' } })

    expect(await changeBankAccountLedgers(ctx, { connectionId: CONNECTION, accounts: [{ uid: '1111', ledger_account: '1940' }] }))
      .toMatchObject({ ok: false, code: 'NOT_FOUND' })
  })

  it('passes the database refusal on, with the sentence naming the bank account that holds the ledger account', async () => {
    const detail = JSON.stringify({
      ledger_account: '1940',
      cash_account: { id: 'other', ledger_account: '1940', name: 'Sparkonto', iban_last4: '9876', currency: 'SEK', bank_name: 'Annanbanken', connection_live: true },
    })
    const { ctx } = setup({
      accounts: [account('1111')],
      cash: [cashRow('cash-a', '1111', '1930')],
      saveError: { code: '23505', message: 'CASH_ACCOUNT_LEDGER_CLAIMED', details: detail },
    })

    const outcome = await changeBankAccountLedgers(ctx, { connectionId: CONNECTION, accounts: [{ uid: '1111', ledger_account: '1940' }] })

    expect(outcome).toMatchObject({ ok: false, code: 'CASH_ACCOUNT_LEDGER_CLAIMED' })
    expect(!outcome.ok && (outcome.error as Error).message).toContain('Sparkonto')
    expect(emit).not.toHaveBeenCalled()
  })

  // crm#1683: the account's own row is the invoice payee, and the move lands
  // on the statement account already on 1930, so the save carries the payee
  // details there (crm#1445). That part is owner/admin only: a member got
  // the database's generic "kontakta supporten" refusal at the save.
  describe('a move that carries the invoice payee details', () => {
    const PAYEE = ['invoice-configuration', 'invoice-default']
    const accounts = [account('1111')]
    const cash = [cashRow('cash-a', '1111', '1935'), cashRow('cash-file', null, '1930')]
    const ask = { connectionId: CONNECTION, accounts: [{ uid: '1111', ledger_account: '1930' }] }

    function asMember() {
      requireCompanyAdmin.mockImplementation(async (_ctx: unknown, messageSv: string) => ({
        ok: false, code: 'FORBIDDEN', messageSv, details: { required_roles: ['owner', 'admin'] },
      }))
    }

    it('tells a member on the preview that an owner or admin makes it, naming the account and ledger accounts', async () => {
      asMember()
      const { ctx, saved } = setup({ accounts, cash, dependencies: { 'cash-a': PAYEE } })

      const outcome = await changeBankAccountLedgers(ctx, ask, { dryRun: true })

      expect(outcome).toMatchObject({
        ok: false,
        code: 'BANK_LEDGER_CHANGE_PAYEE_ADMIN_ONLY',
        details: { required_roles: ['owner', 'admin'] },
      })
      expect(!outcome.ok && outcome.messageSv).toBe(
        'Bytet av bankkontot Konto 1111 (Testbanken ••1111) från 1935 till 1930 flyttar också betalningsuppgifterna för fakturor, '
          + 'och dem kan bara företagets ägare eller en administratör ändra. Inget sparades. Be en ägare eller administratör att göra bytet.',
      )
      expect(saved()).toBeUndefined()
    })

    it('refuses a member before anything is written', async () => {
      asMember()
      const { ctx, saved } = setup({ accounts, cash, dependencies: { 'cash-a': ['invoice-configuration', 'reconciliation'] } })

      const outcome = await changeBankAccountLedgers(ctx, ask)

      expect(outcome).toMatchObject({ ok: false, code: 'BANK_LEDGER_CHANGE_PAYEE_ADMIN_ONLY' })
      expect(saved()).toBeUndefined()
      expect(prepareTwins).not.toHaveBeenCalled()
      expect(emit).not.toHaveBeenCalled()
    })

    it('lets an owner or admin make it', async () => {
      const { ctx, saved } = setup({ accounts, cash, dependencies: { 'cash-a': PAYEE } })

      const outcome = await changeBankAccountLedgers(ctx, ask)

      expect(outcome.ok).toBe(true)
      expect(requireCompanyAdmin).toHaveBeenCalledTimes(1)
      expect(saved()).toBeDefined()
    })

    it('carries the payee to the row of the same physical account on the ledger too', async () => {
      asMember()
      const { ctx } = setup({
        accounts,
        cash: [cashRow('cash-a', '1111', '1935'), cashRow('old-1930', '1111', '1930', { bank_connection_id: 'conn-revoked' })],
        dependencies: { 'cash-a': ['invoice-default'] },
      })

      expect(await changeBankAccountLedgers(ctx, ask, { dryRun: true }))
        .toMatchObject({ ok: false, code: 'BANK_LEDGER_CHANGE_PAYEE_ADMIN_ONLY' })
    })

    it('reports a failed read of the payee ties instead of guessing, saving nothing', async () => {
      const { ctx, saved } = setup({ accounts, cash, dependenciesError: { code: '57014', message: 'canceling statement due to statement timeout' } })

      const outcome = await changeBankAccountLedgers(ctx, ask)

      expect(outcome).toMatchObject({ ok: false, code: 'INTERNAL_ERROR' })
      expect(saved()).toBeUndefined()
    })

    // Not the role's question: the payee stays on its row, or the database
    // refuses the move for everyone with its own sentence.
    it.each([
      ['the account has no payee details', { accounts, cash, dependencies: { 'cash-a': ['reconciliation'] } }, ask],
      ['the row on the ledger has payee details of its own', {
        accounts, cash, dependencies: { 'cash-a': PAYEE, 'cash-file': ['invoice-configuration'] },
      }, ask],
      ['issued invoices name the account', { accounts, cash, dependencies: { 'cash-a': [...PAYEE, 'invoice-reference'] } }, ask],
      ['the new ledger account can never be printed as payee', {
        accounts, cash: [cashRow('cash-a', '1111', '1935'), cashRow('kassa', null, '1910')], dependencies: { 'cash-a': PAYEE },
      }, { connectionId: CONNECTION, accounts: [{ uid: '1111', ledger_account: '1910' }] }],
      ['the account trades places with another account of the connection', {
        accounts: [account('1111'), account('2222')],
        cash: [cashRow('cash-a', '1111', '1935'), cashRow('cash-b', '2222', '1930')],
        dependencies: { 'cash-a': PAYEE },
      }, ask],
      ['the row on the ledger is another bank account', {
        accounts, cash: [cashRow('cash-a', '1111', '1935'), cashRow('cash-other', null, '1930', { iban: 'SE4550000000058398257466' })],
        dependencies: { 'cash-a': PAYEE },
      }, ask],
      ['nothing is on the ledger account yet', {
        accounts, cash: [cashRow('cash-a', '1111', '1935')], dependencies: { 'cash-a': PAYEE },
      }, ask],
    ])('asks no role when %s', async (_case, options, request) => {
      asMember()
      const { ctx } = setup(options)

      const outcome = await changeBankAccountLedgers(ctx, request, { dryRun: true })

      expect(outcome.ok).toBe(true)
      expect(requireCompanyAdmin).not.toHaveBeenCalled()
    })

    it('is a registered 403', () => {
      expect(getErrorEntry('BANK_LEDGER_CHANGE_PAYEE_ADMIN_ONLY')).toMatchObject({ httpStatus: 403 })
    })
  })
})

describe('changeCashAccountLedgers', () => {
  // crm#1663: an agent names the accounts by cash_account_id (what
  // gnubok_list_cash_accounts answers), not by the connection's account uid.
  it('resolves the cash accounts to their connection and moves them like the dashboard does', async () => {
    const { ctx, saved, findCall } = setup({
      accounts: [account('1111'), account('2222')],
      cash: [cashRow('cash-a', '1111', '1947'), cashRow('cash-b', '2222', '1933')],
      aggregator: 'enable_banking',
      booked: 4,
      unbooked: 20,
    })
    const outcome = await changeCashAccountLedgers(ctx, { accounts: [{ cash_account_id: 'cash-a', ledger_account: '1945' }] }, { dryRun: true })
    expect(outcome).toMatchObject({
      ok: true,
      dryRun: true,
      preview: { connection_id: CONNECTION, moves: [{ cash_account_id: 'cash-a', from_ledger: '1947', to_ledger: '1945', booked_rows: 4, unbooked_rows: 20 }] },
    })
    expect(saved()).toBeUndefined()
    expect(findCall('rpc:read_bank_configuration', 'rpc')?.[0]).toMatchObject({ p_connection_id: CONNECTION })
    // The admin gate runs on a dry run too, so a stage is refused up front.
    expect(requireCompanyAdmin).toHaveBeenCalledTimes(1)
  })

  it('commits through the same save as the dashboard', async () => {
    const { ctx, saved } = setup({
      accounts: [account('1111'), account('2222')],
      cash: [cashRow('cash-a', '1111', '1947'), cashRow('cash-b', '2222', '1933')],
    })
    const outcome = await changeCashAccountLedgers(ctx, { accounts: [{ cash_account_id: 'cash-a', ledger_account: '1945' }] })
    expect(outcome.ok && !outcome.dryRun && outcome.data.moves.map((m) => m.to_ledger)).toEqual(['1945'])
    expect(saved()?.p_selections).toContainEqual(expect.objectContaining({ uid: '1111', ledger_account: '1945' }))
  })

  it('is owner/admin only', async () => {
    requireCompanyAdmin.mockResolvedValue({ ok: false, code: 'FORBIDDEN', details: { required_roles: ['owner', 'admin'] } })
    const { ctx, saved } = setup({ accounts: [account('1111')], cash: [cashRow('cash-a', '1111', '1947')] })
    await expect(
      changeCashAccountLedgers(ctx, { accounts: [{ cash_account_id: 'cash-a', ledger_account: '1945' }] }, { dryRun: true }),
    ).resolves.toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(saved()).toBeUndefined()
  })

  it('refuses an unknown account, one no bank connection syncs, and accounts of two connections', async () => {
    const { ctx } = setup({
      accounts: [account('1111')],
      cash: [
        cashRow('cash-a', '1111', '1947'),
        cashRow('cash-manual', null, '1940'),
        cashRow('cash-other', '9999', '1932', { bank_connection_id: 'conn-2' }),
      ],
    })
    await expect(
      changeCashAccountLedgers(ctx, { accounts: [{ cash_account_id: 'nope', ledger_account: '1945' }] }),
    ).resolves.toMatchObject({ ok: false, code: 'CASH_ACCOUNT_NOT_FOUND' })
    await expect(
      changeCashAccountLedgers(ctx, { accounts: [{ cash_account_id: 'cash-manual', ledger_account: '1945' }] }),
    ).resolves.toMatchObject({ ok: false, code: 'VALIDATION_ERROR', details: { reason: 'not_bank_connected' } })
    await expect(
      changeCashAccountLedgers(ctx, {
        accounts: [
          { cash_account_id: 'cash-a', ledger_account: '1945' },
          { cash_account_id: 'cash-other', ledger_account: '1941' },
        ],
      }),
    ).resolves.toMatchObject({ ok: false, code: 'VALIDATION_ERROR', details: { reason: 'several_connections' } })
    await expect(
      changeCashAccountLedgers(ctx, {
        accounts: [
          { cash_account_id: 'cash-a', ledger_account: '1945' },
          { cash_account_id: 'cash-a', ledger_account: '1941' },
        ],
      }),
    ).resolves.toMatchObject({ ok: false, code: 'VALIDATION_ERROR', details: { reason: 'duplicate_account' } })
  })
})

