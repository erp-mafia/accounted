/**
 * POST /api/v1/companies/:companyId/pending-operations/:id/approve, refused:
 * the top-level message, message_en and recovery_hint are the refusal's own
 * when the commit result brings them (a document on a locked year keeps
 * PERIOD_LOCKED and speaks the document answer, #248), else the registry's
 * for the code. The commit itself is mocked: route.test.ts runs it for real.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') throw new Error('NODE_ENV=test required')
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

const approval = vi.hoisted(() => ({ approvePendingOperationAsApiKey: vi.fn() }))

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return { ...actual, validateApiKey: vi.fn(), createServiceClientNoCookies: vi.fn() }
})
vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})
vi.mock('@/lib/entitlements/multi-user', async () => {
  const actual = await vi.importActual<typeof import('@/lib/entitlements/multi-user')>('@/lib/entitlements/multi-user')
  return { ...actual, getMultiUserState: vi.fn().mockResolvedValue({ state: 'active' }), isMembershipDormant: () => false }
})
vi.mock('@/lib/pending-operations/api-approval', () => ({
  approvePendingOperationAsApiKey: (...args: unknown[]) => approval.approvePendingOperationAsApiKey(...args),
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createTableMockSupabase } from '@/tests/helpers'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import type { CommitResult } from '@/lib/pending-operations/commit'
import { POST } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OP_ID = '11111111-1111-4111-8111-111111111111'
const URL_ = `https://x.test/api/v1/companies/${COMPANY_ID}/pending-operations/${OP_ID}/approve`
const params = { params: Promise.resolve({ companyId: COMPANY_ID, id: OP_ID }) }

const OPERATION = {
  id: OP_ID,
  user_id: 'user-1',
  company_id: COMPANY_ID,
  operation_type: 'attach_document_to_transaction',
  status: 'rejected',
  title: 'Koppla bilaga',
  params: {},
  preview_data: {},
  result_data: null,
  actor_type: 'api_key',
  actor_id: 'key-stager',
  actor_label: 'Agent',
  risk_level: 'medium',
  agent_metadata: null,
  rejection_category: 'failed',
  rejection_reason: null,
  batch_id: null,
  created_at: '2026-11-18T09:00:00.000Z',
  resolved_at: '2026-11-18T09:01:00.000Z',
  updated_at: '2026-11-18T09:01:00.000Z',
}

async function approveRefused(result: CommitResult) {
  approval.approvePendingOperationAsApiKey.mockResolvedValueOnce({ kind: 'failed', operation: OPERATION, result })
  const res = await POST(
    new Request(URL_, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-fixture-not-a-real-key',
        'Idempotency-Key': crypto.randomUUID(),
        'Content-Type': 'application/json',
      },
    }),
    params,
  )
  return { status: res.status, error: (await res.json()).error }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'key-approver',
    apiKeyName: 'Attestflöde',
    scopes: ['pending_operations:read', 'pending_operations:approve'],
    mode: 'live',
    allowedCompanyIds: null,
    readOnlyCompanyIds: null,
    unattendedCommitLimit: null,
  })
  mockServiceClient.mockReturnValue(
    createTableMockSupabase({ company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null } }).supabase,
  )
})

describe('POST .../pending-operations/:id/approve: a refused commit', () => {
  it('answers the refusal\'s own message, message_en and recovery_hint for its code', async () => {
    const answer = getErrorEntry('DOC_UPLOAD_PERIOD_LOCKED')!
    const { status, error } = await approveRefused({
      status: 'failed',
      error: answer.message_sv,
      http_status: 400,
      code: 'PERIOD_LOCKED',
      data: { journal_entry_id: 'je-1', message_en: answer.message_en, remediation: answer.remediation },
      operation_status: 'rejected',
    })
    expect(status).toBe(400)
    expect(error.code).toBe('PERIOD_LOCKED')
    expect(error.message).toBe(answer.message_sv)
    expect(error.message_en).toBe(answer.message_en)
    expect(error.recovery_hint).toBe(answer.remediation!.description)
    expect(error.recovery_hint).not.toBe(getErrorEntry('PERIOD_LOCKED')!.remediation?.description)
    // details are unchanged: the reason and the data stay where they were.
    expect(error.details).toMatchObject({
      reason: answer.message_sv,
      data: { journal_entry_id: 'je-1', message_en: answer.message_en },
      pending_operation: { status: 'rejected' },
    })
  })

  it('answers the registry\'s message, message_en and recovery_hint for a refusal that brings none', async () => {
    const registry = getErrorEntry('PERIOD_LOCKED')!
    const { status, error } = await approveRefused({
      status: 'failed',
      error: 'Bokföringen är låst för denna period.',
      http_status: 400,
      code: 'PERIOD_LOCKED',
      operation_status: 'rejected',
    })
    expect(status).toBe(400)
    expect(error.message).toBe(registry.message_sv)
    expect(error.message_en).toBe(registry.message_en)
    expect(error.recovery_hint).toBe(registry.remediation!.description)
  })
})
