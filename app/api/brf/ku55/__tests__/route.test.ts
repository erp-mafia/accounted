import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase, enqueue, reset } = createQueuedMockSupabase()
const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/company/brf-tax-profile', async () => {
  const actual = await vi.importActual<typeof import('@/lib/company/brf-tax-profile')>('@/lib/company/brf-tax-profile')
  return { ...actual, requireBrfForm: vi.fn() }
})
vi.mock('@/lib/brf/ku55-service', () => ({ assembleKU55: vi.fn() }))
vi.mock('@/lib/branding/service', () => ({ getBranding: () => ({ appName: 'Accounted' }) }))

import { requireBrfForm } from '@/lib/company/brf-tax-profile'
import { assembleKU55 } from '@/lib/brf/ku55-service'
import { GET } from '../route'

const routeParams = { params: Promise.resolve({}) }
const complete = {
  transfer_id: 't1',
  specification_number: 1,
  seller_member_id: 'm1',
  complete: true,
  problems: [],
  fields: { '215': '198501011234', '203': 2026, '570': 1, '630': '1203', '631': '20260301', '632': '100.00', '634': 2000000, '646': 'I' },
}
const incomplete = { ...complete, transfer_id: 't2', specification_number: 2, complete: false, problems: ['Personnummer saknas'], fields: { '203': 2026, '570': 2 } }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
  vi.mocked(requireBrfForm).mockResolvedValue(undefined)
  vi.mocked(assembleKU55).mockResolvedValue({ income_year: 2026, items: [complete, incomplete], warnings: [] })
})

describe('GET /api/brf/ku55', () => {
  it('validates income_year', async () => {
    expect((await GET(createMockRequest('/api/brf/ku55'), routeParams)).status).toBe(400)
    expect((await GET(createMockRequest('/api/brf/ku55?income_year=99'), routeParams)).status).toBe(400)
  })

  it('returns every KU with its problems as JSON', async () => {
    const { status, body } = await parseJsonResponse<{ data: { items: Array<{ complete: boolean }> } }>(
      await GET(createMockRequest('/api/brf/ku55?income_year=2026'), routeParams),
    )
    expect(status).toBe(200)
    expect(body.data.items.map((i) => i.complete)).toEqual([true, false])
  })

  it('renders the XML file with only the complete KUs and reports the skipped count', async () => {
    enqueue({ data: { name: 'Brf Solhöjden', org_number: '769600-1234' } })
    enqueue({ data: { company_name: 'Brf Solhöjden', org_number: '769600-1234', phone: '08-123', email: 'brf@x.se' } })
    enqueue({ data: { full_name: 'Karin K', email: 'karin@x.se' } })
    const res = await GET(createMockRequest('/api/brf/ku55?income_year=2026&format=xml'), routeParams)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('application/xml')
    expect(res.headers.get('X-KU55-Incomplete')).toBe('1')
    const xml = await res.text()
    expect(xml.match(/<ku:KU55>/g)).toHaveLength(1)
    expect(xml).toContain('<ku:Inkomsttagare faltkod="215">198501011234</ku:Inkomsttagare>')
    expect(xml).toContain('<ku:UppgiftslamnarId faltkod="201">167696001234</ku:UppgiftslamnarId>')
  })

  it('refuses the XML when the company has no organisationsnummer', async () => {
    enqueue({ data: { name: 'Brf', org_number: null } })
    enqueue({ data: { company_name: 'Brf', org_number: null, phone: null, email: null } })
    enqueue({ data: null })
    expect((await GET(createMockRequest('/api/brf/ku55?income_year=2026&format=xml'), routeParams)).status).toBe(400)
  })
})
