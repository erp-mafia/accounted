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
import { parseCustomersFile } from '@/lib/import/customers/parser'
import { rowsForExecute } from '@/lib/import/register-import-flow'

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
    // A file that states the type and the country.
    const importMadeSwedish = () => makeRequest({
      rows: [row({
        name: 'Acme AB',
        customer_type: 'swedish_business',
        customer_type_stated: 'type',
        org_number: '5566778899',
        email: 'acme@example.test',
        country: 'SE',
        country_stated: true,
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
      expect(findCall('customers', 'update')![0]).toMatchObject({ customer_type: 'swedish_business', country: 'SE' })
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

  // Through the real parser and the wizard's own rowsForExecute, so these
  // send what the wizard sends for the file.
  describe('an update keeps what the file does not state', () => {
    const euCard = {
      id: 'old',
      name: 'Acme GmbH',
      customer_type: 'eu_business',
      customer_number: null,
      org_number: null,
      email: 'acme@example.test',
      phone: null,
      country: 'DE',
      vat_number: 'DE123456789',
      vat_number_validated: true,
      personal_number: null,
    }

    async function importFile(csv: string) {
      const parsed = await parseCustomersFile(new TextEncoder().encode(csv).buffer as ArrayBuffer, 'kunder.csv')
      return POST(makeRequest({ rows: rowsForExecute(parsed.rows), update_duplicates: true }), ROUTE_CTX)
    }

    /** The database's answer to the merge: the card as the update left it. */
    function cardAfterUpdate(card: Record<string, unknown>) {
      const now = (): Record<string, unknown> => ({
        ...card,
        ...(findCall('customers', 'update')?.[0] as Record<string, unknown> | undefined),
      })
      return new Proxy({}, {
        get: (_target, key) => now()[key as string],
        has: (_target, key) => key in now(),
        ownKeys: () => Reflect.ownKeys(now()),
        getOwnPropertyDescriptor: (_target, key) => ({
          value: now()[key as string], enumerable: true, configurable: true, writable: true,
        }),
      })
    }

    const merged = () => findCall('customers', 'update')![0] as Record<string, unknown>

    beforeEach(() => {
      // No file here has a terms column: the route first reads the company's
      // default terms.
      enqueue({ data: { invoice_default_days: 30 } })
    })

    it('keeps the type and country of a customer when the file has no type or country column', async () => {
      mockFetchAllRows.mockResolvedValueOnce([euCard]).mockResolvedValueOnce([euCard])
      enqueue({ data: cardAfterUpdate(euCard) })

      const res = await importFile('Namn,E-post,Telefon\nAcme GmbH,acme@example.test,+49 30 123456\n')
      const { status, body } = await parseJsonResponse<{ data: { updated: number } }>(res)

      expect(status).toBe(200)
      expect(body.data.updated).toBe(1)
      expect(merged().phone).toBe('+49 30 123456')
      expect(merged()).not.toHaveProperty('customer_type')
      expect(merged()).not.toHaveProperty('country')
    })

    it('keeps them when the columns are there but the row leaves them empty', async () => {
      mockFetchAllRows.mockResolvedValueOnce([euCard]).mockResolvedValueOnce([euCard])
      enqueue({ data: cardAfterUpdate(euCard) })

      const res = await importFile('Namn,E-post,Kundtyp,Land,Telefon\nAcme GmbH,acme@example.test,,,+49 30 123456\n')
      const { status } = await parseJsonResponse(res)

      expect(status).toBe(200)
      expect(merged().phone).toBe('+49 30 123456')
      expect(merged()).not.toHaveProperty('customer_type')
      expect(merged()).not.toHaveProperty('country')
    })

    it('writes the type and country the file states', async () => {
      const swedishCard = { ...euCard, customer_type: 'swedish_business', country: 'SE', vat_number: null, vat_number_validated: false }
      mockFetchAllRows.mockResolvedValueOnce([swedishCard]).mockResolvedValueOnce([swedishCard])
      enqueue({ data: cardAfterUpdate(swedishCard) })

      const res = await importFile('Namn,E-post,Kundtyp,Land,VAT-nummer\nAcme GmbH,acme@example.test,EU,DE,DE123456789\n')
      const { status } = await parseJsonResponse(res)

      expect(status).toBe(200)
      expect(merged()).toMatchObject({ customer_type: 'eu_business', country: 'DE', vat_number: 'DE123456789' })
    })

    it('keeps them on a customer from before the country rule, which already breaks it', async () => {
      const legacy = { ...euCard, country: 'SE', vat_number: null, vat_number_validated: false }
      mockFetchAllRows.mockResolvedValueOnce([legacy]).mockResolvedValueOnce([legacy])
      enqueue({ data: cardAfterUpdate(legacy) })

      const res = await importFile('Namn,E-post,Telefon\nAcme GmbH,acme@example.test,+49 30 123456\n')
      const { status } = await parseJsonResponse(res)

      expect(status).toBe(200)
      expect(merged().phone).toBe('+49 30 123456')
      expect(merged()).not.toHaveProperty('customer_type')
      expect(merged()).not.toHaveProperty('country')
    })

    it('keeps the country of a private person abroad when the file states only the type', async () => {
      const abroad = { ...euCard, name: 'Anna Svensson', customer_type: 'individual', email: 'anna@example.test', vat_number: null, vat_number_validated: false }
      mockFetchAllRows.mockResolvedValueOnce([abroad]).mockResolvedValueOnce([abroad])
      enqueue({ data: cardAfterUpdate(abroad) })

      const res = await importFile('Namn,E-post,Kundtyp\nAnna Svensson,anna@example.test,Privat\n')
      const { status } = await parseJsonResponse(res)

      expect(status).toBe(200)
      expect(merged().customer_type).toBe('individual')
      expect(merged()).not.toHaveProperty('country')
    })

    // The customer form refuses a Swedish business outside Sweden (#2025).
    it('takes the type the file reads when the customer\'s own cannot have the country the file states', async () => {
      const swedishCard = { ...euCard, customer_type: 'swedish_business', country: 'SE', vat_number: null, vat_number_validated: false }
      mockFetchAllRows.mockResolvedValueOnce([swedishCard]).mockResolvedValueOnce([swedishCard])
      enqueue({ data: cardAfterUpdate(swedishCard) })

      const res = await importFile('Namn,E-post,Land\nAcme GmbH,acme@example.test,DE\n')
      const { status } = await parseJsonResponse(res)

      expect(status).toBe(200)
      expect(merged()).toMatchObject({ customer_type: 'eu_business', country: 'DE' })
    })

    // Read without a type, a personnummer-shaped number is a private
    // person's, and the schema moves it to personal_number.
    it('keeps a business a business when the file gives it a personnummer-shaped org number but no type', async () => {
      const soleTrader = { ...euCard, name: 'Ekfirman', customer_type: 'swedish_business', country: 'SE', email: 'ek@firman.example', vat_number: null, vat_number_validated: false }
      mockFetchAllRows.mockResolvedValueOnce([soleTrader]).mockResolvedValueOnce([soleTrader])
      enqueue({ data: cardAfterUpdate(soleTrader) })

      const res = await importFile('Namn,E-post,Orgnr\nEkfirman,ek@firman.example,800101-1234\n')
      const { status } = await parseJsonResponse(res)

      expect(status).toBe(200)
      expect(merged()).not.toHaveProperty('customer_type')
      expect(merged()).not.toHaveProperty('personal_number')
      expect(merged().org_number).toBe('800101-1234')
    })

    // Företag is Fortnox's own Typ value; Spiris writes IsPrivatePerson False.
    it.each([
      ['a no in a private-person column', 'Namn,E-post,Privatperson\nAcme GmbH,acme@example.test,Nej\n'],
      ['a word for any company', 'Namn,E-post,Kundtyp\nAcme GmbH,acme@example.test,Företag\n'],
    ])('keeps a company\'s kind when the file says only that it is a company (%s)', async (_label, csv) => {
      mockFetchAllRows.mockResolvedValueOnce([euCard]).mockResolvedValueOnce([euCard])
      enqueue({ data: cardAfterUpdate(euCard) })

      const res = await importFile(csv)
      const { status } = await parseJsonResponse(res)

      expect(status).toBe(200)
      expect(merged()).not.toHaveProperty('customer_type')
      expect(merged()).not.toHaveProperty('country')
      // No VAT field changed: no drafts lookup.
      expect(mockFetchAllRows).toHaveBeenCalledTimes(2)
    })

    it('keeps a company\'s kind for Typ Företag next to the customer\'s own VAT number', async () => {
      mockFetchAllRows.mockResolvedValueOnce([euCard]).mockResolvedValueOnce([euCard])
      enqueue({ data: cardAfterUpdate(euCard) })

      const res = await importFile('Namn,E-post,Typ,VAT-nummer\nAcme GmbH,acme@example.test,Företag,DE123456789\n')
      const { status, body } = await parseJsonResponse<{ data: { updated: number } }>(res)

      expect(status).toBe(200)
      expect(body.data.updated).toBe(1)
      expect(merged()).not.toHaveProperty('customer_type')
      expect(merged()).not.toHaveProperty('country')
      expect(mockFetchAllRows).toHaveBeenCalledTimes(2)
    })

    it('refuses a VAT number that does not fit the country the customer keeps, also next to its own type', async () => {
      const austrian = { ...euCard, country: 'AT', vat_number: 'ATU12345678' }
      mockFetchAllRows.mockResolvedValueOnce([austrian]).mockResolvedValueOnce([austrian])

      const res = await importFile('Namn,E-post,Kundtyp,VAT-nummer\nAcme GmbH,acme@example.test,EU,DE811234567\n')
      const { status, body } = await parseJsonResponse<{ data: { failed: number; errors: { reason: string }[] } }>(res)

      expect(status).toBe(200)
      expect(body.data.failed).toBe(1)
      expect(body.data.errors[0].reason).toMatch(/landsprefix/)
      expect(findCall('customers', 'update')).toBeUndefined()
    })

    it('refuses a VAT number that does not fit the country the customer keeps', async () => {
      mockFetchAllRows.mockResolvedValueOnce([euCard]).mockResolvedValueOnce([euCard])

      const res = await importFile('Namn,E-post,VAT-nummer\nAcme GmbH,acme@example.test,SE556677889901\n')
      const { status, body } = await parseJsonResponse<{ data: { failed: number; errors: { reason: string }[] } }>(res)

      expect(status).toBe(200)
      expect(body.data.failed).toBe(1)
      expect(body.data.errors[0].reason).toMatch(/landsprefix/)
      expect(findCall('customers', 'update')).toBeUndefined()
    })

    it('refuses a bare "not a private person" on a private person abroad, whose kind it does not say', async () => {
      const abroad = { ...euCard, name: 'Anna Svensson', customer_type: 'individual', email: 'anna@example.test', vat_number: null, vat_number_validated: false }
      mockFetchAllRows.mockResolvedValueOnce([abroad]).mockResolvedValueOnce([abroad])

      const res = await importFile('Namn,E-post,Privatperson\nAnna Svensson,anna@example.test,Nej\n')
      const { status, body } = await parseJsonResponse<{ data: { failed: number; errors: { reason: string }[] } }>(res)

      expect(status).toBe(200)
      expect(body.data.failed).toBe(1)
      expect(body.data.errors[0].reason).toMatch(/svenskt företag måste ha landet Sverige/)
      expect(findCall('customers', 'update')).toBeUndefined()
    })

    it('judges a stored personnummer-shaped org number only against a type the update changes', async () => {
      const legacy = { ...euCard, org_number: '800101-1234' }
      mockFetchAllRows.mockResolvedValueOnce([legacy]).mockResolvedValueOnce([legacy])
      enqueue({ data: cardAfterUpdate(legacy) })

      const res = await importFile('Namn,E-post,Kundtyp,Land,Telefon\nAcme GmbH,acme@example.test,EU,DE,+49 30 123456\n')
      const { status, body } = await parseJsonResponse<{ data: { updated: number; failed: number } }>(res)

      expect(status).toBe(200)
      expect(body.data.failed).toBe(0)
      expect(merged().phone).toBe('+49 30 123456')
    })

    it('makes a private person a company when the file says it is one', async () => {
      const person = { ...euCard, name: 'Ekfirman', customer_type: 'individual', country: 'SE', email: 'ek@firman.example', vat_number: null, vat_number_validated: false }
      mockFetchAllRows.mockResolvedValueOnce([person]).mockResolvedValueOnce([person])
      enqueue({ data: cardAfterUpdate(person) })

      const res = await importFile('Namn,E-post,Privatperson\nEkfirman,ek@firman.example,Nej\n')
      const { status } = await parseJsonResponse(res)

      expect(status).toBe(200)
      expect(merged().customer_type).toBe('swedish_business')
      expect(merged()).not.toHaveProperty('country')
    })

    it('refuses a personnummer-shaped org number on a foreign business the file does not type', async () => {
      mockFetchAllRows.mockResolvedValueOnce([euCard]).mockResolvedValueOnce([euCard])

      const res = await importFile('Namn,E-post,Orgnr\nAcme GmbH,acme@example.test,800101-1234\n')
      const { status, body } = await parseJsonResponse<{ data: { updated: number; failed: number; errors: { reason: string }[] } }>(res)

      expect(status).toBe(200)
      expect(body.data.updated).toBe(0)
      expect(body.data.failed).toBe(1)
      expect(body.data.errors[0].reason).toMatch(/personnummer, vilket ett utländskt företag inte kan ha/)
      expect(findCall('customers', 'update')).toBeUndefined()
    })

    it('refuses a row that leaves the country next to a VAT number of another country', async () => {
      const french = { ...euCard, name: 'Acme SARL', country: 'FR', vat_number: 'FR12345678901' }
      mockFetchAllRows.mockResolvedValueOnce([french]).mockResolvedValueOnce([french])

      const res = await importFile('Namn,E-post,Land\nAcme SARL,acme@example.test,DE\n')
      const { status, body } = await parseJsonResponse<{ data: { failed: number; errors: { reason: string }[] } }>(res)

      expect(status).toBe(200)
      expect(body.data.failed).toBe(1)
      expect(body.data.errors[0].reason).toMatch(/landsprefix/)
      expect(findCall('customers', 'update')).toBeUndefined()
    })

    it('refuses a foreign type on a sole trader whose org number is a personnummer', async () => {
      const soleTrader = { ...euCard, name: 'Ekfirman', customer_type: 'swedish_business', country: 'SE', org_number: '800101-1234', email: 'ek@firman.example', vat_number: null, vat_number_validated: false }
      mockFetchAllRows.mockResolvedValueOnce([soleTrader]).mockResolvedValueOnce([soleTrader])

      const res = await importFile('Namn,E-post,Kundtyp,Land\nEkfirman,ek@firman.example,EU,DE\n')
      const { status, body } = await parseJsonResponse<{ data: { failed: number; errors: { reason: string }[] } }>(res)

      expect(status).toBe(200)
      expect(body.data.failed).toBe(1)
      expect(body.data.errors[0].reason).toMatch(/personnummer/)
      expect(findCall('customers', 'update')).toBeUndefined()
    })

    it('gives a new customer the defaults', async () => {
      enqueue({ data: { id: 'c1', name: 'Acme AB', customer_type: 'swedish_business', country: 'SE' } })

      const res = await importFile('Namn,E-post\nAcme AB,info@acme.example.test\n')
      const { status, body } = await parseJsonResponse<{ data: { created: number } }>(res)

      expect(status).toBe(200)
      expect(body.data.created).toBe(1)
      expect(findCall('customers', 'insert')![0]).toMatchObject({ customer_type: 'swedish_business', country: 'SE' })
    })

    it('leaves the open drafts alone when the customer did not change', async () => {
      mockFetchAllRows
        .mockResolvedValueOnce([euCard]) // the undo snapshot
        .mockResolvedValueOnce([euCard]) // the register to match against
        .mockResolvedValueOnce([{ customer_id: 'old' }]) // which changed customers have a draft
      enqueue({ data: cardAfterUpdate(euCard) })
      // What a draft sync would read: the card, its draft on reverse charge,
      // the seller's VAT registration; then its write.
      enqueue({ data: cardAfterUpdate(euCard) })
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

      const res = await importFile('Namn,E-post,Telefon\nAcme GmbH,acme@example.test,+49 30 123456\n')
      const { status } = await parseJsonResponse(res)

      expect(status).toBe(200)
      expect(findCall('invoices', 'update')).toBeUndefined()
      // The snapshot and the register: no drafts lookup either.
      expect(mockFetchAllRows).toHaveBeenCalledTimes(2)
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
