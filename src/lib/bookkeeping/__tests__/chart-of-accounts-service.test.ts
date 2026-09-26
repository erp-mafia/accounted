/**
 * The chart-of-accounts rules every door shares (dashboard routes, v1
 * operations, MCP tools and the staged commit path):
 * lib/bookkeeping/chart-of-accounts-service.ts. The class/type rule moved
 * here from lib/pending-operations/schemas/account.ts with its tests.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { createLogger } from '@/lib/logger'
import {
  accountClassTypeConflict,
  activateAccounts,
  createAccount,
  deactivateAccounts,
  deleteAccount,
  updateAccount,
} from '../chart-of-accounts-service'

const log = createLogger('test')
const ctxFor = (supabase: unknown) => ({ supabase: supabase as never, companyId: 'company-1', userId: 'user-1', log })

/** Every call that would change a row. */
const WRITE_METHODS = new Set(['insert', 'update', 'upsert', 'delete'])
const writes = (calls: { table: string; method: string }[]) => calls.filter((c) => WRITE_METHODS.has(c.method))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('accountClassTypeConflict', () => {
  it('accepts the types each BAS class holds', () => {
    expect(accountClassTypeConflict('1930', 'asset')).toBeNull()
    expect(accountClassTypeConflict('2081', 'equity')).toBeNull()
    expect(accountClassTypeConflict('2440', 'liability')).toBeNull()
    expect(accountClassTypeConflict('3001', 'revenue')).toBeNull()
    expect(accountClassTypeConflict('6570', 'expense')).toBeNull()
    expect(accountClassTypeConflict('8310', 'revenue')).toBeNull()
    expect(accountClassTypeConflict('8410', 'expense')).toBeNull()
  })

  it('keeps untaxed_reserves to the 21xx group (obeskattade reserver)', () => {
    expect(accountClassTypeConflict('2110', 'untaxed_reserves')).toBeNull()
    expect(accountClassTypeConflict('2129', 'untaxed_reserves')).toBeNull()
    expect(accountClassTypeConflict('2150', 'untaxed_reserves')).toBeNull()
    expect(accountClassTypeConflict('2440', 'untaxed_reserves')).toMatch(/21xx/)
    expect(accountClassTypeConflict('2099', 'untaxed_reserves')).toMatch(/21xx/)
    expect(accountClassTypeConflict('5999', 'untaxed_reserves')).toMatch(/21xx/)
  })

  it('refuses a type the class cannot hold', () => {
    expect(accountClassTypeConflict('2999', 'expense')).toMatch(/class 2/)
    expect(accountClassTypeConflict('1930', 'liability')).toMatch(/class 1/)
    expect(accountClassTypeConflict('3001', 'expense')).toMatch(/class 3/)
  })

  it('leaves the free-use classes 0 and 9 unconstrained', () => {
    expect(accountClassTypeConflict('9100', 'expense')).toBeNull()
    expect(accountClassTypeConflict('0100', 'asset')).toBeNull()
  })
})

describe('createAccount', () => {
  const base = { account_name: 'Konto', normal_balance: 'credit' as const }

  it('creates a 21xx untaxed_reserves account', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { account_number: '2129' } })
    const outcome = await createAccount(ctxFor(supabase), { ...base, account_number: '2129', account_type: 'untaxed_reserves' })
    expect(outcome).toMatchObject({ ok: true, created: true })
  })

  it('refuses untaxed_reserves outside 21xx before touching the database', async () => {
    const { supabase, calls } = createQueuedMockSupabase()
    const outcome = await createAccount(ctxFor(supabase), { ...base, account_number: '2440', account_type: 'untaxed_reserves' })
    expect(outcome).toMatchObject({ ok: false, code: 'ACCOUNT_TYPE_CLASS_CONFLICT' })
    expect(calls).toHaveLength(0)
  })

  it('prefills a BAS number and lets explicit values win; a dry run only reads', async () => {
    const { supabase, enqueue, calls } = createQueuedMockSupabase()
    enqueue({ data: null }) // not in the chart yet
    const outcome = await createAccount(
      ctxFor(supabase),
      { account_number: '5410', account_name: 'Verktyg', sru_code: null },
      { dryRun: true },
    )
    expect(outcome).toMatchObject({
      ok: true,
      dryRun: true,
      preview: {
        account_name: 'Verktyg',
        account_type: 'expense',
        normal_balance: 'debit',
        plan_type: 'full_bas',
        sru_code: null, // explicit null: no prefill
        source: 'bas_2026',
      },
    })
    expect(writes(calls)).toEqual([])
  })

  it('writes vat_box and derives the booking rate from a treatment', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { account_number: '2617' } })
    await createAccount(ctxFor(supabase), {
      account_number: '2617',
      account_name: 'Utgående moms tjänster utanför EU',
      account_type: 'liability',
      normal_balance: 'credit',
      vat_box: '30',
    })
    expect(findCall('chart_of_accounts', 'insert')?.[0]).toMatchObject({ vat_box: '30', account_class: 2 })

    const second = createQueuedMockSupabase()
    second.enqueue({ data: { account_number: '4056' } })
    await createAccount(ctxFor(second.supabase), {
      account_number: '4056',
      account_name: 'Inköp varor EU',
      account_type: 'expense',
      normal_balance: 'debit',
      default_vat_treatment: 'reverse_charge_eu_goods',
    })
    expect(second.findCall('chart_of_accounts', 'insert')?.[0]).toMatchObject({ default_vat_rate: 0.25 })
  })

  it('refuses text over the column bounds', async () => {
    const { supabase } = createQueuedMockSupabase()
    const outcome = await createAccount(ctxFor(supabase), { account_number: '5410', sru_code: 'x'.repeat(17) })
    expect(outcome).toMatchObject({ ok: false, code: 'VALIDATION_ERROR', details: { field: 'sru_code' } })
  })
})

