/**
 * POST /v1/.../journal-entries/:id/commit hands a posted typed verifikat to
 * the bank matcher (lib/reconciliation/voucher-bank-link.ts, tested there),
 * so the open bank row it books is linked instead of staying open beside it
 * (crm#1958). Here only when the door asks, and with what.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return { ...actual, validateApiKey: vi.fn(), createServiceClientNoCookies: vi.fn() }
})
vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})
vi.mock('@/lib/bookkeeping/engine', () => ({
  commitEntry: vi.fn(),
  peekNextVoucherNumber: vi.fn().mockResolvedValue(143),
}))
// The booking-time warnings have their own tests; here they pass.
vi.mock('@/lib/bookkeeping/voucher-warnings-guard', () => ({
  runVoucherWarningsGuard: vi.fn().mockResolvedValue({ ok: true, acknowledged: [] }),
  recordVoucherWarningsAcknowledged: vi.fn(),
}))
const mockLink = vi.hoisted(() => vi.fn())
vi.mock('@/lib/reconciliation/voucher-bank-link', () => ({
  linkOpenBankRowsToVoucher: (...args: unknown[]) => mockLink(...args),
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { commitEntry } from '@/lib/bookkeeping/engine'
import { createTableMockSupabase } from '@/tests/helpers'
import { POST } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>
const mockCommitEntry = commitEntry as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ENTRY_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const LINES = [
  { account_number: '1930', debit_amount: 0, credit_amount: 61.25 },
  { account_number: '2890', debit_amount: 61.25, credit_amount: 0 },
]

/** company_members proves the key's reach, journal_entries is the draft, every other read is empty. */
function makeSupabase(sourceType: string) {
  return createTableMockSupabase({
    company_members: { data: { company_id: COMPANY_ID, user_id: 'user-1', role: 'owner' } },
    journal_entries: {
      data: {
        id: ENTRY_ID,
        status: 'draft',
        fiscal_period_id: 'fp-1',
        voucher_series: 'A',
        entry_date: '2026-09-01',
        description: 'Bank till kortskuld',
        source_type: sourceType,
        lines: LINES,
      },
    },
  }).supabase
}

function makeRequest(): Request {
  return new Request(`http://localhost/api/v1/companies/${COMPANY_ID}/journal-entries/${ENTRY_ID}/commit`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Content-Type': 'application/json',
      'Idempotency-Key': `idem${Math.floor(Math.random() * 1e6)}-1010-4abc-8def-1234567890ab`,
    },
  })
}

const routeParams = { params: Promise.resolve({ companyId: COMPANY_ID, id: ENTRY_ID }) }

beforeEach(() => {
  vi.clearAllMocks()
  mockCommitEntry.mockResolvedValue({ id: ENTRY_ID, status: 'posted' })
  mockLink.mockResolvedValue({ linked: 1, suggested: 0 })
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['bookkeeping:write'],
    mode: 'live',
    unattendedCommitLimit: null,
  })
})

describe('journal-entries.commit: a posted typed verifikat meets its open bank row', () => {
  it('hands the posted verifikat, its date and its lines to the bank matcher (crm#1958)', async () => {
    mockServiceClient.mockReturnValue(makeSupabase('manual'))

    const res = await POST(makeRequest(), routeParams)

    expect(res.status).toBe(200)
    expect(mockCommitEntry).toHaveBeenCalledTimes(1)
    expect(mockLink).toHaveBeenCalledTimes(1)
    const [, companyId, userId, voucher] = mockLink.mock.calls[0]
    expect([companyId, userId]).toEqual([COMPANY_ID, 'user-1'])
    expect(voucher).toEqual({ journalEntryId: ENTRY_ID, entryDate: '2026-09-01', lines: LINES })
  })

  it('leaves a draft another flow generated alone: that flow anchors its own bank row', async () => {
    mockServiceClient.mockReturnValue(makeSupabase('bank_transaction'))

    const res = await POST(makeRequest(), routeParams)

    expect(res.status).toBe(200)
    expect(mockLink).not.toHaveBeenCalled()
  })

  it('asks nothing of the matcher when the commit failed', async () => {
    mockServiceClient.mockReturnValue(makeSupabase('manual'))
    mockCommitEntry.mockRejectedValue(new Error('boom'))

    const res = await POST(makeRequest(), routeParams)

    expect(res.status).toBe(500)
    expect(mockLink).not.toHaveBeenCalled()
  })
})
