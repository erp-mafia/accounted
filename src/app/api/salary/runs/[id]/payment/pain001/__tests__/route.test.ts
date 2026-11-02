import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createQueuedMockSupabase,
  createMockRequest,
  createMockRouteParams,
  makePayingCashAccount,
  payingAccountReads,
} from '@/tests/helpers'

// The route is wrapped in withRouteContext and gated with requireWrite (it
// persists payment_file_generated_at). The XML generator, net-payout helper and
// branding are stubbed so we can exercise auth + the happy path.
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('@/lib/salary/payment/pain001-generator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/salary/payment/pain001-generator')>()),
  generatePain001: vi.fn(() => '<Document/>'),
}))
vi.mock('@/lib/salary/payment/effective-net', () => ({
  effectiveNetPayout: vi.fn(() => 20000),
}))
vi.mock('@/lib/branding/service', () => ({
  getBranding: vi.fn(() => ({ appName: 'gnubok' })),
}))

import { GET, POST } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { requireWritePermission } from '@/lib/auth/require-write'
import { generatePain001 } from '@/lib/salary/payment/pain001-generator'

const mockUser = { id: 'user-1', email: 'test@test.se' }

function authed() {
  const { supabase, enqueueMany, findCall } = createQueuedMockSupabase()
  vi.mocked(requireAuth).mockResolvedValue({
    user: mockUser as never,
    supabase: supabase as never,
    error: null,
  })
  return { supabase, enqueueMany, findCall }
}

