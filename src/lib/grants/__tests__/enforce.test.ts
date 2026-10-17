/**
 * applyCompanyGrant: the claim decides, the commit books, the outcome is
 * reported back. The SQL side of every refusal is tests/pg/company-grants.pg.test.ts;
 * here the TypeScript around it: what reaches the commit, and that every
 * failure leaves the operation for a person and frees the claim.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import type { CommitResult } from '@/lib/pending-operations/commit'

const commitMock = vi.hoisted(() => vi.fn())
const historyMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/pending-operations/commit', () => ({
  commitPendingOperation: (...args: unknown[]) => commitMock(...args),
}))
vi.mock('@/lib/processing-history/append', () => ({
  appendProcessingHistory: (...args: unknown[]) => historyMock(...args),
}))

import { applyCompanyGrant } from '../enforce'

const COMPANY = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'
const OP = '33333333-3333-4333-8333-333333333333'
const KEY = '44444444-4444-4444-8444-444444444444'
const GRANT = '55555555-5555-4555-8555-555555555555'

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as never
const credential = { actorType: 'api_key' as const, apiKeyId: KEY, label: 'Claude', unattendedCommitLimit: 1000 }

const MATCH = {
  matched: true,
  company_id: COMPANY,
  grant_id: GRANT,
  grant_version: 2,
  use_id: 'use-1',
  amount_sek: 149,
  counterparty_label: 'Spotify AB',
  accepted_at: '2026-10-16T10:00:00Z',
}
const ROW = { id: OP, company_id: COMPANY, operation_type: 'categorize_transaction', risk_level: 'medium', status: 'pending' }

function db(claim: { data?: unknown; error?: unknown }, extra: Record<string, unknown> = {}) {
  return createTableMockSupabase({
    'rpc:claim_company_grant': claim,
    pending_operations: { data: ROW },
    'rpc:complete_company_grant_use': { data: { ok: true, pattern_verified: true } },
    'rpc:release_company_grant_use': { data: { ok: true, released: true } },
    ...extra,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  historyMock.mockResolvedValue(undefined)
  vi.stubEnv('GRANT_SUGGESTIONS', 'true')
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('applyCompanyGrant', () => {
  it('with GRANT_SUGGESTIONS off, never asks the gate: existing grants do not apply', async () => {
    vi.stubEnv('GRANT_SUGGESTIONS', 'false')
    const mock = db({ data: MATCH })
    expect(await applyCompanyGrant(mock.supabase as never, { companyId: COMPANY, userId: USER, operationId: OP, credential, log })).toEqual({
      applied: false,
      reason: 'switched_off',
    })
    expect(mock.findCall('rpc:claim_company_grant', 'rpc')).toBeUndefined()
    expect(commitMock).not.toHaveBeenCalled()
  })

  it('does nothing without a key credential', async () => {
    const mock = db({ data: MATCH })
    const outcome = await applyCompanyGrant(mock.supabase as never, {
      companyId: COMPANY, userId: USER, operationId: OP, credential: { ...credential, apiKeyId: '' }, log,
    })
    expect(outcome).toEqual({ applied: false, reason: 'not_a_key_credential' })
    expect(mock.findCall('rpc:claim_company_grant', 'rpc')).toBeUndefined()
  })

  it('treats a database without the grant functions as no grant (deploy order)', async () => {
    for (const code of ['42883', 'PGRST202']) {
      const mock = db({ error: { code, message: 'function claim_company_grant does not exist' } })
      const outcome = await applyCompanyGrant(mock.supabase as never, { companyId: COMPANY, userId: USER, operationId: OP, credential, log })
      expect(outcome).toEqual({ applied: false, reason: 'not_in_database' })
    }
    expect(commitMock).not.toHaveBeenCalled()
  })

  it('answers claim_failed for any other claim error, and commits nothing', async () => {
    const mock = db({ error: { code: '57014', message: 'statement timeout' } })
    expect(await applyCompanyGrant(mock.supabase as never, { companyId: COMPANY, userId: USER, operationId: OP, credential, log })).toEqual({
      applied: false,
      reason: 'claim_failed',
    })
    expect(commitMock).not.toHaveBeenCalled()
  })

  it('passes a refusal through with its detail, and commits nothing', async () => {
    const mock = db({ data: { matched: false, reason: 'above_limit', grant_id: GRANT, amount_sek: 999, limit_sek: 200 } })
    expect(await applyCompanyGrant(mock.supabase as never, { companyId: COMPANY, userId: USER, operationId: OP, credential, log })).toEqual({
      applied: false,
      reason: 'above_limit',
      detail: { grant_id: GRANT, amount_sek: 999, limit_sek: 200 },
    })
    expect(commitMock).not.toHaveBeenCalled()
  })

  it('commits a match as the key that staged it, under the grant, and completes the use', async () => {
    const mock = db({ data: MATCH })
    commitMock.mockResolvedValue({ status: 'committed', data: { journal_entry_id: 'je-1', grant: {} }, operation_status: 'committed' } satisfies CommitResult)

    const outcome = await applyCompanyGrant(mock.supabase as never, { companyId: COMPANY, userId: USER, operationId: OP, credential, log })

    expect(outcome).toMatchObject({
      applied: true,
      committed: true,
      journalEntryId: 'je-1',
      patternVerified: true,
      grant: { grant_id: GRANT, grant_version: 2, use_id: 'use-1', amount_sek: 149 },
    })
    expect(commitMock).toHaveBeenCalledWith(mock.supabase, USER, COMPANY, ROW, {
      commitMethod: 'api_key',
      actor: { type: 'api_key', label: 'Claude', unattendedCommitLimit: 1000 },
      grant: { grantId: GRANT, grantVersion: 2, useId: 'use-1' },
    })
    expect(mock.findCall('rpc:complete_company_grant_use', 'rpc')).toEqual([{ p_use_id: 'use-1', p_journal_entry_id: 'je-1' }])
    expect(mock.findCall('rpc:release_company_grant_use', 'rpc')).toBeUndefined()
    expect(historyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'PendingOperationApproved',
        payload: expect.objectContaining({ channel: 'grant', grant_id: GRANT, grant_version: 2, outcome: 'committed' }),
        actor: { type: 'api_key', id: KEY, label: 'Claude' },
      }),
    )
  })

  it('releases the claim when the commit refuses, and reports where the operation is', async () => {
    const mock = db({ data: MATCH })
    commitMock.mockResolvedValue({ status: 'failed', code: 'UNATTENDED_COMMIT_LIMIT_EXCEEDED', http_status: 403, operation_status: 'pending' } satisfies CommitResult)
    const outcome = await applyCompanyGrant(mock.supabase as never, { companyId: COMPANY, userId: USER, operationId: OP, credential, log })
    expect(outcome).toMatchObject({ applied: true, committed: false, result: { operation_status: 'pending' } })
    expect(mock.findCall('rpc:release_company_grant_use', 'rpc')).toEqual([{ p_use_id: 'use-1', p_reason: 'UNATTENDED_COMMIT_LIMIT_EXCEEDED' }])
    expect(mock.findCall('rpc:complete_company_grant_use', 'rpc')).toBeUndefined()
  })

  it('releases the claim and reports a refused commit when the commit throws', async () => {
    const mock = db({ data: MATCH })
    commitMock.mockRejectedValue(new Error('connection reset'))
    const outcome = await applyCompanyGrant(mock.supabase as never, { companyId: COMPANY, userId: USER, operationId: OP, credential, log })
    expect(outcome).toMatchObject({ applied: true, committed: false, result: { status: 'failed', error: 'connection reset' } })
    expect(mock.findCall('rpc:release_company_grant_use', 'rpc')).toEqual([{ p_use_id: 'use-1', p_reason: 'commit_threw' }])
  })

  it('refuses a claim answered for another company, releasing it', async () => {
    const mock = db({ data: { ...MATCH, company_id: '66666666-6666-4666-8666-666666666666' } })
    expect(await applyCompanyGrant(mock.supabase as never, { companyId: COMPANY, userId: USER, operationId: OP, credential, log })).toEqual({
      applied: false,
      reason: 'credential_mismatch',
    })
    expect(mock.findCall('rpc:release_company_grant_use', 'rpc')).toEqual([{ p_use_id: 'use-1', p_reason: 'company_mismatch' }])
    expect(commitMock).not.toHaveBeenCalled()
  })

  it('names a service account as the actor of the processing-history row', async () => {
    const mock = db({ data: MATCH })
    commitMock.mockResolvedValue({ status: 'committed', data: { journal_entry_id: 'je-1' }, operation_status: 'committed' } satisfies CommitResult)
    await applyCompanyGrant(mock.supabase as never, {
      companyId: COMPANY, userId: USER, operationId: OP, credential: { ...credential, actorType: 'service_account', label: 'Bokföringsagent' }, log,
    })
    expect(commitMock.mock.calls[0][4].actor).toEqual({ type: 'service_account', label: 'Bokföringsagent', unattendedCommitLimit: 1000 })
    expect(historyMock.mock.calls[0][0].actor).toEqual({ type: 'service_account', id: KEY, label: 'Bokföringsagent' })
  })
})
