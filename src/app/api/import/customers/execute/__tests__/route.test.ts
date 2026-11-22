import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createQueuedMockSupabase,
} from '@/tests/helpers'
import { decryptPersonnummer, encryptPersonnummer } from '@/lib/salary/personnummer'

const { supabase: mockSupabase, enqueue, reset, calls, findCall, findCalls } = createQueuedMockSupabase()

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

import { POST } from '../route'

const mockUser = { id: 'user-1', email: 'test@test.se' }
const ROUTE_CTX = { params: Promise.resolve({}) }

// Synthetic personnummer, never a real one.
const PERSONAL_NUMBER = '19900101-1234'
const CIPHERTEXT_SHAPE = /^[0-9a-f]{76,255}$/

function row(overrides: Record<string, unknown> = {}) {
  return {
    row_index: 2,
    name: 'Bertil Bengtsson',
    customer_type: 'individual',
    org_number: PERSONAL_NUMBER,
    email: null,
    phone: null,
    address_line1: null,
    address_line2: null,
    postal_code: null,
    city: null,
    country: 'SE',
    vat_number: null,
    default_payment_terms: 30,
    notes: null,
    ...overrides,
  }
}

function makeRequest(body: unknown) {
  return createMockRequest('/api/import/customers/execute', { method: 'POST', body })
}

type CustomerWrite = { org_number?: string | null; personal_number?: string | null }