describe('GET /api/salary/runs/[id]/payment/pain001', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requireWritePermission).mockResolvedValue({ ok: true } as never)
  })

  it('returns 401 when not authenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null,
      supabase: null as never,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const response = await GET(
      createMockRequest('/api/salary/runs/run-1/payment/pain001'),
      createMockRouteParams({ id: 'run-1' }),
    )
    expect(response.status).toBe(401)
  })

  it('returns 403 for a viewer', async () => {
    authed()
    vi.mocked(requireWritePermission).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    } as never)
    const response = await GET(
      createMockRequest('/api/salary/runs/run-1/payment/pain001'),
      createMockRouteParams({ id: 'run-1' }),
    )
    expect(response.status).toBe(403)
  })

  it('returns 400 and makes no file when a correction run has no difference to pay', async () => {
    // effectiveNetPayout is stubbed to 20 000 for every row: the correction
    // pays exactly what the run it corrects paid, so nothing is left to pay.
    const { enqueueMany } = authed()
    const employee = { employee_id: 'e1', employee: { first_name: 'Anna', last_name: 'A', clearing_number: '6000', bank_account_number: '123456789' } }
    enqueueMany([
      { data: { id: 'run-1', status: 'approved', period_year: 2026, period_month: 9, payment_date: '2026-09-25', corrects_run_id: 'run-0' } },
      { data: { name: 'Bolaget AB', org_number: '5560000000' } }, // companies
      { data: { company_name: 'Bolaget AB', iban: 'SE4550000000058398257466', bic: 'NDEASESS', nordea_signer_id: 'NB10000123456', nordea_agreement_id: 'NB123456' } }, // company_settings
      ...payingAccountReads(),
      { data: [employee] }, // salary_run_employees
      { data: { id: 'run-0', corrects_run_id: null } }, // the corrected run
      { data: [{ id: 'sre-0', ...employee }] }, // its roster
    ])

    const response = await GET(
      createMockRequest('/api/salary/runs/run-1/payment/pain001'),
      createMockRouteParams({ id: 'run-1' }),
    )

    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe('Rättelsen ger ingen skillnad att betala ut jämfört med den tidigare körningen.')
    expect(generatePain001).not.toHaveBeenCalled()
  })

  it('returns 404 when the run does not exist', async () => {
    const { enqueueMany } = authed()
    enqueueMany([{ data: null }])

    const response = await GET(
      createMockRequest('/api/salary/runs/run-1/payment/pain001'),
      createMockRouteParams({ id: 'run-1' }),
    )

    expect(response.status).toBe(404)
  })

  it('returns 400 naming the employee whose stored details name no payable account, never the number', async () => {
    // Invented number: 11 digits that do not repeat the clearing. The old
    // 5-11 digit entry rule accepted it; no file can carry it.
    const { enqueueMany } = authed()
    enqueueMany([
      { data: { id: 'run-1', status: 'approved', period_year: 2026, period_month: 9, payment_date: '2026-09-25' } },
      { data: { name: 'Bolaget AB', org_number: '5560000000' } }, // companies
      { data: { company_name: 'Bolaget AB', iban: 'SE4550000000058398257466', bic: 'NDEASESS', nordea_signer_id: 'NB10000123456', nordea_agreement_id: 'NB123456' } }, // settings
      ...payingAccountReads(),
      {
        data: [
          { employee_id: 'e1', employee: { first_name: 'Lena', last_name: 'L', clearing_number: '5037', bank_account_number: '96123456789' } },
        ],
      }, // salary_run_employees
    ])

    const response = await GET(
      createMockRequest('/api/salary/runs/run-1/payment/pain001'),
      createMockRouteParams({ id: 'run-1' }),
    )

    expect(response.status).toBe(400)
    const text = await response.text()
    expect(JSON.parse(text).error).toBe(
      'Lena L: kontonumret är ogiltigt (5-10 siffror, utan clearingnummer). Rätta bankuppgifterna.',
    )
    expect(text).not.toContain('96123456789')
    expect(generatePain001).not.toHaveBeenCalled()
  })

  it('returns 400 asking for the Swedbank ids when a Swedbank company has not entered them', async () => {
    const { enqueueMany } = authed()
    enqueueMany([
      { data: { id: 'run-1', status: 'approved', period_year: 2026, period_month: 9, payment_date: '2026-09-25' } },
      { data: { name: 'Bolaget AB', org_number: '5560000000' } }, // companies
      { data: { company_name: 'Bolaget AB', iban: 'SE4580000832790000012345', bic: 'SWEDSESS' } }, // settings
      ...payingAccountReads(),
    ])

    const response = await GET(
      createMockRequest('/api/salary/runs/run-1/payment/pain001'),
      createMockRouteParams({ id: 'run-1' }),
    )

    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error).toContain('SignerID')
    expect(body.error).toContain('Inställningar → Fakturor')
    expect(generatePain001).not.toHaveBeenCalled()
  })

  it('returns 400 asking for the Nordea Signer ID when a Nordea company has not entered it (crm#1530)', async () => {
    const { enqueueMany } = authed()
    enqueueMany([
      { data: { id: 'run-1', status: 'approved', period_year: 2026, period_month: 9, payment_date: '2026-09-25' } },
      { data: { name: 'Bolaget AB', org_number: '5560000000' } }, // companies
      { data: { company_name: 'Bolaget AB', iban: 'SE4550000000058398257466', bic: 'NDEASESS' } }, // settings
      ...payingAccountReads(),
    ])

    const response = await GET(
      createMockRequest('/api/salary/runs/run-1/payment/pain001'),
      createMockRouteParams({ id: 'run-1' }),
    )

    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error).toContain('Signer ID')
    expect(body.error).toContain('Inställningar → Fakturor')
    expect(generatePain001).not.toHaveBeenCalled()
  })

  it('returns 400 asking for the Nordea agreement id when a Nordea company has only the Signer ID (crm#1530)', async () => {
    const { enqueueMany } = authed()
    enqueueMany([
      { data: { id: 'run-1', status: 'approved', period_year: 2026, period_month: 9, payment_date: '2026-09-25' } },
      { data: { name: 'Bolaget AB', org_number: '5560000000' } }, // companies
      { data: { company_name: 'Bolaget AB', iban: 'SE4550000000058398257466', bic: 'NDEASESS', nordea_signer_id: 'NB10000123456' } }, // settings
      ...payingAccountReads(),
    ])

    const response = await GET(
      createMockRequest('/api/salary/runs/run-1/payment/pain001'),
      createMockRouteParams({ id: 'run-1' }),
    )

    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error).toContain('avtals-ID')
    expect(body.error).toContain('Inställningar → Fakturor')
    expect(generatePain001).not.toHaveBeenCalled()
  })

  it('returns 400 naming the paying account and where its IBAN is filled when it has none (crm#1483)', async () => {
    const { enqueueMany } = authed()
    enqueueMany([
      { data: { id: 'run-1', status: 'approved', period_year: 2026, period_month: 9, payment_date: '2026-09-25' } },
      { data: { name: 'Bolaget AB', org_number: '5560000000' } }, // companies
      // The settings IBAN is the savings account's: the company has two
      // accounts, so the primary's missing IBAN is never filled from it.
      { data: { company_name: 'Bolaget AB', iban: 'SE7150000000058391234567', bic: 'ESSESESS' } },
      ...payingAccountReads([
        makePayingCashAccount({ name: 'Företagskonto' }),
        makePayingCashAccount({
          id: 'ca-1931',
          name: 'Sparkonto',
          ledger_account: '1931',
          is_primary: false,
          payee_iban: 'SE7150000000058391234567',
        }),
      ]),
    ])

    const response = await GET(
      createMockRequest('/api/salary/runs/run-1/payment/pain001'),
      createMockRouteParams({ id: 'run-1' }),
    )

    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe(
      'Betalfilen betalar från Företagskonto (1930), men kontot saknar IBAN. Fyll i kontots IBAN under Inställningar → Fakturor, Bankkonton för kundfakturor.',
    )
    expect(generatePain001).not.toHaveBeenCalled()
  })

  it('carries a 5-digit clearing with a 10-digit account (no fixed-width field in pain.001)', async () => {
    const { enqueueMany } = authed()
    enqueueMany([
      { data: { id: 'run-1', status: 'approved', period_year: 2026, period_month: 9, payment_date: '2026-09-25' } },
      { data: { name: 'Bolaget AB', org_number: '5560000000' } },
      { data: { company_name: 'Bolaget AB', iban: 'SE4550000000058398257466', bic: 'NDEASESS', nordea_signer_id: 'NB10000123456', nordea_agreement_id: 'NB123456' } },
      ...payingAccountReads(),
      {
        data: [
          { employee_id: 'e2', employee: { first_name: 'Sara', last_name: 'S', clearing_number: '8327-9', bank_account_number: '9612345678' } },
        ],
      },
      { data: null },
    ])

    const response = await GET(
      createMockRequest('/api/salary/runs/run-1/payment/pain001'),
      createMockRouteParams({ id: 'run-1' }),
    )

    expect(response.status).toBe(200)
  })

  it('generates a pain.001 file for an approved run', async () => {
    const { enqueueMany } = authed()
    enqueueMany([
      { data: { id: 'run-1', status: 'approved', period_year: 2026, period_month: 3, payment_date: '2026-03-25' } },
      { data: { name: 'Bolaget AB', org_number: '5560000000' } }, // companies
      { data: { company_name: 'Bolaget AB', iban: 'SE4550000000058398257466', bic: 'NDEASESS', nordea_signer_id: 'NB10000123456', nordea_agreement_id: 'NB123456' } }, // settings
      ...payingAccountReads(),
      {
        data: [
          {
            employee: { first_name: 'Anna', last_name: 'A', clearing_number: '1234', bank_account_number: '567890' },
          },
        ],
      }, // salary_run_employees
      { data: null }, // salary_runs update
    ])

    const response = await GET(
      createMockRequest('/api/salary/runs/run-1/payment/pain001'),
      createMockRouteParams({ id: 'run-1' }),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/xml; charset=utf-8')
    expect(response.headers.get('Content-Disposition')).toContain('pain001_lon_2026-03.xml')
    // A Nordea company's file names the sender by its Signer ID (crm#1530).
    expect(vi.mocked(generatePain001).mock.calls[0][0]).toMatchObject({
      nordeaSignerId: 'NB10000123456',
      nordeaAgreementId: 'NB123456',
      swedbank: null,
    })
  })
})

