/**
 * POST /api/v1/companies/:companyId/imports/deposit-specification through
 * the v1 door of the operation registry
 * (src/lib/operations/deposit-specification.ts).
 *
 * The rules under test are the service's
 * (lib/import/deposit-specification.ts): what the file is, the refusals, and
 * a dry run that only reads and matches. Which bank row a deposit is and what
 * is written are tested with the attachment
 * (lib/import/bgmax/__tests__/attach.test.ts,
 * lib/import/camt054/__tests__/attach.test.ts), which is mocked here.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') throw new Error('NODE_ENV=test required')
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
vi.mock('@/lib/entitlements/multi-user', async () => {
  const actual = await vi.importActual<typeof import('@/lib/entitlements/multi-user')>('@/lib/entitlements/multi-user')
  return { ...actual, getMultiUserState: vi.fn().mockResolvedValue({ state: 'active' }), isMembershipDormant: () => false }
})

const attachMock = vi.fn()
vi.mock('@/lib/import/bgmax/attach', () => ({
  attachBgMaxDeposits: (...args: unknown[]) => attachMock(...args),
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createTableMockSupabase } from '@/tests/helpers'
import { septemberFile } from '@/lib/import/bgmax/__tests__/bgmax-fixture'
import { decemberFile, document, entry, notification, payment } from '@/lib/import/camt054/__tests__/camt054-fixture'
import { POST } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OWNER = { data: { company_id: COMPANY_ID, role: 'owner' }, error: null }
const URL_BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/imports/deposit-specification`
const params = { params: Promise.resolve({ companyId: COMPANY_ID }) }

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64')

function request(body: unknown, query = ''): Request {
  return new Request(`${URL_BASE}${query}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Idempotency-Key': crypto.randomUUID(),
      'Content-Type': 'application/json',
    },
  })
}

const post = (body: unknown, query = '') => POST(request(body, query), params)

const summary = (applied: boolean) => ({
  applied,
  deposits: 1,
  payments: 3,
  matched_deposits: 1,
  matched_payments: 3,
  suggested_payments: applied ? 3 : 0,
  ready_rows: applied ? 1 : 0,
  no_row: 0,
  ambiguous: 0,
  outcomes: [
    { date: '2026-12-01', amount: 1500, bankgiro: null, payments: 3, status: 'matched', transaction_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', suggested: applied ? 3 : 0 },
  ],
})

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['transactions:write'],
    mode: 'live',
  })
  mockServiceClient.mockReturnValue(createTableMockSupabase({ company_members: OWNER }).supabase)
  attachMock.mockImplementation(async (_supabase, input: { apply: boolean }) => summary(input.apply))
})

describe('POST /api/v1/companies/:companyId/imports/deposit-specification', () => {
  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    expect((await post({ filename: 'camt054.xml', content_base64: b64(decemberFile()) })).status).toBe(401)
    expect(attachMock).not.toHaveBeenCalled()
  })

  it('403 without transactions:write', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['transactions:read'], mode: 'live' })
    expect((await post({ filename: 'camt054.xml', content_base64: b64(decemberFile()) })).status).toBe(403)
    expect(attachMock).not.toHaveBeenCalled()
  })

  it('400 VALIDATION_ERROR for a missing file or content that is not base64', async () => {
    expect((await post({ filename: 'camt054.xml' })).status).toBe(400)
    const bad = await post({ filename: 'camt054.xml', content_base64: 'not base64 at all!' })
    expect(bad.status).toBe(400)
    expect((await bad.json()).error.code).toBe('VALIDATION_ERROR')
    expect(attachMock).not.toHaveBeenCalled()
  })

  it('400 BGMAX_NOT_DEPOSIT_FILE for a bank statement, attaching nothing', async () => {
    const bank = ['Bokföringsdag;Valutadag;Verifikationsnummer;Text;Belopp;Saldo', '2026-12-01;2026-12-01;12345;BG 123-4567;1500,00;12345,67'].join('\n')
    const res = await post({ filename: 'seb.csv', content_base64: b64(bank) })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('BGMAX_NOT_DEPOSIT_FILE')
    expect(attachMock).not.toHaveBeenCalled()
  })

  it('400 CAMT054_NO_DEPOSITS for a notification with nothing to attach', async () => {
    const debitsOnly = document([
      notification({ entries: [entry({ amount: '100.00', date: '2026-12-01', indicator: 'DBIT', payments: [payment({ amount: '100.00' })] })] }),
    ])
    const res = await post({ filename: 'camt054.xml', content_base64: b64(debitsOnly) })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('CAMT054_NO_DEPOSITS')
    expect(attachMock).not.toHaveBeenCalled()
  })

  it('reads a camt.054 notification and attaches its entries for the company in the path', async () => {
    const res = await post({ filename: 'camt054.xml', content_base64: b64(decemberFile()) })
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data).toMatchObject({ filename: 'camt054.xml', format: 'camt054', applied: true, date_from: '2026-12-01', rejected_deposits: 0, matched_deposits: 1, ready_rows: 1 })
    expect(attachMock).toHaveBeenCalledTimes(1)
    const input = attachMock.mock.calls[0]![1]
    expect(input).toMatchObject({ companyId: COMPANY_ID, userId: 'user-1', apply: true, source: 'camt054' })
    expect(input.deposits).toHaveLength(1)
    expect(input.deposits[0].payments).toHaveLength(3)
  })

  it('reads a BG Max file through the same door', async () => {
    const res = await post({ filename: 'BGMAX.txt', content_base64: b64(septemberFile()) })
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ format: 'bgmax', applied: true })
    expect(attachMock.mock.calls[0]![1]).toMatchObject({ apply: true, source: 'bgmax' })
    expect(attachMock.mock.calls[0]![1].deposits).toHaveLength(4)
  })

  it('a dry run reads and matches without writing', async () => {
    const res = await post({ filename: 'camt054.xml', content_base64: b64(decemberFile()) }, '?dry_run=true')
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.dry_run).toBe(true)
    expect(data.preview).toMatchObject({ format: 'camt054', applied: false, matched_deposits: 1, suggested_payments: 0 })
    expect(attachMock).toHaveBeenCalledTimes(1)
    expect(attachMock.mock.calls[0]![1]).toMatchObject({ apply: false })
  })
})
