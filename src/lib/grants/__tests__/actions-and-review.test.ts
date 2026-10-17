import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'

const insertStagedMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/pending-operations/stage', () => ({
  insertStagedOperation: (...args: unknown[]) => insertStagedMock(...args),
}))

import { markGrantPostingsReviewed, setGrantsPaused, stageGrantRevocation } from '../actions'
import { loadGrantReview } from '../review'
import { createGrantFromOperation, revokeGrantFromOperation } from '../commit'
import { CreateGrantParamsSchema, grantPolicyVersion, parseGrantPolicyVersion } from '../types'

const COMPANY = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'
const GRANT = '33333333-3333-4333-8333-333333333333'
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as never

beforeEach(() => {
  vi.clearAllMocks()
})

describe('grant policy version', () => {
  it('names the grant and its version, and reads back only what it wrote', () => {
    const policy = grantPolicyVersion({ grantId: GRANT, grantVersion: 3 })
    expect(policy).toBe(`grant.1;grant_id=${GRANT};grant_version=3`)
    expect(parseGrantPolicyVersion(policy)).toEqual({ grantId: GRANT, grantVersion: 3 })
    expect(parseGrantPolicyVersion('staged-approval.1;approver=person')).toBeNull()
    expect(parseGrantPolicyVersion(null)).toBeNull()
  })
})

describe('CreateGrantParamsSchema', () => {
  const valid = {
    operation_type: 'categorize_transaction',
    counterparty_key: 'spotify',
    counterparty_label: 'Spotify AB',
    pattern: { direction: 'out', category: 'expense_software', vat_treatment: 'standard_25', reverse_charge_kind: null, account_number: '5420', line_accounts: ['1930', '2641', '5420'] },
    amount_limit_sek: 200,
    credential: { kind: 'any' },
  }
  it('accepts a complete rule and refuses one no grant may carry', () => {
    expect(CreateGrantParamsSchema.safeParse(valid).success).toBe(true)
    expect(CreateGrantParamsSchema.safeParse({ ...valid, operation_type: 'create_voucher' }).success).toBe(false)
    expect(CreateGrantParamsSchema.safeParse({ ...valid, pattern: { ...valid.pattern, category: 'private' } }).success).toBe(false)
    expect(CreateGrantParamsSchema.safeParse({ ...valid, amount_limit_sek: 0 }).success).toBe(false)
    expect(CreateGrantParamsSchema.safeParse({ ...valid, credential: { kind: 'api_key' } }).success).toBe(false)
  })
})

describe('createGrantFromOperation and revokeGrantFromOperation', () => {
  it('maps a refusal to its registry entry', async () => {
    const mock = createTableMockSupabase({ 'rpc:create_company_grant': { data: { ok: false, code: 'GRANT_UNKNOWN_COUNTERPARTY' } } })
    const result = await createGrantFromOperation(mock.supabase as never, {
      companyId: COMPANY,
      userId: USER,
      pendingOperationId: 'op-1',
      actor: { type: 'user' },
      params: CreateGrantParamsSchema.parse({
        operation_type: 'categorize_transaction',
        counterparty_key: 'spotify',
        counterparty_label: 'Spotify AB',
        pattern: { direction: 'out', category: 'expense_software', vat_treatment: null, reverse_charge_kind: null, account_number: '5420', line_accounts: ['1930', '5420'] },
        amount_limit_sek: 200,
        credential: { kind: 'service_account', service_account_id: GRANT },
      }),
    })
    expect(result).toEqual({ ok: false, code: 'GRANT_UNKNOWN_COUNTERPARTY', message_sv: expect.any(String), status: 400 })
    expect(mock.findCall('rpc:create_company_grant', 'rpc')?.[0]).toMatchObject({ p_credential_scope: 'service_account', p_credential_id: GRANT })
  })

  it('throws on a database error rather than answering a refusal', async () => {
    const mock = createTableMockSupabase({ 'rpc:revoke_company_grant': { error: { message: 'boom' } } })
    await expect(
      revokeGrantFromOperation(mock.supabase as never, { companyId: COMPANY, userId: USER, pendingOperationId: 'op-1', actor: { type: 'user' }, params: { grant_id: GRANT } }),
    ).rejects.toThrow(/boom/)
  })
})

