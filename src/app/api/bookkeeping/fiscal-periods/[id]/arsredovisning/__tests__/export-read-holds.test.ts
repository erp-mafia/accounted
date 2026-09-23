import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const state = vi.hoisted(() => ({ supabase: null as unknown }))
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: vi.fn(async () => ({ user: { id: 'user-1' }, supabase: state.supabase })),
}))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn(async () => 'company-1') }))
vi.mock('@/lib/auth/require-write', () => ({ requireWritePermission: vi.fn(async () => ({ ok: true })) }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn(() => ({ service: true })) }))
vi.mock('@react-pdf/renderer', () => ({ renderToBuffer: vi.fn() }))
vi.mock('@/lib/bokslut/arsredovisning/arsredovisning-pdf', () => ({ ArsredovisningPDF: vi.fn() }))
vi.mock('@/lib/bokslut/arsredovisning/arsredovisning-k3-pdf', () => ({ ArsredovisningK3PDF: vi.fn() }))
vi.mock('@/lib/bokslut/arsredovisning/model', () => ({ buildCanonicalAnnualReport: vi.fn() }))
vi.mock('@/lib/bokslut/ixbrl/build-input', () => ({ buildIxbrlInput: vi.fn() }))
vi.mock('@/lib/bokslut/ixbrl/document/k2-document', () => ({ generateK2IxbrlDocument: vi.fn() }))
vi.mock('@/lib/bokslut/arsredovisning/version-ixbrl', () => ({ getVersionIxbrlInput: vi.fn() }))
vi.mock('@/lib/bokslut/arsredovisning/version-service', () => ({
  getAnnualReportVersion: vi.fn(),
  createAnnualReportVersion: vi.fn(),
  hasStatementIntegrityErrors: vi.fn(() => false),
  listAnnualReportVersions: vi.fn(),
}))

import { renderToBuffer } from '@react-pdf/renderer'
import { buildCanonicalAnnualReport } from '@/lib/bokslut/arsredovisning/model'
import { buildIxbrlInput } from '@/lib/bokslut/ixbrl/build-input'
import { generateK2IxbrlDocument } from '@/lib/bokslut/ixbrl/document/k2-document'
import { getVersionIxbrlInput } from '@/lib/bokslut/arsredovisning/version-ixbrl'
import { createAnnualReportVersion, getAnnualReportVersion } from '@/lib/bokslut/arsredovisning/version-service'
import { GET as pdf } from '../pdf/route'
import { GET as ixbrl } from '../ixbrl/route'
import { POST as createVersion } from '../versions/route'

const params = { params: Promise.resolve({ id: 'period-1' }) }
const report = { accounting_framework: 'k2', fiscal_period: { period_end: '2025-12-31' } }
const model = { report, validation: { ok: true } }
const input = { period: { end: '2025-12-31' } }
const version = { id: 'version-1', summary: { status: 'signed' }, report_data: report }

function request(path: string, action?: string) {
  return new Request(`http://localhost/api/bookkeeping/fiscal-periods/period-1/arsredovisning/${path}`, action ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }),
  } : undefined)
}

function setup(held = false) {
  const mock = createQueuedMockSupabase()
  state.supabase = mock.supabase
  const events: string[] = []
  let active = false
  mock.supabase.rpc.mockImplementation(async (name: string) => {
    if (name === 'acquire_sie_period_read') {
      events.push('acquire')
      if (held) return { data: null, error: { code: '55000', message: 'SIE_IMPORT_HOLD' } }
      active = true
      return { data: 'lease-1', error: null }
    }
    expect(name).toBe('finish_sie_period_read')
    events.push('finish')
    active = false
    return { data: null, error: null }
  })
  return { ...mock, events, isActive: () => active }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(buildCanonicalAnnualReport).mockResolvedValue(model as never)
  vi.mocked(buildIxbrlInput).mockResolvedValue(input as never)
  vi.mocked(renderToBuffer).mockResolvedValue(Buffer.from('annual PDF'))
  vi.mocked(generateK2IxbrlDocument).mockReturnValue({ xhtml: '<html>annual report</html>', warnings: [] })
  vi.mocked(getAnnualReportVersion).mockResolvedValue(version as never)
  vi.mocked(getVersionIxbrlInput).mockResolvedValue(input as never)
  vi.mocked(createAnnualReportVersion).mockResolvedValue({ id: 'version-1' } as never)
})

