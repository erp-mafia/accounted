import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { persistBankSyncResult, persistBankSyncFailure, persistBankRouteNeedsConfiguration } from '../persist-sync-result'
import { BANK_ROUTE_NEEDS_CONFIGURATION_MESSAGE } from '../ingest-route'

const input = {
  companyId: 'company', connectionId: 'connection', sessionId: 'session',
  startedAt: '2026-09-21T10:00:00Z', completedAt: '2026-09-21T10:01:00Z',
  accounts: [{ uid: 'uid', balance: 25, balance_updated_at: '2026-09-21T10:01:00Z' }],
}
function client(result: unknown) {
  const rpc = vi.fn().mockResolvedValue(result)
  return { rpc, db: { rpc } as unknown as SupabaseClient }
}

describe('persistBankSyncResult', () => {
  it('sends only sync-owned account fields to the atomic persistence boundary', async () => {
    const { rpc, db } = client({ data: { applied: true }, error: null })
    await persistBankSyncResult(db, {
      ...input,
      accounts: [{ ...input.accounts[0], ledger_account: '1931', enabled: false, iban: 'private', name: 'private' }],
    })
    expect(rpc).toHaveBeenCalledWith('persist_bank_sync_result', {
      p_company_id: 'company', p_connection_id: 'connection', p_session_id: 'session',
      p_started_at: input.startedAt, p_completed_at: input.completedAt,
      p_accounts: input.accounts, p_initial_sync: null,
    })
  })

  it('preserves explicit null available balance and history/dedup evidence', async () => {
    const { rpc, db } = client({ data: { applied: true }, error: null })
    await persistBankSyncResult(db, {
      ...input, accounts: [{ uid: 'uid', available_balance: null, accepted_history_days: 90, dedup_scope: 'scope' }],
    })
    expect(rpc.mock.calls[0][1].p_accounts).toEqual([
      { uid: 'uid', available_balance: null, accepted_history_days: 90, dedup_scope: 'scope' },
    ])
  })

  it('passes initial backfill evidence without accepting arbitrary connection fields', async () => {
    const { rpc, db } = client({ data: { applied: true }, error: null })
    await persistBankSyncResult(db, { ...input, initialSync: {
      requestedFrom: '2026-06-23', returnedMin: '2026-08-01', returnedMax: '2026-09-21', lookbackDays: 90,
    } })
    expect(rpc.mock.calls[0][1].p_initial_sync).toEqual({
      requested_from: '2026-06-23', returned_min: '2026-08-01', returned_max: '2026-09-21', lookback_days: 90,
    })
  })

  it('does not report an obsolete connection snapshot as successfully persisted', async () => {
    const { db } = client({ data: { applied: false, reason: 'session_changed' }, error: null })
    await expect(persistBankSyncResult(db, input)).rejects.toThrow('session_changed')
  })

  it('surfaces database failures instead of advancing a successful caller', async () => {
    const { db } = client({ data: null, error: { message: 'statement timeout', code: '57014' } })
    await expect(persistBankSyncResult(db, input)).rejects.toMatchObject({ code: '57014' })
  })

  it('rejects an absent database acknowledgement', async () => {
    const { db } = client({ data: null, error: null })
    await expect(persistBankSyncResult(db, input)).rejects.toThrow('missing_acknowledgement')
  })
})

describe('persistBankSyncFailure', () => {
  const failure = { ...input, status: 'expired' as const, message: 'Session expired' }
  it('passes the observed session and attempt to the failure write', async () => {
    const { rpc, db } = client({ data: true, error: null })
    expect(await persistBankSyncFailure(db, failure)).toBe(true)
    expect(rpc).toHaveBeenCalledWith('persist_bank_sync_failure', {
      p_company_id: input.companyId, p_connection_id: input.connectionId,
      p_session_id: input.sessionId, p_started_at: input.startedAt,
      p_status: 'expired', p_message: 'Session expired',
    })
  })
  it('reports an obsolete failure without claiming it changed the connection', async () => {
    const { db } = client({ data: false, error: null })
    expect(await persistBankSyncFailure(db, failure)).toBe(false)
  })
  it('surfaces database errors and missing acknowledgement', async () => {
    const errorClient = client({ data: null, error: { code: '57014', message: 'timeout' } })
    await expect(persistBankSyncFailure(errorClient.db, failure)).rejects.toMatchObject({ code: '57014' })
    const missing = client({ data: null, error: null })
    await expect(persistBankSyncFailure(missing.db, failure)).rejects.toThrow('missing acknowledgement')
  })
})

describe('persistBankRouteNeedsConfiguration', () => {
  function chainClient(result: { error: unknown }) {
    const calls: Array<[string, ...unknown[]]> = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const method of ['update', 'eq', 'in', 'is']) {
      chain[method] = vi.fn((...args: unknown[]) => {
        calls.push([method, ...args])
        return chain
      })
    }
    chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve)
    const from = vi.fn(() => chain)
    return { calls, from, db: { from } as unknown as SupabaseClient }
  }

  it('writes only the advice, scoped to the live row of the company, never status or cursor', async () => {
    const { calls, from, db } = chainClient({ error: null })
    await persistBankRouteNeedsConfiguration(db, { companyId: 'company', connectionId: 'connection' })
    expect(from).toHaveBeenCalledWith('bank_connections')
    expect(calls).toEqual([
      ['update', { error_message: BANK_ROUTE_NEEDS_CONFIGURATION_MESSAGE }],
      ['eq', 'id', 'connection'],
      ['eq', 'company_id', 'company'],
      ['in', 'status', ['active', 'error']],
      ['is', 'superseded_by', null],
    ])
  })

  it('keeps the database error identity', async () => {
    const { db } = chainClient({ error: { code: '42501', message: 'denied' } })
    await expect(persistBankRouteNeedsConfiguration(db, { companyId: 'company', connectionId: 'connection' }))
      .rejects.toMatchObject({ code: '42501' })
  })
})