describe('updateAccount', () => {
  it('clears a text field on an empty string and writes only what was sent', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { account_number: '5410' } })
    const outcome = await updateAccount(ctxFor(supabase), '5410', { description: '' })
    expect(outcome.ok).toBe(true)
    expect(findCall('chart_of_accounts', 'update')?.[0]).toEqual({ description: null })
  })

  it('a dry run reads the current row and writes nothing', async () => {
    const { supabase, enqueue, calls } = createQueuedMockSupabase()
    enqueue({ data: { account_number: '5410', account_name: 'Förbrukningsinventarier', is_active: true } })
    const outcome = await updateAccount(ctxFor(supabase), '5410', { is_active: false }, { dryRun: true })
    expect(outcome).toMatchObject({ ok: true, dryRun: true, preview: { changes: { is_active: false } } })
    expect(writes(calls)).toEqual([])
  })
})

describe('deleteAccount', () => {
  it('refuses an account with journal lines in this company', async () => {
    const { supabase, enqueue, calls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'acc-1', account_number: '5410', account_name: 'X', is_system_account: false } })
    enqueue({ data: [{ account_number: '5410', usage_count: 2 }] })
    const outcome = await deleteAccount(ctxFor(supabase), '5410')
    expect(outcome).toMatchObject({ ok: false, code: 'ACCOUNT_IN_USE', details: { usage_count: 2 } })
    expect(writes(calls)).toEqual([])
  })

  it('refuses a system account before counting usage', async () => {
    const { supabase, enqueue, calls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'acc-1', account_number: '1930', account_name: 'Bank', is_system_account: true } })
    const outcome = await deleteAccount(ctxFor(supabase), '1930')
    expect(outcome).toMatchObject({ ok: false, code: 'ACCOUNT_SYSTEM_DELETE' })
    expect(calls.some((c) => c.table.startsWith('rpc:'))).toBe(false)
  })
})

describe('activateAccounts / deactivateAccounts', () => {
  it('a dry run activation buckets the numbers and writes nothing', async () => {
    const { supabase, enqueue, calls } = createQueuedMockSupabase()
    enqueue({ data: [{ account_number: '6570', is_active: false }, { account_number: '1930', is_active: true }] })
    const outcome = await activateAccounts(ctxFor(supabase), ['5410', '6570', '1930', '4999'], { dryRun: true })
    expect(outcome).toMatchObject({
      ok: true,
      dryRun: true,
      preview: { to_reactivate: ['6570'], skipped: 1, unknown: ['4999'] },
    })
    expect(writes(calls)).toEqual([])
  })

  it('deactivation skips system and used accounts unless include_used', async () => {
    const rows = [
      { account_number: '1930', is_active: true, is_system_account: true },
      { account_number: '6991', is_active: true, is_system_account: false },
      { account_number: '7699', is_active: true, is_system_account: false },
    ]
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: rows })
    enqueue({ data: [{ account_number: '7699', usage_count: 4 }] })
    enqueue({ data: [{ account_number: '6991' }] })
    const outcome = await deactivateAccounts(ctxFor(supabase), ['1930', '6991', '7699'], false)
    expect(outcome).toMatchObject({
      ok: true,
      data: { deactivated: 1, skipped_system: ['1930'], skipped_used: ['7699'] },
    })
    expect(findCall('chart_of_accounts', 'in')).toBeDefined()
  })
})
