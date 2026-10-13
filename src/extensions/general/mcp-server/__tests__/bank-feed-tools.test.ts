/**
 * The Open Payments bank-feed tools generated from
 * src/lib/operations/bank-feed.ts: an agent lists the reachable banks, reads
 * one bank, reads the company's connections and the switch progress, and
 * stages a signatory link. No tool starts, polls or selects a BankID consent,
 * and none removes a connection: those stay a person's acts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(() => ({ rpc: vi.fn(async () => ({ data: null, error: null })) })),
}))
vi.mock('@/lib/email/brand-sender', () => ({
  getBaseUrlForCompany: vi.fn().mockResolvedValue('https://app.accounted.se'),
}))

import { setBankFeedConnectForTests, type BankFeedConnect } from '@/lib/bank-feed/connect'
import { TOOL_SCOPE_MAP } from '@/lib/auth/scope-catalog'
import { createTableMockSupabase } from '@/tests/helpers'
import { tools, isStagingTool, STAGE_BRIDGE_TARGETS } from '../server'

const COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const USER_ID = '22222222-2222-4222-8222-222222222222'
const CONNECTION_ID = '33333333-3333-4333-8333-333333333333'

const BANKS = [
  { bic: 'SWEDSESS', name: 'Swedbank', logoUrl: null, decoupled: true, redirect: true },
  { bic: 'ESSESESS', name: 'SEB', logoUrl: null, decoupled: true, redirect: false },
]

const fakeConnect = {
  banks: async () => BANKS,
  getBankDetails: async (_companyId: string, bic: string) => ({
    bic,
    name: 'Swedbank',
    decoupled: true,
    redirect: true,
    affiliates: [{ id: '08999', name: 'Sparbanken Nord' }],
    transactionHistoryMaxDays: 88,
    extendedTransactionHistoryMaxDays: 760,
  }),
} as unknown as BankFeedConnect

const WRITES = new Set(['insert', 'update', 'upsert', 'delete'])

/** The tables a tool call wrote to, in order. */
function writes(db: ReturnType<typeof createTableMockSupabase>): string[] {
  return db.calls.filter((c) => WRITES.has(c.method)).map((c) => c.table)
}

const tool = (name: string) => {
  const found = tools.find((t) => t.name === name)
  if (!found) throw new Error(`tool ${name} not registered`)
  return found
}

const READS = ['gnubok_list_bank_feed_banks', 'gnubok_get_bank_feed_bank', 'gnubok_bank_feed_overview', 'gnubok_bank_feed_switch_progress']
const LINK = 'gnubok_bank_feed_connect_link'

beforeEach(() => {
  vi.stubEnv('OPENPAYMENTS_READING_COMPANY_IDS', COMPANY_ID)
  setBankFeedConnectForTests(fakeConnect)
})
afterEach(() => {
  vi.unstubAllEnvs()
  setBankFeedConnectForTests(undefined)
})

