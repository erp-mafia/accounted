import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset, findCall, findCalls } = createQueuedMockSupabase()

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const mockEmit = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/events', () => ({ eventBus: { emit: (...a: unknown[]) => mockEmit(...a) } }))

const mockFetchAllRows = vi.fn()
vi.mock('@/lib/supabase/fetch-all', () => ({
  fetchAllRows: (...a: unknown[]) => mockFetchAllRows(...a),
}))

import { POST } from '../execute/route'
import type { SupplierImportExecuteResult } from '@/lib/import/suppliers/types'
import { parseSuppliersFile } from '@/lib/import/suppliers/parser'
import { rowsForExecute } from '@/lib/import/register-import-flow'

type ExecuteBody = { data: SupplierImportExecuteResult }

const mockUser = { id: 'user-1', email: 'test@test.se' }

const KONTOR_ID = '0b7a3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d'

function row(overrides: Record<string, unknown> = {}) {
  return {
    row_index: 2,
    name: 'Kontorsvaror AB',
    supplier_type: 'swedish_business',
    org_number: null,
    email: null,
    phone: null,
    address_line1: null,
    address_line2: null,
    postal_code: null,
    city: null,
    country: 'SE',
    vat_number: null,
    bankgiro: null,
    plusgiro: null,
    bank_account: null,
    iban: null,
    bic: null,
    default_payment_terms: 30,
    default_currency: 'SEK',
    notes: null,
    ...overrides,
  }
}

function post(body: unknown) {
  const request = createMockRequest('/api/import/suppliers/execute', { method: 'POST', body })
  return POST(request, { params: Promise.resolve({}) })
}

