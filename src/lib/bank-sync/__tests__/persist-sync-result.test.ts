import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { persistBankSyncResult, persistBankSyncFailure } from '../persist-sync-result'

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