describe('bank-feed tools', () => {
  it('registers the four reads and the link, search-only, under the transactions scopes; only the link stages', () => {
    for (const name of [...READS, LINK]) {
      expect(tool(name).catalogVisibility, name).toBe('search')
      expect(TOOL_SCOPE_MAP[name], name).toBeDefined()
    }
    for (const name of READS) {
      expect(TOOL_SCOPE_MAP[name]).toBe('transactions:read')
      expect(tool(name).annotations.readOnlyHint).toBe(true)
      expect(isStagingTool(tool(name))).toBe(false)
    }
    expect(TOOL_SCOPE_MAP[LINK]).toBe('transactions:write')
    expect(isStagingTool(tool(LINK))).toBe(true)
    expect(STAGE_BRIDGE_TARGETS.map((t) => t.name)).toContain(LINK)
  })

  it('offers no tool that starts, polls, restarts or selects a bank consent, or removes a connection', () => {
    const names = tools.map((t) => t.name)
    expect(names.filter((n) => /bank_feed/.test(n) && /start|poll|restart|select|disconnect|remove|sync/.test(n))).toEqual([])
  })

  it('lists the banks the connector reaches', async () => {
    const db = createTableMockSupabase()
    const result = (await tool('gnubok_list_bank_feed_banks').execute({}, COMPANY_ID, USER_ID, db.supabase as never)) as { banks: Array<Record<string, unknown>> }
    expect(result.banks).toEqual([
      { bic: 'SWEDSESS', name: 'Swedbank', logo_url: null, decoupled: true, redirect: true },
      { bic: 'ESSESESS', name: 'SEB', logo_url: null, decoupled: true, redirect: false },
    ])
  })

  it('answers OPEN_BANKING_NOT_AVAILABLE when the company is not switched on', async () => {
    vi.stubEnv('OPENPAYMENTS_READING_COMPANY_IDS', '')
    const db = createTableMockSupabase()
    await expect(tool('gnubok_list_bank_feed_banks').execute({}, COMPANY_ID, USER_ID, db.supabase as never)).rejects.toMatchObject({ code: 'OPEN_BANKING_NOT_AVAILABLE' })
  })

  it('reads one bank with its sparbanker under a qualified affiliate_id', async () => {
    const db = createTableMockSupabase()
    const result = (await tool('gnubok_get_bank_feed_bank').execute({ bic: 'SWEDSESS' }, COMPANY_ID, USER_ID, db.supabase as never)) as Record<string, unknown>
    expect(result).toMatchObject({ bic: 'SWEDSESS', name: 'Swedbank', transaction_history_max_days: 88, extended_transaction_history_max_days: 760 })
    expect(result.affiliates).toEqual([{ affiliate_id: '08999', name: 'Sparbanken Nord' }])
  })

  it('refuses a malformed bic as VALIDATION_ERROR', async () => {
    const db = createTableMockSupabase()
    await expect(tool('gnubok_get_bank_feed_bank').execute({ bic: 'swedbank' }, COMPANY_ID, USER_ID, db.supabase as never)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('the link stages for an owner after a preview that mints nothing, and names what the approval returns', async () => {
    const db = createTableMockSupabase({
      company_members: { data: { role: 'owner' } },
      bank_connections: { data: { id: CONNECTION_ID, status: 'active', bank_name: 'Swedbank', aggregator: 'enable_banking' } },
      pending_operations: { data: { id: 'pending-1', status: 'pending', operation_type: 'bank_feed_invite', created_at: '2026-10-13T09:00:00Z' } },
    })
    const result = (await tool(LINK).execute(
      { replace_connection_id: CONNECTION_ID, recipient_email: 'anna@example.se', offer_payments: true },
      COMPANY_ID,
      USER_ID,
      db.supabase as never,
      { type: 'api_key', id: 'key-1' },
    )) as Record<string, unknown>
    expect(result.staged).toBe(true)
    expect(writes(db)).toEqual(['pending_operations'])
    expect(db.payloads('bank_connect_invites', 'insert')).toEqual([])
    expect(result.preview).toMatchObject({
      bic: null,
      bank_name: 'Swedbank',
      replaces: { connection_id: CONNECTION_ID, bank_name: 'Swedbank', aggregator: 'enable_banking', kind: 'switch' },
      recipient_email: 'anna@example.se',
      email_will_be_sent: true,
      offer_payments: true,
      valid_days: 7,
      url: null,
    })
    expect(result.next).toMatchObject({ tool: 'gnubok_approve_pending_operation' })
    expect(String((result.next as { description: string }).description)).toContain('data.url')
  })

  it('the link is refused for a member below admin, before anything is staged', async () => {
    const db = createTableMockSupabase({ company_members: { data: { role: 'member' } } })
    await expect(tool(LINK).execute({ offer_payments: false }, COMPANY_ID, USER_ID, db.supabase as never)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(writes(db)).toEqual([])
  })

  it('the link is refused when the replaced connection is not the company\'s', async () => {
    const db = createTableMockSupabase({ company_members: { data: { role: 'admin' } }, bank_connections: { data: null } })
    await expect(tool(LINK).execute({ replace_connection_id: CONNECTION_ID }, COMPANY_ID, USER_ID, db.supabase as never)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(writes(db)).toEqual([])
  })
})