describe('POST /api/import/suppliers/execute', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
    mockFetchAllRows.mockResolvedValue([])
  })

  it('returns 401 for unauthenticated requests', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const { status } = await parseJsonResponse(await post({ rows: [row()], update_duplicates: false }))
    expect(status).toBe(401)
  })

  it('returns 400 for an empty rows array', async () => {
    const { status } = await parseJsonResponse(await post({ rows: [], update_duplicates: false }))
    expect(status).toBe(400)
  })

  it('returns 400 when confirmed_duplicate_of is not an id', async () => {
    const { status } = await parseJsonResponse(
      await post({ rows: [row({ confirmed_duplicate_of: 'Kontorsvaror AB' })], update_duplicates: true }),
    )
    expect(status).toBe(400)
  })

  it('still matches a 12-digit org number to the stored 10-digit one', async () => {
    mockFetchAllRows.mockResolvedValue([
      { id: 'x', name: 'Kontorsvaror AB', org_number: '5560217780', email: null },
    ])

    const { status, body } = await parseJsonResponse<ExecuteBody>(
      await post({ rows: [row({ org_number: '165560217780' })], update_duplicates: false }),
    )

    expect(status).toBe(200)
    expect(body.data.skipped).toBe(1)
    expect(findCall('suppliers', 'insert')).toBeUndefined()
  })

  describe('the terms', () => {
    const matched = { id: 'x', name: 'Kontorsvaror AB', org_number: '5560217780', email: null, default_payment_terms: 14 }

    it('leaves the terms of a matched supplier alone when the file has none', async () => {
      mockFetchAllRows.mockResolvedValue([matched])
      enqueue({ data: { id: 'x', name: 'Kontorsvaror AB' } })

      await post({ rows: [row({ org_number: '5560217780', default_payment_terms: null })], update_duplicates: true })

      const [payload] = findCall('suppliers', 'update') as [Record<string, unknown>]
      expect(payload).not.toHaveProperty('default_payment_terms')
    })

    it('merges 0 days from the file: betalning direkt is a term', async () => {
      mockFetchAllRows.mockResolvedValue([matched])
      enqueue({ data: { id: 'x', name: 'Kontorsvaror AB' } })

      await post({ rows: [row({ org_number: '5560217780', default_payment_terms: 0 })], update_duplicates: true })

      const [payload] = findCall('suppliers', 'update') as [Record<string, unknown>]
      expect(payload.default_payment_terms).toBe(0)
    })

    it('a new supplier the file gives 0 days keeps them', async () => {
      enqueue({ data: { id: 's1', name: 'Kontorsvaror AB' } })

      await post({ rows: [row({ default_payment_terms: 0 })], update_duplicates: false })

      const [payload] = findCall('suppliers', 'insert') as [Record<string, unknown>]
      expect(payload.default_payment_terms).toBe(0)
    })

    it('a new supplier the file gives no terms gets 30 days', async () => {
      enqueue({ data: { id: 's1', name: 'Kontorsvaror AB' } })

      await post({ rows: [row({ default_payment_terms: null })], update_duplicates: false })

      const [payload] = findCall('suppliers', 'insert') as [Record<string, unknown>]
      expect(payload.default_payment_terms).toBe(30)
    })
  })

  it('creates a new supplier when only the name matches and the user did not confirm', async () => {
    mockFetchAllRows.mockResolvedValue([
      { id: KONTOR_ID, name: 'Kontorsvaror AB', org_number: null, email: null },
    ])
    enqueue({ data: { id: 's1', name: 'Kontorsvaror AB', org_number: null, email: null } })

    const { status, body } = await parseJsonResponse<ExecuteBody>(
      await post({ rows: [row()], update_duplicates: true }),
    )

    expect(status).toBe(200)
    expect(body.data.created).toBe(1)
    expect(findCall('suppliers', 'update')).toBeUndefined()
  })

  it('updates the same-name supplier the user confirmed', async () => {
    mockFetchAllRows.mockResolvedValue([
      { id: KONTOR_ID, name: 'Kontorsvaror AB', org_number: null, email: null },
    ])
    enqueue({ data: { id: KONTOR_ID, name: 'Kontorsvaror AB', bankgiro: '5050-1055' } })

    const { status, body } = await parseJsonResponse<ExecuteBody>(
      await post({
        rows: [row({ bankgiro: '5050-1055', confirmed_duplicate_of: KONTOR_ID })],
        update_duplicates: true,
      }),
    )

    expect(status).toBe(200)
    expect(body.data.updated).toBe(1)
    expect(findCalls('suppliers', 'eq')[0]).toEqual(['id', KONTOR_ID])
    expect(findCall('suppliers', 'insert')).toBeUndefined()
  })

  // Through the real parser and the wizard's own rowsForExecute, so these
  // send what the wizard sends for the file. The type picks the reverse
  // charge the supplier's invoices book (an EU supplier's EU services or
  // goods, ruta 21 or 20), so a guessed type must never replace its own.
  describe('an update keeps what the file does not state', () => {
    const euSupplier = {
      id: 'old',
      name: 'Exempel GmbH',
      supplier_type: 'eu_business',
      org_number: null,
      email: 'info@exempel.example',
      phone: null,
      country: 'DE',
      vat_number: 'DE123456789',
      default_currency: 'EUR',
    }
    const swedishSupplier = {
      ...euSupplier,
      name: 'Exempel AB',
      supplier_type: 'swedish_business',
      country: 'SE',
      vat_number: null,
      default_currency: 'SEK',
    }

    async function importFile(csv: string) {
      const parsed = await parseSuppliersFile(new TextEncoder().encode(csv).buffer as ArrayBuffer, 'leverantorer.csv')
      return post({ rows: rowsForExecute(parsed.rows), update_duplicates: true })
    }

    const merged = () => findCall('suppliers', 'update')![0] as Record<string, unknown>

    it('keeps the type, country and currency of a supplier when the file has no such columns', async () => {
      mockFetchAllRows.mockResolvedValue([euSupplier])
      enqueue({ data: euSupplier })

      const res = await importFile('Namn,E-post,Telefon\nExempel GmbH,info@exempel.example,+49 30 123456\n')
      const { status, body } = await parseJsonResponse<ExecuteBody>(res)

      expect(status).toBe(200)
      expect(body.data.updated).toBe(1)
      expect(merged().phone).toBe('+49 30 123456')
      expect(merged()).not.toHaveProperty('supplier_type')
      expect(merged()).not.toHaveProperty('country')
      expect(merged()).not.toHaveProperty('default_currency')
    })

    it('keeps them when the columns are there but the row leaves them empty', async () => {
      mockFetchAllRows.mockResolvedValue([euSupplier])
      enqueue({ data: euSupplier })

      const res = await importFile('Namn,E-post,Typ,Land,Valuta,Telefon\nExempel GmbH,info@exempel.example,,,,+49 30 123456\n')
      const { status } = await parseJsonResponse(res)

      expect(status).toBe(200)
      expect(merged().phone).toBe('+49 30 123456')
      expect(merged()).not.toHaveProperty('supplier_type')
      expect(merged()).not.toHaveProperty('country')
      expect(merged()).not.toHaveProperty('default_currency')
    })

    it('keeps the currency when the file names one the register does not know', async () => {
      mockFetchAllRows.mockResolvedValue([euSupplier])
      enqueue({ data: euSupplier })

      const res = await importFile('Namn,E-post,Valuta\nExempel GmbH,info@exempel.example,XYZ\n')
      const { status } = await parseJsonResponse(res)

      expect(status).toBe(200)
      expect(merged()).not.toHaveProperty('default_currency')
    })

    it('writes the type, country and currency the file states', async () => {
      mockFetchAllRows.mockResolvedValue([swedishSupplier])
      enqueue({ data: swedishSupplier })

      const res = await importFile('Namn,E-post,Typ,Land,Valuta,VAT-nummer\nExempel AB,info@exempel.example,EU,DE,EUR,DE123456789\n')
      const { status } = await parseJsonResponse(res)

      expect(status).toBe(200)
      expect(merged()).toMatchObject({
        supplier_type: 'eu_business',
        country: 'DE',
        default_currency: 'EUR',
        vat_number: 'DE123456789',
      })
    })

    // Företag is Fortnox's own Typ value: every supplier is a company.
    it('keeps a supplier\'s kind when the file says only that it is a company', async () => {
      mockFetchAllRows.mockResolvedValue([euSupplier])
      enqueue({ data: euSupplier })

      const res = await importFile('Namn,E-post,Typ\nExempel GmbH,info@exempel.example,Företag\n')
      const { status, body } = await parseJsonResponse<ExecuteBody>(res)

      expect(status).toBe(200)
      expect(body.data.updated).toBe(1)
      expect(merged()).not.toHaveProperty('supplier_type')
      expect(merged()).not.toHaveProperty('country')
    })

    it('never rewrites the type or the country from a VAT number alone', async () => {
      mockFetchAllRows.mockResolvedValue([swedishSupplier])
      enqueue({ data: swedishSupplier })

      const res = await importFile('Namn,E-post,VAT-nummer\nExempel AB,info@exempel.example,DE811234567\n')
      const { status } = await parseJsonResponse(res)

      expect(status).toBe(200)
      expect(merged().vat_number).toBe('DE811234567')
      expect(merged()).not.toHaveProperty('supplier_type')
      expect(merged()).not.toHaveProperty('country')
    })

    // A Swedish business is in Sweden and an EU business is not
    // (checkCountryConsistency): a stated half the supplier's own other half
    // cannot have takes the row's own reading of it, as on the customer import.
    it('takes the type the file reads from a stated country the supplier\'s own type cannot have', async () => {
      mockFetchAllRows.mockResolvedValue([swedishSupplier])
      enqueue({ data: swedishSupplier })

      const res = await importFile('Namn,E-post,Land\nExempel AB,info@exempel.example,DE\n')
      const { status } = await parseJsonResponse(res)

      expect(status).toBe(200)
      expect(merged()).toMatchObject({ supplier_type: 'eu_business', country: 'DE' })
    })

    it('makes an EU supplier the file places in Sweden a Swedish business', async () => {
      mockFetchAllRows.mockResolvedValue([euSupplier])
      enqueue({ data: euSupplier })

      const res = await importFile('Namn,E-post,Land\nExempel GmbH,info@exempel.example,Sverige\n')
      const { status } = await parseJsonResponse(res)

      expect(status).toBe(200)
      expect(merged()).toMatchObject({ supplier_type: 'swedish_business', country: 'SE' })
    })

    it('takes the country the file reads for a type it names in place of the supplier\'s', async () => {
      mockFetchAllRows.mockResolvedValue([euSupplier])
      enqueue({ data: euSupplier })

      const res = await importFile('Namn,E-post,Typ\nExempel GmbH,info@exempel.example,Svensk\n')
      const { status } = await parseJsonResponse(res)

      expect(status).toBe(200)
      expect(merged()).toMatchObject({ supplier_type: 'swedish_business', country: 'SE' })
    })

    // The customer form refuses such a pair, so the customer import refuses
    // the row; the supplier register takes it.
    it('writes a type and country that disagree as the file states them, and refuses nothing', async () => {
      mockFetchAllRows.mockResolvedValue([euSupplier])
      enqueue({ data: euSupplier })

      const res = await importFile('Namn,E-post,Typ,Land\nExempel GmbH,info@exempel.example,Svensk,DE\n')
      const { status, body } = await parseJsonResponse<ExecuteBody>(res)

      expect(status).toBe(200)
      expect(body.data.failed).toBe(0)
      expect(merged()).toMatchObject({ supplier_type: 'swedish_business', country: 'DE' })
    })

    it('writes the type the user picks in the review step', async () => {
      mockFetchAllRows.mockResolvedValue([swedishSupplier])
      enqueue({ data: swedishSupplier })
      const parsed = await parseSuppliersFile(
        new TextEncoder().encode('Namn,E-post\nExempel AB,info@exempel.example\n').buffer as ArrayBuffer,
        'leverantorer.csv',
      )
      // What the review step's type select sets on the row.
      const picked = parsed.rows.map((r) => ({ ...r, supplier_type: 'eu_business', supplier_type_stated: 'type' }))

      const { status } = await parseJsonResponse(await post({ rows: rowsForExecute(picked), update_duplicates: true }))

      expect(status).toBe(200)
      expect(merged().supplier_type).toBe('eu_business')
      expect(merged()).not.toHaveProperty('country')
    })

    // A wizard opened before the import said what a row states.
    it('keeps them for a row that does not say what it states', async () => {
      mockFetchAllRows.mockResolvedValue([euSupplier])
      enqueue({ data: euSupplier })

      const { status } = await parseJsonResponse(
        await post({ rows: [row({ name: 'Exempel GmbH', email: 'info@exempel.example', phone: '+49 30 123456' })], update_duplicates: true }),
      )

      expect(status).toBe(200)
      expect(merged().phone).toBe('+49 30 123456')
      expect(merged()).not.toHaveProperty('supplier_type')
      expect(merged()).not.toHaveProperty('country')
      expect(merged()).not.toHaveProperty('default_currency')
    })

    it('still gives a new supplier the file says nothing about a Swedish business, SE and SEK', async () => {
      enqueue({ data: { id: 's1', name: 'Ny Leverantör AB' } })

      const res = await importFile('Namn,E-post\nNy Leverantör AB,ny@leverantor.example\n')
      const { status, body } = await parseJsonResponse<ExecuteBody>(res)

      expect(status).toBe(200)
      expect(body.data.created).toBe(1)
      expect(findCall('suppliers', 'insert')![0]).toMatchObject({
        supplier_type: 'swedish_business',
        country: 'SE',
        default_currency: 'SEK',
      })
    })
  })
})