// crm#1219: a new version of the run's pain.001, only with the confirmation.
describe('POST /api/salary/runs/[id]/payment/pain001 (new version)', () => {
  const URL = '/api/salary/runs/run-1/payment/pain001'
  const confirmed = { method: 'POST', body: { confirm_previous_not_approved: true } }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requireWritePermission).mockResolvedValue({ ok: true } as never)
  })

  it('returns 401 when not authenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null,
      supabase: null as never,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const response = await POST(createMockRequest(URL, confirmed), createMockRouteParams({ id: 'run-1' }))
    expect(response.status).toBe(401)
  })

  it.each([
    ['no body field', {}],
    ['a false confirmation', { confirm_previous_not_approved: false }],
    ['an unknown field', { confirm_previous_not_approved: true, version: 7 }],
  ])('returns 400 and builds nothing for %s', async (_label, body) => {
    const { supabase } = authed()
    const response = await POST(createMockRequest(URL, { method: 'POST', body }), createMockRouteParams({ id: 'run-1' }))
    expect(response.status).toBe(400)
    expect(vi.mocked(supabase.from)).not.toHaveBeenCalled()
    expect(generatePain001).not.toHaveBeenCalled()
  })

  it('returns 404 when the run does not exist', async () => {
    const { enqueueMany } = authed()
    enqueueMany([{ data: null }])
    const response = await POST(createMockRequest(URL, confirmed), createMockRouteParams({ id: 'run-1' }))
    expect(response.status).toBe(404)
  })

  it('makes the next version with new ids and archives it with the confirmation', async () => {
    const { enqueueMany, findCall } = authed()
    enqueueMany([
      { data: { id: 'run-1', status: 'booked', period_year: 2026, period_month: 10, payment_date: '2026-10-23', payment_file_version: 1 } },
      { data: { name: 'Bolaget AB', org_number: '5560000000' } }, // companies
      { data: { company_name: 'Bolaget AB', iban: 'SE7212000000012200111878', bic: 'DABASESX' } }, // settings
      ...payingAccountReads(),
      {
        data: [
          {
            employee: { first_name: 'Anna', last_name: 'A', clearing_number: '1344', bank_account_number: '2045678' },
          },
        ],
      }, // salary_run_employees
      { data: null }, // salary_payment_files insert
      { data: null }, // salary_runs update
    ])

    const response = await POST(createMockRequest(URL, confirmed), createMockRouteParams({ id: 'run-1' }))

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Disposition')).toContain('pain001_lon_2026-10_v2.xml')
    expect(vi.mocked(generatePain001).mock.calls[0][2]).toMatchObject({ messageId: 'LON-5560000000-2026-10-V2' })
    expect(findCall('salary_payment_files', 'insert')?.[0]).toMatchObject({
      version: 2,
      previous_not_approved_confirmed: true,
      user_id: 'user-1',
    })
  })
})

