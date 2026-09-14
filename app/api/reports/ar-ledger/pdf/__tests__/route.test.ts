import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isValidElement } from 'react'
import { NextResponse } from 'next/server'

const mockSupabase = {
  auth: { getUser: vi.fn() },
  from: vi.fn(),
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: vi.fn(),
}))

// Stub the PDF renderer so the test never spins up real PDF layout. Provide the
// primitives the template imports at module load (StyleSheet.create runs then).
vi.mock('@react-pdf/renderer', () => ({
  renderToBuffer: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 test')),
  StyleSheet: { create: (s: unknown) => s },
  Document: (p: unknown) => p,
  Page: (p: unknown) => p,
  Text: (p: unknown) => p,
  View: (p: unknown) => p,
}))

vi.mock('@/lib/reports/ar-ledger', () => ({
  generateARLedger: vi.fn(),
}))

import { GET } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { generateARLedger } from '@/lib/reports/ar-ledger'
import { renderToBuffer } from '@react-pdf/renderer'

const mockUser = { id: 'user-1', email: 'test@test.se' }

/**
 * The template renders for real (only renderToBuffer is stubbed), so the
 * document handed to it can be walked for its text. Joining the leaves with ''
 * reproduces the text of any single <Text>.
 */
function renderedText(node: unknown): string {
  const out: string[] = []
  const walk = (n: unknown): void => {
    if (n === null || n === undefined || typeof n === 'boolean') return
    if (typeof n === 'string' || typeof n === 'number') {
      out.push(String(n))
      return
    }
    if (Array.isArray(n)) {
      n.forEach(walk)
      return
    }
    if (isValidElement(n)) {
      walk((n.props as { children?: unknown }).children)
    }
  }
  walk(node)
  // Intl's sv-SE group separator is a non-breaking space; normalise every
  // space-like character so the assertions below can use ordinary spaces.
  return out.join('').replace(/\s/g, ' ')
}

function renderedDocumentText(): string {
  return renderedText(vi.mocked(renderToBuffer).mock.calls[0][0])
}

function companySettingsQuery(data: unknown) {
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data, error: null }),
  }
}

function makeLedger() {
  return {
    entries: [
      {
        customer_id: 'cust-1',
        customer_name: 'Acme AB',
        invoices: [
          {
            invoice_id: 'inv-1',
            invoice_number: 'F001',
            invoice_date: '2026-05-01',
            due_date: '2026-06-01',
            total: 1000,
            paid_amount: 0,
            outstanding: 1000,
            outstanding_sek: 1000,
            days_overdue: 14,
            currency: 'SEK',
          },
        ],
        current: 0,
        days_1_30: 1000,
        days_31_60: 0,
        days_61_90: 0,
        days_90_plus: 0,
        total_outstanding: 1000,
      },
    ],
    total_outstanding: 1000,
    total_current: 0,
    total_overdue: 1000,
    unpaid_count: 1,
    unconverted_fx_count: 0,
  }
}

/**
 * One SEK invoice plus one EUR invoice with a rate, plus one USD invoice with
 * no rate (outstanding_sek null, so it is missing from the aging buckets).
 * The aging totals are SEK: 1 000 + 11 475.
 */
function makeFxLedger() {
  return {
    entries: [
      {
        customer_id: 'cust-1',
        customer_name: 'Acme AB',
        invoices: [
          {
            invoice_id: 'inv-1',
            invoice_number: 'F001',
            invoice_date: '2026-05-01',
            due_date: '2026-06-01',
            total: 1000,
            paid_amount: 0,
            outstanding: 1000,
            outstanding_sek: 1000,
            days_overdue: 14,
            currency: 'SEK',
          },
          {
            invoice_id: 'inv-2',
            invoice_number: 'F002',
            invoice_date: '2026-05-02',
            due_date: '2026-06-02',
            total: 1000,
            paid_amount: 0,
            outstanding: 1000,
            outstanding_sek: 11475,
            days_overdue: 13,
            currency: 'EUR',
          },
          {
            invoice_id: 'inv-3',
            invoice_number: 'F003',
            invoice_date: '2026-05-03',
            due_date: '2026-06-03',
            total: 500,
            paid_amount: 0,
            outstanding: 500,
            outstanding_sek: null,
            days_overdue: 12,
            currency: 'USD',
          },
        ],
        current: 0,
        days_1_30: 12475,
        days_31_60: 0,
        days_61_90: 0,
        days_90_plus: 0,
        total_outstanding: 12475,
      },
    ],
    total_outstanding: 12475,
    total_current: 0,
    total_overdue: 12475,
    unpaid_count: 3,
    unconverted_fx_count: 1,
  }
}