describe('POST /api/import/customers/execute', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
    // mockReset, not only clearAllMocks: a read queued with mockResolvedValueOnce
    // that a failing test left unused must not answer the next test's reads.
    mockFetchAllRows.mockReset()
    mockFetchAllRows.mockResolvedValue([])
  })

  it('returns 401 for unauthenticated requests', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const res = await POST(makeRequest({ rows: [row()], update_duplicates: false }), ROUTE_CTX)
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(401)
  })

  it('returns 400 for an individual whose org number is not a personnummer', async () => {
    const res = await POST(makeRequest({ rows: [row({ org_number: '556677-8899' })], update_duplicates: false }), ROUTE_CTX)
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(400)
    expect(findCall('customers', 'insert')).toBeUndefined()
  })

  it('stores an imported individual\'s personnummer encrypted, with no org number', async () => {
    enqueue({
      data: {
        id: 'c1',
        name: 'Bertil Bengtsson',
        customer_type: 'individual',
        org_number: null,
        email: null,
        personal_number: encryptPersonnummer(PERSONAL_NUMBER),
      },
    })

    const res = await POST(makeRequest({ rows: [row()], update_duplicates: false }), ROUTE_CTX)
    const { status, body } = await parseJsonResponse<{ data: { created: number } }>(res)

    expect(status).toBe(200)
    expect(body.data.created).toBe(1)
    const inserted = findCall('customers', 'insert')![0] as CustomerWrite
    expect(inserted.org_number).toBeNull()
    expect(inserted.personal_number).toMatch(CIPHERTEXT_SHAPE)
    expect(decryptPersonnummer(inserted.personal_number!)).toBe(PERSONAL_NUMBER)
    expect(JSON.stringify(inserted)).not.toContain(PERSONAL_NUMBER)
    // The event carries the masked form, never the ciphertext.
    const payload = mockEmit.mock.calls[0][0] as { payload: { customer: CustomerWrite } }
    expect(payload.payload.customer.personal_number).toBe('********-1234')
  })

  it('keeps a business org number where it is', async () => {
    enqueue({ data: { id: 'c1', name: 'Acme AB', org_number: '5566778899', email: null } })

    const res = await POST(makeRequest({
      rows: [row({ name: 'Acme AB', customer_type: 'swedish_business', org_number: '5566778899' })],
      update_duplicates: false,
    }), ROUTE_CTX)
    const { status } = await parseJsonResponse(res)

    expect(status).toBe(200)
    const inserted = findCall('customers', 'insert')![0] as CustomerWrite
    expect(inserted.org_number).toBe('5566778899')
    expect(inserted.personal_number).toBeNull()
  })

  it('never matches an individual on its personnummer', async () => {
    // A legacy row that still holds the same personnummer in org_number.
    mockFetchAllRows.mockResolvedValue([
      { id: 'old', name: 'Bertil', customer_type: 'individual', org_number: PERSONAL_NUMBER, email: null, personal_number: null },
    ])
    enqueue({ data: { id: 'c1', name: 'Bertil Bengtsson', customer_type: 'individual', org_number: null, email: null } })

    const res = await POST(makeRequest({ rows: [row()], update_duplicates: true }), ROUTE_CTX)
    const { status, body } = await parseJsonResponse<{ data: { created: number; updated: number } }>(res)

    expect(status).toBe(200)
    expect(body.data.created).toBe(1)
    expect(body.data.updated).toBe(0)
    expect(findCall('customers', 'update')).toBeUndefined()
    const inserted = findCall('customers', 'insert')![0] as CustomerWrite
    expect(inserted.org_number).toBeNull()
  })

  it('matches an individual on its customer number or e-mail', async () => {
    mockFetchAllRows.mockResolvedValue([
      { id: 'legacy', name: 'Bertil', customer_type: 'individual', org_number: PERSONAL_NUMBER, email: null, personal_number: null },
      {
        id: 'by-email',
        name: 'Bertil B',
        customer_type: 'individual',
        org_number: null,
        email: 'bertil@example.test',
        personal_number: encryptPersonnummer(PERSONAL_NUMBER),
      },
      { id: 'by-number', name: 'David B', customer_type: 'individual', customer_number: '2001', org_number: null, email: null, personal_number: null },
    ])
    enqueue({ data: { id: 'by-email', name: 'Bertil Bengtsson', customer_type: 'individual', org_number: null, email: 'bertil@example.test' } })
    enqueue({ data: { id: 'by-number', name: 'David Bengtsson', customer_type: 'individual', customer_number: '2001', org_number: null } })

    const res = await POST(makeRequest({
      rows: [
        row({ email: 'bertil@example.test' }),
        row({ row_index: 3, name: 'David Bengtsson', customer_number: '2001', org_number: '19800303-3333' }),
      ],
      update_duplicates: true,
    }), ROUTE_CTX)
    const { status, body } = await parseJsonResponse<{ data: { created: number; updated: number } }>(res)

    expect(status).toBe(200)
    expect(body.data.created).toBe(0)
    expect(body.data.updated).toBe(2)
    expect(findCall('customers', 'insert')).toBeUndefined()
    const ids = findCalls('customers', 'eq').filter((args) => args[0] === 'id').map((args) => args[1])
    expect(ids).toEqual(['by-email', 'by-number'])
  })

  it('merging into a legacy row moves its personnummer out of org_number', async () => {
    mockFetchAllRows.mockResolvedValue([
      {
        id: 'old',
        name: 'Bertil',
        customer_type: 'individual',
        org_number: PERSONAL_NUMBER,
        email: 'bertil@example.test',
        personal_number: null,
      },
    ])
    enqueue({ data: { id: 'old', name: 'Bertil Bengtsson', org_number: null } })

    const res = await POST(makeRequest({
      rows: [row({ org_number: null, email: 'bertil@example.test' })],
      update_duplicates: true,
    }), ROUTE_CTX)
    const { status, body } = await parseJsonResponse<{ data: { updated: number } }>(res)

    expect(status).toBe(200)
    expect(body.data.updated).toBe(1)
    const updated = findCall('customers', 'update')![0] as CustomerWrite
    expect(updated.org_number).toBeNull()
    expect(decryptPersonnummer(updated.personal_number!)).toBe(PERSONAL_NUMBER)
  })

  it('keeps a personnummer it moved out of org_number out of the undo record', async () => {
    const legacy = {
      id: 'old',
      name: 'Bertil',
      customer_type: 'individual',
      org_number: PERSONAL_NUMBER,
      email: 'bertil@example.test',
      phone: null,
      personal_number: null,
    }
    mockFetchAllRows.mockResolvedValue([legacy])
    enqueue({
      data: {
        ...legacy,
        name: 'Bertil Bengtsson',
        phone: '070-1234567',
        org_number: null,
        personal_number: encryptPersonnummer(PERSONAL_NUMBER),
      },
    })

    const res = await POST(makeRequest({
      rows: [row({ org_number: null, email: 'bertil@example.test', phone: '070-1234567' })],
      update_duplicates: true,
    }), ROUTE_CTX)
    const { status } = await parseJsonResponse(res)

    expect(status).toBe(200)
    const run = findCall('register_import_runs', 'insert')![0] as {
      updated_rows: { id: string; before: Record<string, unknown>; after: Record<string, unknown> }[]
    }
    // The undo puts the other fields back and leaves the personnummer
    // encrypted in personal_number; the record never holds it in plaintext.
    expect(run.updated_rows).toEqual([
      {
        id: 'old',
        before: { name: 'Bertil', phone: null },
        after: { name: 'Bertil Bengtsson', phone: '070-1234567' },
      },
    ])
    expect(JSON.stringify(run)).not.toContain('19900101')
  })

  it('never merges an individual into a business with an org number through a shared e-mail', async () => {
    mockFetchAllRows.mockResolvedValue([
      {
        id: 'firm',
        name: 'Bengtsson Bygg AB',
        customer_type: 'swedish_business',
        org_number: '5566778899',
        email: 'bertil@example.test',
        personal_number: null,
      },
    ])
    enqueue({ data: { id: 'c1', name: 'Bertil Bengtsson', customer_type: 'individual', org_number: null } })

    const res = await POST(makeRequest({
      rows: [row({ email: 'bertil@example.test' })],
      update_duplicates: true,
    }), ROUTE_CTX)
    const { status, body } = await parseJsonResponse<{ data: { created: number; updated: number } }>(res)

    expect(status).toBe(200)
    // The business keeps its org number and type; the person is a new customer.
    expect(body.data.created).toBe(1)
    expect(body.data.updated).toBe(0)
    expect(findCall('customers', 'update')).toBeUndefined()
    const inserted = findCall('customers', 'insert')![0] as CustomerWrite
    expect(inserted.org_number).toBeNull()
    expect(decryptPersonnummer(inserted.personal_number!)).toBe(PERSONAL_NUMBER)
  })

  describe('open drafts follow the customer (#3481)', () => {
    const existingCard = {
      id: 'old',
      name: 'Acme GmbH',
      customer_type: 'eu_business',
      customer_number: '1001',
      org_number: null,
      email: 'acme@example.test',
      phone: null,
      country: 'DE',
      vat_number: 'DE123456789',
      personal_number: null,
    }
    const madeSwedish = { ...existingCard, name: 'Acme AB', customer_type: 'swedish_business', country: 'SE', org_number: '5566778899' }
    const importMadeSwedish = () => makeRequest({
      rows: [row({
        name: 'Acme AB',
        customer_type: 'swedish_business',
        org_number: '5566778899',
        email: 'acme@example.test',
        country: 'SE',
      })],
      update_duplicates: true,
    })
    // syncDraftVatHeadersForCustomer: the customer as it is now, its drafts,
    // the seller's VAT registration, the write.
    const enqueueDraftSync = () => {
      enqueue({ data: { id: 'old', customer_type: 'swedish_business', vat_number: 'DE123456789', vat_number_validated: true, country: 'SE' } })
      enqueue({
        data: [{
          id: 'draft-1',
          vat_treatment: 'reverse_charge',
          moms_ruta: '39',
          reverse_charge_text: 'Omvänd skattskyldighet',
          vat_treatment_override: null,
          delivery_country: null,
          items: [{ vat_rate: 0, line_type: 'service' }],
        }],
      })
      enqueue({ data: { vat_registered: true } })
      enqueue({ data: null })
    }
    const callIndex = (table: string, method: string) =>
      calls.findIndex((c) => c.table === table && c.method === method)

    afterEach(() => {
      vi.useRealTimers()
    })

    // An import that makes a reverse-charge customer Swedish must not leave
    // its open draft on reverse charge, ruta 39 and the reverse-charge notice.
    it('re-derives the VAT header of open drafts when the import changes the customer type', async () => {
      mockFetchAllRows
        .mockResolvedValueOnce([existingCard]) // the undo snapshot
        .mockResolvedValueOnce([existingCard]) // the register to match against
        .mockResolvedValueOnce([{ customer_id: 'old' }]) // which changed customers have a draft
      enqueue({ data: madeSwedish })
      enqueueDraftSync()
      enqueue({ data: { id: 'run-1' } })

      const res = await POST(importMadeSwedish(), ROUTE_CTX)
      const { status, body } = await parseJsonResponse<{ data: { updated: number } }>(res)

      expect(status).toBe(200)
      expect(body.data.updated).toBe(1)
      expect(findCall('invoices', 'update')![0]).toEqual({
        vat_treatment: 'standard_25',
        moms_ruta: '05',
        reverse_charge_text: null,
      })
      // Before the run is recorded: the undo reads a draft written after the
      // run as the customer used since the import, and would keep it.
      expect(callIndex('invoices', 'update')).toBeGreaterThan(-1)
      expect(callIndex('invoices', 'update')).toBeLessThan(callIndex('register_import_runs', 'insert'))
    })

    it('syncs no customer whose drafts lookup finds none', async () => {
      mockFetchAllRows
        .mockResolvedValueOnce([existingCard])
        .mockResolvedValueOnce([existingCard])
        .mockResolvedValueOnce([])
      enqueue({ data: madeSwedish })
      enqueue({ data: { id: 'run-1' } })

      const res = await POST(importMadeSwedish(), ROUTE_CTX)
      const { status } = await parseJsonResponse(res)

      expect(status).toBe(200)
      expect(mockFetchAllRows).toHaveBeenCalledTimes(3)
      // The merge's own write is the only customers call that selects: no
      // card is read for a sync, and no draft.
      expect(findCalls('customers', 'select')).toEqual([[]])
      expect(findCall('invoices', 'select')).toBeUndefined()
      expect(findCall('invoices', 'update')).toBeUndefined()
      expect(findCall('register_import_runs', 'insert')).toBeDefined()
    })

    // A slow sync must never cost the import its undo.
    it('records the run first when the import has run past the sync deadline, then syncs the drafts', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-11-22T10:00:00Z'))
      mockFetchAllRows
        .mockResolvedValueOnce([existingCard])
        .mockImplementationOnce(async () => {
          // Reading and writing the register took four minutes.
          vi.setSystemTime(new Date('2026-11-22T10:04:01Z'))
          return [existingCard]
        })
        .mockResolvedValueOnce([{ customer_id: 'old' }])
      enqueue({ data: madeSwedish })
      enqueue({ data: { id: 'run-1' } })
      enqueueDraftSync()

      const res = await POST(importMadeSwedish(), ROUTE_CTX)
      const { status, body } = await parseJsonResponse<{ data: { updated: number } }>(res)

      expect(status).toBe(200)
      expect(body.data.updated).toBe(1)
      expect(callIndex('register_import_runs', 'insert')).toBeGreaterThan(-1)
      expect(callIndex('register_import_runs', 'insert')).toBeLessThan(callIndex('invoices', 'select'))
      // The draft still follows the customer.
      expect(findCall('invoices', 'update')![0]).toEqual({
        vat_treatment: 'standard_25',
        moms_ruta: '05',
        reverse_charge_text: null,
      })
    })

    // A 504 would make the wizard send the batch again, and that attempt
    // changes nothing and so syncs nothing: better to answer.
    it('starts no sync at all past the last deadline, and still records the run and answers', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-11-22T10:00:00Z'))
      mockFetchAllRows
        .mockResolvedValueOnce([existingCard])
        .mockImplementationOnce(async () => {
          vi.setSystemTime(new Date('2026-11-22T10:04:51Z'))
          return [existingCard]
        })
      enqueue({ data: madeSwedish })
      enqueue({ data: { id: 'run-1' } })

      const res = await POST(importMadeSwedish(), ROUTE_CTX)
      const { status, body } = await parseJsonResponse<{ data: { updated: number } }>(res)

      expect(status).toBe(200)
      expect(body.data.updated).toBe(1)
      expect(findCall('register_import_runs', 'insert')).toBeDefined()
      // No lookup and no draft read: the snapshot and the register only.
      expect(mockFetchAllRows).toHaveBeenCalledTimes(2)
      expect(findCall('invoices', 'select')).toBeUndefined()
    })
  })

  it('reads no drafts when the import changes no field the VAT header is derived from', async () => {
    const existingCard = {
      id: 'old',
      name: 'Acme AB',
      customer_type: 'swedish_business',
      org_number: '5566778899',
      email: 'acme@example.test',
      phone: null,
      country: 'SE',
      vat_number: null,
      personal_number: null,
    }
    mockFetchAllRows.mockResolvedValue([existingCard])
    enqueue({ data: { ...existingCard, phone: '08-123456' } })
    enqueue({ data: { id: 'run-1' } })

    const res = await POST(makeRequest({
      rows: [row({
        name: 'Acme AB',
        customer_type: 'swedish_business',
        org_number: '5566778899',
        email: 'acme@example.test',
        phone: '08-123456',
      })],
      update_duplicates: true,
    }), ROUTE_CTX)
    const { status } = await parseJsonResponse(res)

    expect(status).toBe(200)
    // The snapshot and the register: no drafts lookup either.
    expect(mockFetchAllRows).toHaveBeenCalledTimes(2)
    expect(findCall('invoices', 'select')).toBeUndefined()
    expect(findCall('register_import_runs', 'insert')).toBeDefined()
  })
})
