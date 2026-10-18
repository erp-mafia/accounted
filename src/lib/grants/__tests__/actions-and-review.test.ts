import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'

const insertStagedMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/pending-operations/stage', () => ({
  insertStagedOperation: (...args: unknown[]) => insertStagedMock(...args),
}))

import { markGrantPostingsReviewed, setGrantsPaused, stageGrantRevocation } from '../actions'
import { loadGrantReview } from '../review'
import { createGrantArgs, createGrantFromOperation, revokeGrantFromOperation } from '../commit'
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

describe('CreateGrantParamsSchema for a supplier invoice', () => {
  const SUPPLIER = '44444444-4444-4444-8444-444444444444'
  const valid = {
    operation_type: 'create_supplier_invoice_from_inbox',
    supplier_id: SUPPLIER,
    counterparty_label: 'Telia Sverige AB',
    pattern: { vat_treatment: 'standard_25', reverse_charge_kind: null, item_lines: ['6212:25'], line_accounts: ['2440', '2641', '6212'] },
    amount_limit_sek: 1500,
    credential: { kind: 'any' },
  }
  it('accepts a supplier rule by id and refuses one no grant may carry', () => {
    expect(CreateGrantParamsSchema.safeParse(valid).success).toBe(true)
    const refused: Array<[string, Record<string, unknown>]> = [
      ['no supplier id', { ...valid, supplier_id: 'Telia' }],
      ['a bank text key instead', { ...valid, counterparty_key: 'telia' }],
      ['a rate that is not Swedish', { ...valid, pattern: { ...valid.pattern, item_lines: ['6212:19'] } }],
      ['a line without its rate', { ...valid, pattern: { ...valid.pattern, item_lines: ['6212'] } }],
      ['a line account outside the verifikat', { ...valid, pattern: { ...valid.pattern, line_accounts: ['2440', '2641', '6211'] } }],
      ['reverse charge without its kind', { ...valid, pattern: { ...valid.pattern, vat_treatment: 'reverse_charge' } }],
      ['a kind without reverse charge', { ...valid, pattern: { ...valid.pattern, reverse_charge_kind: 'eu_services' } }],
      ['a category', { ...valid, pattern: { ...valid.pattern, category: 'expense_software' } }],
      ['a monthly limit below the limit', { ...valid, monthly_limit_sek: 100 }],
    ]
    for (const [why, params] of refused) expect(CreateGrantParamsSchema.safeParse(params).success, why).toBe(false)
  })

  it('sends the supplier and the lines to the new overload, and a bank-line rule exactly the slice 1 arguments', () => {
    const decision = { companyId: COMPANY, userId: USER, pendingOperationId: 'op-1', actor: { type: 'user', label: 'anna@example.se' } }
    expect(createGrantArgs({ ...decision, params: CreateGrantParamsSchema.parse(valid) })).toEqual({
      p_company_id: COMPANY,
      p_decided_by: USER,
      p_actor_type: 'user',
      p_actor_label: 'anna@example.se',
      p_pending_operation_id: 'op-1',
      p_operation_type: 'create_supplier_invoice_from_inbox',
      p_counterparty_key: `supplier:${SUPPLIER}`,
      p_counterparty_label: 'Telia Sverige AB',
      p_direction: 'out',
      p_category: null,
      p_vat_treatment: 'standard_25',
      p_reverse_charge_kind: null,
      p_account_number: null,
      p_line_accounts: ['2440', '2641', '6212'],
      p_amount_limit_sek: 1500,
      p_monthly_limit_sek: null,
      p_credential_scope: 'any',
      p_credential_id: null,
      p_evidence: {},
      p_supplier_id: SUPPLIER,
      p_item_lines: ['6212:25'],
    })
    const bankLine = createGrantArgs({
      ...decision,
      params: CreateGrantParamsSchema.parse({
        operation_type: 'categorize_transaction',
        counterparty_key: 'spotify',
        counterparty_label: 'Spotify AB',
        pattern: { direction: 'out', category: 'expense_software', vat_treatment: 'standard_25', reverse_charge_kind: null, account_number: '5420', line_accounts: ['1930', '2641', '5420'] },
        amount_limit_sek: 200,
        credential: { kind: 'any' },
      }),
    })
    expect(Object.keys(bankLine).sort()).toEqual(
      [
        'p_company_id', 'p_decided_by', 'p_actor_type', 'p_actor_label', 'p_pending_operation_id', 'p_operation_type', 'p_counterparty_key',
        'p_counterparty_label', 'p_direction', 'p_category', 'p_vat_treatment', 'p_reverse_charge_kind', 'p_account_number', 'p_line_accounts',
        'p_amount_limit_sek', 'p_monthly_limit_sek', 'p_credential_scope', 'p_credential_id', 'p_evidence',
      ].sort(),
    )
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
      postings: [
        expect.objectContaining({
          use_id: 'u1', amount_sek: 149, amount_limit_sek: 200, voucher: 'A12', pattern_verified: true,
          // A row from before migration 20261018100200 reads as a bank line's.
          operation_type: 'categorize_transaction', item_lines: [], supplier_invoice_id: null, inbox_item_id: null,
        }),
      ],
    })
  })

  it("lists a supplier invoice a rule booked with its invoice, inbox item and the rule's line bookings", async () => {
    const mock = createTableMockSupabase({
      company_grants: [{ data: [{ id: GRANT }] }, { data: null, count: 1 }],
      'rpc:list_company_grant_postings': {
        data: [
          {
            use_id: 'u2', grant_id: GRANT, grant_version: 1, counterparty_label: 'Telia Sverige AB', account_number: null,
            amount_limit_sek: '1500.00', grant_accepted_at: '2026-10-16T10:00:00Z', grant_revoked_at: null, pending_operation_id: 'op-2',
            transaction_id: null, journal_entry_id: 'je-2', voucher: 'A13', entry_status: 'posted', entry_date: '2026-06-03',
            amount_sek: '1249.00', pattern_verified: true, committed_at: '2026-10-16T11:00:00Z', reviewed_at: null,
            operation_type: 'create_supplier_invoice_from_inbox', item_lines: ['6212:25'], supplier_invoice_id: 'si-1', inbox_item_id: 'in-1',
          },
        ],
      },
      company_grant_settings: { data: null },
    })
    const review = await loadGrantReview(mock.supabase as never, COMPANY)
    expect(review.postings).toEqual([
      expect.objectContaining({
        operation_type: 'create_supplier_invoice_from_inbox', account_number: '', item_lines: ['6212:25'],
        supplier_invoice_id: 'si-1', inbox_item_id: 'in-1', transaction_id: null, amount_sek: 1249,
      }),
    ])
  })
})