function makeRequest(query = '') {
  return new Request(`http://localhost/api/reports/ar-ledger/pdf${query}`)
}

describe('GET /api/reports/ar-ledger/pdf', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requireAuth).mockResolvedValue({
      user: mockUser as never,
      supabase: mockSupabase as never,
      error: null,
    })
    mockSupabase.from.mockReturnValue(
      companySettingsQuery({ company_name: 'Testbolaget AB', org_number: '5566778899' }),
    )
    vi.mocked(generateARLedger).mockResolvedValue(makeLedger() as never)
  })

  it('returns 401 when not authenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null as never,
      supabase: mockSupabase as never,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const res = await GET(makeRequest(), { params: Promise.resolve({}) } as never)
    expect(res.status).toBe(401)
  })

  it('returns 400 for a malformed as_of_date', async () => {
    const res = await GET(makeRequest('?as_of_date=not-a-date'), { params: Promise.resolve({}) } as never)
    expect(res.status).toBe(400)
    expect(generateARLedger).not.toHaveBeenCalled()
  })

  it('returns 404 when company settings are missing', async () => {
    mockSupabase.from.mockReturnValue(companySettingsQuery(null))

    const res = await GET(makeRequest('?as_of_date=2026-06-30'), { params: Promise.resolve({}) } as never)
    expect(res.status).toBe(404)
  })

  it('renders a PDF for the requested as-of date', async () => {
    const res = await GET(makeRequest('?as_of_date=2026-06-30'), { params: Promise.resolve({}) } as never)

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
    expect(res.headers.get('Content-Disposition')).toContain('kundreskontra')
    expect(res.headers.get('Content-Disposition')).toContain('20260630')
    expect(generateARLedger).toHaveBeenCalledWith(mockSupabase, 'company-1', '2026-06-30')
  })

  it('defaults to today when no as_of_date is given', async () => {
    const res = await GET(makeRequest(), { params: Promise.resolve({}) } as never)

    expect(res.status).toBe(200)
    const calledWith = vi.mocked(generateARLedger).mock.calls[0][2]
    expect(calledWith).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('returns 500 when the generator throws', async () => {
    vi.mocked(generateARLedger).mockRejectedValue(new Error('boom'))

    const res = await GET(makeRequest('?as_of_date=2026-06-30'), { params: Promise.resolve({}) } as never)
    expect(res.status).toBe(500)
  })

  it('forwards outstanding_sek so the PDF carries the SEK bridge column', async () => {
    vi.mocked(generateARLedger).mockResolvedValue(makeFxLedger() as never)

    const res = await GET(makeRequest('?as_of_date=2026-06-30'), { params: Promise.resolve({}) } as never)
    expect(res.status).toBe(200)

    const text = renderedDocumentText()
    // The bridge column the XLSX export has ("Utestående (SEK)") now exists here too.
    expect(text).toContain('Utest. SEK')
    expect(text).toContain('11 475,00')
    // ...and the two units on the page are named rather than left implicit.
    expect(text).toContain('Åldersfördelning per kund (SEK)')
    expect(text).toContain('Fakturor (fakturans valuta)')
  })

  it('marks an unconvertible FX invoice instead of dropping it from the PDF', async () => {
    vi.mocked(generateARLedger).mockResolvedValue(makeFxLedger() as never)

    await GET(makeRequest('?as_of_date=2026-06-30'), { params: Promise.resolve({}) } as never)

    const text = renderedDocumentText()
    expect(text).toContain('F003')
    expect(text).toContain('saknas')
    expect(text).toContain('1 faktura i utländsk valuta saknar växelkurs')
  })

  it('leaves a SEK-only PDF without the bridge column', async () => {
    const res = await GET(makeRequest('?as_of_date=2026-06-30'), { params: Promise.resolve({}) } as never)
    expect(res.status).toBe(200)

    const text = renderedDocumentText()
    expect(text).not.toContain('Utest. SEK')
    expect(text).toContain('Fakturor (SEK)')
  })
})

// The shared route-wrapper tests cover the database read lease.
vi.mock('@/lib/import/sie-period-read', () => ({
  withSIEPeriodRead: (_client: unknown, _company: string, _purpose: string, read: () => Promise<unknown>) => read(),
}))
