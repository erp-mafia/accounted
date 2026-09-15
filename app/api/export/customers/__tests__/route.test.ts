import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as XLSX from 'xlsx'
import { createMockRequest, parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const mockFetchAllRows = vi.fn()
vi.mock('@/lib/supabase/fetch-all', () => ({
  fetchAllRows: (...a: unknown[]) => mockFetchAllRows(...a),
}))

import { GET } from '../route'
import { encryptPersonnummer } from '@/lib/salary/personnummer'
import { UNDECRYPTABLE_PERSONAL_NUMBER_MASK } from '@/lib/customers/protect-personal-number'

const mockUser = { id: 'user-1', email: 'test@test.se' }

const CUSTOMER = {
  id: 'c1',
  name: 'Acme AB',
  customer_number: '1001',
  customer_type: 'swedish_business',
  org_number: '5560217780',
  personal_number: null,
  email: 'kontakt@acme.se',
  phone: '0701234567',
  address_line1: 'Storgatan 1',
  address_line2: null,
  postal_code: '11122',
  city: 'Göteborg',
  country: 'Sweden',
  vat_number: 'SE556021778001',
  default_payment_terms: 30,
  notes: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  mockFetchAllRows.mockResolvedValue([CUSTOMER])
})

describe('GET /api/export/customers', () => {
  it('returns 401 when unauthenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const res = await GET(createMockRequest('/api/export/customers'), { params: Promise.resolve({}) })
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(401)
  })

  it('returns an xlsx customer register', async () => {
    enqueue({ data: { company_name: 'Acme AB' } })
    const res = await GET(createMockRequest('/api/export/customers'), { params: Promise.resolve({}) })

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('spreadsheetml')
    expect(res.headers.get('Content-Disposition')).toContain('kunder-')

    const buf = Buffer.from(await res.arrayBuffer())
    const wb = XLSX.read(new Uint8Array(buf), { type: 'array' })
    const sheet = wb.Sheets[wb.SheetNames[0]]
    const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1 })
    expect((rows[0] as string[])[0]).toBe('Namn')
    expect((rows[1] as string[])).toContain('Acme AB')
  })

  it('exports the customer number (#2368)', async () => {
    // The register is what a company reconciles against its own numbering, so
    // the number it edits on the customer has to leave with the file too.
    enqueue({ data: { company_name: 'Acme AB' } })
    const res = await GET(createMockRequest('/api/export/customers'), { params: Promise.resolve({}) })
    expect(res.status).toBe(200)

    const buf = Buffer.from(await res.arrayBuffer())
    const wb = XLSX.read(new Uint8Array(buf), { type: 'array' })
    const sheet = wb.Sheets[wb.SheetNames[0]]
    const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1 })
    const header = rows[0] as string[]
    expect(header).toContain('Kundnummer')
    // Appended, so the established column positions are untouched.
    expect(header[0]).toBe('Namn')
    expect((rows[1] as string[])[header.indexOf('Kundnummer')]).toBe('1001')
  })

  it('returns a CSV with BOM when format=csv', async () => {
    enqueue({ data: { company_name: 'Acme AB' } })
    const res = await GET(createMockRequest('/api/export/customers', { searchParams: { format: 'csv' } }), { params: Promise.resolve({}) })

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/csv')
    const buf = Buffer.from(await res.arrayBuffer())
    expect([buf[0], buf[1], buf[2]]).toEqual([0xef, 0xbb, 0xbf])
    expect(buf.toString('utf-8')).toContain('Göteborg')
  })

  it('masks an encrypted personal_number: never ciphertext, never the full number', async () => {
    // customers.personal_number holds AES-256-GCM ciphertext (migration
    // 20260726110000). The export must show what the UI shows a member:
    // '********-1234', not the hex blob and not the decrypted personnummer.
    const stored = encryptPersonnummer('19900101-1234') // synthetic
    mockFetchAllRows.mockResolvedValue([
      {
        ...CUSTOMER,
        id: 'c2',
        name: 'Anna Andersson',
        customer_type: 'individual',
        org_number: null,
        vat_number: null,
        personal_number: stored,
      },
    ])
    enqueue({ data: { company_name: 'Acme AB' } })

    const res = await GET(createMockRequest('/api/export/customers'), { params: Promise.resolve({}) })
    expect(res.status).toBe(200)

    const buf = Buffer.from(await res.arrayBuffer())
    const wb = XLSX.read(new Uint8Array(buf), { type: 'array' })
    const sheet = wb.Sheets[wb.SheetNames[0]]
    const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1 })
    const serialized = JSON.stringify(rows)

    expect(rows[1] as string[]).toContain('********-1234')
    // Neither the ciphertext nor the birthdate half of the number may appear.
    expect(serialized).not.toContain(stored)
    expect(serialized).not.toContain('19900101')
  })

  it('falls back to a placeholder mask when the stored value cannot be decrypted', async () => {
    // Hex of the shape the DB CHECK accepts, but with an auth tag that can
    // never verify. One bad row must neither leak nor abort the export.
    const garbage = 'ab'.repeat(40)
    mockFetchAllRows.mockResolvedValue([
      {
        ...CUSTOMER,
        id: 'c3',
        name: 'Berit Bengtsson',
        customer_type: 'individual',
        org_number: null,
        vat_number: null,
        personal_number: garbage,
      },
    ])
    enqueue({ data: { company_name: 'Acme AB' } })

    const res = await GET(createMockRequest('/api/export/customers', { searchParams: { format: 'csv' } }), { params: Promise.resolve({}) })
    expect(res.status).toBe(200)

    const text = Buffer.from(await res.arrayBuffer()).toString('utf-8')
    expect(text).toContain(UNDECRYPTABLE_PERSONAL_NUMBER_MASK)
    expect(text).not.toContain(garbage)
  })

  it('keeps the raw org number for business customers', async () => {
    // A legal entity's org number is public registry data: it exports
    // untouched, and the masking branch only engages when org_number is
    // absent or is itself a personnummer.
    enqueue({ data: { company_name: 'Acme AB' } })
    const res = await GET(createMockRequest('/api/export/customers', { searchParams: { format: 'csv' } }), { params: Promise.resolve({}) })
    const text = Buffer.from(await res.arrayBuffer()).toString('utf-8')
    expect(text).toContain('5560217780')
  })

  it('masks an org number that IS a personnummer, on a business row too (#2367)', async () => {
    // An enskild firma has no org number of its own: the owner's personnummer
    // is the firm's identifier, so it leaves the system masked like one.
    mockFetchAllRows.mockResolvedValue([
      {
        ...CUSTOMER,
        id: 'c4',
        name: 'Bertil Bengtsson Bygg',
        customer_type: 'swedish_business',
        org_number: '19900101-1234', // synthetic
        vat_number: null,
        personal_number: null,
      },
    ])
    enqueue({ data: { company_name: 'Acme AB' } })

    const res = await GET(createMockRequest('/api/export/customers', { searchParams: { format: 'csv' } }), { params: Promise.resolve({}) })
    expect(res.status).toBe(200)

    const text = Buffer.from(await res.arrayBuffer()).toString('utf-8')
    expect(text).toContain('********-1234')
    expect(text).not.toContain('19900101')
  })
})