describe('stageGrantRevocation', () => {
  it('answers 404 for a grant the session cannot see, and 409 for one already revoked', async () => {
    const missing = createTableMockSupabase({ company_grants: { data: null } })
    expect(await stageGrantRevocation(missing.supabase as never, missing.supabase as never, { companyId: COMPANY, userId: USER, grantId: GRANT }, log)).toEqual({
      ok: false,
      code: 'GRANT_NOT_FOUND',
      status: 404,
    })
    const revoked = createTableMockSupabase({ company_grants: { data: { id: GRANT, version: 1, counterparty_label: 'Spotify AB', amount_limit_sek: 200, revoked_at: '2026-10-16T10:00:00Z' } } })
    expect(await stageGrantRevocation(revoked.supabase as never, revoked.supabase as never, { companyId: COMPANY, userId: USER, grantId: GRANT }, log)).toEqual({
      ok: false,
      code: 'GRANT_ALREADY_REVOKED',
      status: 409,
    })
    expect(insertStagedMock).not.toHaveBeenCalled()
  })

  it('stages revoke_grant as the person, through the service client', async () => {
    const session = createTableMockSupabase({ company_grants: { data: { id: GRANT, version: 2, counterparty_label: 'Spotify AB', amount_limit_sek: '200.00', revoked_at: null } } })
    const service = createTableMockSupabase()
    insertStagedMock.mockResolvedValue({ row: { id: 'op-9' } })
    const result = await stageGrantRevocation(session.supabase as never, service.supabase as never, { companyId: COMPANY, userId: USER, userLabel: 'anna@example.se', grantId: GRANT }, log)
    expect(result).toEqual({ ok: true, operationId: 'op-9' })
    expect(insertStagedMock).toHaveBeenCalledWith(
      service.supabase,
      {
        companyId: COMPANY,
        userId: USER,
        operationType: 'revoke_grant',
        title: 'Återkalla regel för automatisk bokföring: Spotify AB',
        params: { grant_id: GRANT, counterparty_label: 'Spotify AB' },
        previewData: { counterparty: 'Spotify AB', version: 2, amount_limit_sek: 200 },
        actor: { type: 'user', label: 'anna@example.se' },
      },
      log,
    )
  })
})

describe('markGrantPostingsReviewed and setGrantsPaused', () => {
  it('maps the functions answers', async () => {
    const ok = createTableMockSupabase({ 'rpc:mark_company_grant_uses_reviewed': { data: { ok: true, reviewed: 2 } } })
    expect(await markGrantPostingsReviewed(ok.supabase as never, COMPANY, ['a', 'b'])).toEqual({ ok: true, reviewed: 2 })
    const forbidden = createTableMockSupabase({ 'rpc:mark_company_grant_uses_reviewed': { data: { ok: false, code: 'GRANT_REVIEW_FORBIDDEN' } } })
    expect(await markGrantPostingsReviewed(forbidden.supabase as never, COMPANY, ['a'])).toEqual({ ok: false, code: 'GRANT_REVIEW_FORBIDDEN', status: 403 })
    const paused = createTableMockSupabase({ 'rpc:set_company_grants_paused': { data: { ok: true, unchanged: false, paused: true } } })
    expect(await setGrantsPaused(paused.supabase as never, COMPANY, true)).toEqual({ ok: true, paused: true, changed: true })
    const notAdmin = createTableMockSupabase({ 'rpc:set_company_grants_paused': { data: { ok: false, code: 'GRANT_ADMIN_REQUIRED' } } })
    expect(await setGrantsPaused(notAdmin.supabase as never, COMPANY, false)).toEqual({ ok: false, code: 'GRANT_ADMIN_REQUIRED', status: 403 })
  })
})

describe('loadGrantReview', () => {
  it('reads nothing more for a company that never had a grant', async () => {
    const mock = createTableMockSupabase({ company_grants: { data: [] } })
    expect(await loadGrantReview(mock.supabase as never, COMPANY)).toEqual({ postings: [], paused: false, has_active_grants: false })
    expect(mock.findCall('rpc:list_company_grant_postings', 'rpc')).toBeUndefined()
  })

  it('is empty, quietly, before the grant tables exist', async () => {
    const mock = createTableMockSupabase({ company_grants: { error: { code: 'PGRST205', message: 'no table' } } })
    expect(await loadGrantReview(mock.supabase as never, COMPANY)).toEqual({ postings: [], paused: false, has_active_grants: false })
  })

  it('lists the postings with numbers as numbers, and the switch state', async () => {
    const mock = createTableMockSupabase({
      company_grants: [{ data: [{ id: GRANT }] }, { data: null, count: 1 }],
      'rpc:list_company_grant_postings': {
        data: [
          {
            use_id: 'u1', grant_id: GRANT, grant_version: 1, counterparty_label: 'Spotify AB', account_number: '5420',
            amount_limit_sek: '200.00', grant_accepted_at: '2026-10-16T10:00:00Z', grant_revoked_at: null,
            pending_operation_id: 'op-1', transaction_id: 't1', journal_entry_id: 'je-1', voucher: 'A12', entry_status: 'posted',
            entry_date: '2026-06-03', amount_sek: '149.00', pattern_verified: true, committed_at: '2026-10-16T11:00:00Z', reviewed_at: null,
          },
        ],
      },
      company_grant_settings: { data: { paused: true } },
    })
    const review = await loadGrantReview(mock.supabase as never, COMPANY)
    expect(review).toEqual({
      paused: true,
      has_active_grants: true,
      postings: [expect.objectContaining({ use_id: 'u1', amount_sek: 149, amount_limit_sek: 200, voucher: 'A12', pattern_verified: true })],
    })
  })
})