describe('annual report import holds', () => {
  it.each([
    ['pdf', pdf], ['pdf?version=', pdf], ['ixbrl', ixbrl], ['ixbrl?download=1', ixbrl],
  ] as const)('blocks live %s before reading or rendering incomplete balances', async (path, handler) => {
    const mock = setup(true)
    const response = await handler(request(path), params)
    expect(response.status).toBe(409)
    expect(mock.events).toEqual(['acquire'])
    expect(buildCanonicalAnnualReport).not.toHaveBeenCalled()
    expect(buildIxbrlInput).not.toHaveBeenCalled()
    expect(renderToBuffer).not.toHaveBeenCalled()
    expect(generateK2IxbrlDocument).not.toHaveBeenCalled()
  })

  it.each([['pdf', pdf], ['ixbrl?download=1', ixbrl]] as const)(
    'holds the lease throughout live %s construction and rendering', async (path, handler) => {
      const mock = setup()
      vi.mocked(buildCanonicalAnnualReport).mockImplementation(async () => {
        expect(mock.isActive()).toBe(true)
        mock.events.push('build')
        return model as never
      })
      vi.mocked(buildIxbrlInput).mockImplementation(async () => {
        expect(mock.isActive()).toBe(true)
        mock.events.push('build')
        return input as never
      })
      vi.mocked(renderToBuffer).mockImplementation(async () => {
        expect(mock.isActive()).toBe(true)
        mock.events.push('render')
        return Buffer.from('annual PDF')
      })
      vi.mocked(generateK2IxbrlDocument).mockImplementation(() => {
        expect(mock.isActive()).toBe(true)
        mock.events.push('render')
        return { xhtml: '<html>annual report</html>', warnings: [] }
      })
      const response = await handler(request(path), params)
      expect(response.status).toBe(200)
      expect(mock.events).toEqual(['acquire', 'build', 'render', 'finish'])
      expect(mock.supabase.rpc).toHaveBeenLastCalledWith('finish_sie_period_read', {
        p_company_id: 'company-1', p_token: 'lease-1', p_require_valid: true,
      })
    },
  )

  it.each([['pdf?version=version-1', pdf], ['ixbrl?version=version-1&download=1', ixbrl]] as const)(
    'keeps frozen %s available without reading live balances', async (path, handler) => {
      const mock = setup(true)
      mock.enqueue({ data: [] }) // The PDF overlays only version-bound signatures.
      const response = await handler(request(path), params)
      expect(response.status).toBe(200)
      expect(response.headers.get('X-Annual-Report-Version')).toBe('version-1')
      expect(mock.supabase.rpc).not.toHaveBeenCalled()
      expect(buildCanonicalAnnualReport).not.toHaveBeenCalled()
      expect(buildIxbrlInput).not.toHaveBeenCalled()
    },
  )

  it.each(['snapshot', 'finalize'])('blocks %s before building or persisting a version', async action => {
    const mock = setup(true)
    mock.enqueue({ data: { id: 'period-1' } })
    const response = await createVersion(request('versions', action), params)
    expect(response.status).toBe(409)
    expect(buildCanonicalAnnualReport).not.toHaveBeenCalled()
    expect(createAnnualReportVersion).not.toHaveBeenCalled()
  })

  it.each(['snapshot', 'finalize'])('verifies the complete read before persisting a frozen %s', async action => {
    const mock = setup()
    mock.enqueue({ data: { id: 'period-1' } })
    vi.mocked(buildCanonicalAnnualReport).mockImplementation(async () => {
      expect(mock.isActive()).toBe(true)
      mock.events.push('build')
      return model as never
    })
    vi.mocked(createAnnualReportVersion).mockImplementation(async (_client, _actor, capturedModel, finalize) => {
      expect(mock.isActive()).toBe(false)
      expect(capturedModel).toBe(model)
      expect(finalize).toBe(action === 'finalize')
      mock.events.push('persist')
      return { id: 'version-1' } as never
    })
    const response = await createVersion(request('versions', action), params)
    expect(response.status).toBe(201)
    expect(mock.events).toEqual(['acquire', 'build', 'finish', 'persist'])
  })

  it.each(['snapshot', 'finalize'])('never persists %s when the model read outlives its lease', async action => {
    const mock = setup()
    mock.enqueue({ data: { id: 'period-1' } })
    mock.supabase.rpc.mockResolvedValueOnce({ data: 'lease-1', error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'SIE read lease expired' } })
      .mockResolvedValueOnce({ data: null, error: null })
    const response = await createVersion(request('versions', action), params)
    expect(buildCanonicalAnnualReport).toHaveBeenCalledOnce()
    expect(createAnnualReportVersion).not.toHaveBeenCalled()
    expect(response.status).toBe(500)
    expect(mock.supabase.rpc).toHaveBeenLastCalledWith('finish_sie_period_read', {
      p_company_id: 'company-1', p_token: 'lease-1', p_require_valid: false,
    })
  })

  it('does not return a rendered PDF if the lease expires during generation', async () => {
    const mock = setup()
    mock.supabase.rpc.mockResolvedValueOnce({ data: 'lease-1', error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'SIE read lease expired' } })
      .mockResolvedValueOnce({ data: null, error: null })
    const response = await pdf(request('pdf'), params)
    expect(renderToBuffer).toHaveBeenCalledOnce()
    expect(response.status).toBe(500)
    expect(response.headers.get('Content-Type')).not.toContain('application/pdf')
    expect(mock.supabase.rpc).toHaveBeenLastCalledWith('finish_sie_period_read', {
      p_company_id: 'company-1', p_token: 'lease-1', p_require_valid: false,
    })
  })
})
