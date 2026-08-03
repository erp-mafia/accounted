/**
 * Integration tests for the v1 supplier-invoices vertical (Phase 4 PR-1).
 *
 * Coverage: list, get, create (incl. period-lock + strict-mode), patch,
 * approve, mark-paid, credit. Same Proxy-mock pattern as the suppliers
 * tests: we test outcomes, not query shape.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `supplier-invoices route tests require NODE_ENV=test (got ${process.env.NODE_ENV ?? 'undefined'})`,
    )
  }
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return {
    ...actual,
    validateApiKey: vi.fn(),
    createServiceClientNoCookies: vi.fn(),
  }
})

vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})

// Mock the engine so JE creation succeeds without hitting Postgres.
const mockedReg = vi.fn()
const mockedPayment = vi.fn()
const mockedCash = vi.fn()
const mockedCredit = vi.fn()
vi.mock('@/lib/bookkeeping/supplier-invoice-entries', () => ({
  createSupplierInvoiceRegistrationEntry: (...args: unknown[]) => mockedReg(...args),
  createSupplierInvoicePaymentEntry: (...args: unknown[]) => mockedPayment(...args),
  createSupplierInvoiceCashEntry: (...args: unknown[]) => mockedCash(...args),
  createSupplierCreditNoteEntry: (...args: unknown[]) => mockedCredit(...args),
}))

// Riksbanken feeds the new server-side rate lookup on the create path.
// Spread the real module so unrelated exports stay intact.
const mockFetchExchangeRate = vi.fn()
vi.mock('@/lib/currency/riksbanken', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/currency/riksbanken')>('@/lib/currency/riksbanken')
  return { ...actual, fetchExchangeRate: (...args: unknown[]) => mockFetchExchangeRate(...args) }
})

// reverseEntry is dynamically imported in the route file for orphan storno:
// stub it so the import resolves quickly without exercising the real engine.
vi.mock('@/lib/bookkeeping/engine', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/engine')>(
    '@/lib/bookkeeping/engine',
  )
  return {
    ...actual,
    reverseEntry: vi.fn().mockResolvedValue({ id: 'storno-1' }),
  }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { GET as listSIs, POST as createSI } from '../route'
import { GET as getSI, PATCH as updateSI } from '../[id]/route'
import { POST as approveSI } from '../[id]/approve/route'
import { POST as markPaidSI } from '../[id]/mark-paid/route'
import { POST as creditSI } from '../[id]/credit/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

interface TableResp {
  data?: unknown
  error?: unknown
  count?: number | null
}

/** Payload handed to `.insert()`, recorded per table so writes can be asserted. */
type InsertRecord = { table: string; payload: Record<string, unknown> }

function makeFlexibleSupabase(
  byTable: Record<string, TableResp | TableResp[]>,
  // Opt-in sink for insert payloads: the Proxy chain is otherwise write-only,
  // and the route echoes back the fixture row rather than what it wrote.
  insertSink?: InsertRecord[],
) {
  // Per-table queue: TableResp[] consumes one entry per await, then sticks
  // on the last entry. Plain TableResp is treated as a constant.
  const queues = new Map<string, TableResp[]>()
  for (const [t, val] of Object.entries(byTable)) {
    queues.set(t, Array.isArray(val) ? [...val] : [val])
  }
  const buildChain = (table: string): unknown => {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => {
            const q = queues.get(table)
            const next = q && q.length > 1 ? q.shift()! : (q?.[0] ?? { data: null, error: null })
            resolve(next)
          }
        }
        return (...args: unknown[]) => {
          if (
            insertSink &&
            prop === 'insert' &&
            args[0] &&
            typeof args[0] === 'object' &&
            !Array.isArray(args[0])
          ) {
            insertSink.push({ table, payload: args[0] as Record<string, unknown> })
          }
          return buildChain(table)
        }
      },
    }
    return new Proxy({}, handler)
  }
  return {
    from: vi.fn((table: string) => buildChain(table)),
    rpc: vi.fn((name: string) => {
      if (name === 'get_next_arrival_number') {
        return Promise.resolve({ data: 42, error: null })
      }
      return Promise.resolve({ data: null, error: null })
    }),
  }
}

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SUPPLIER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SI_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const JE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const USER_ID = 'user-1'

function makeRequest(url: string, init?: RequestInit): Request {
  return new Request(url, {
    ...init,
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Idempotency-Key': 'b1aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      ...(init?.headers ?? {}),
    },
  })
}

function companyParams(companyId: string) {
  return { params: Promise.resolve({ companyId }) }
}

function detailParams(companyId: string, id: string) {
  return { params: Promise.resolve({ companyId, id }) }
}

const SAMPLE_SUPPLIER = {
  id: SUPPLIER_ID,
  name: 'Office Depot AB',
  supplier_type: 'swedish_business',
  archived_at: null,
}

const SAMPLE_SI = {
  id: SI_ID,
  supplier_id: SUPPLIER_ID,
  arrival_number: 42,
  supplier_invoice_number: '2026-1234',
  invoice_date: '2026-05-10',
  due_date: '2026-06-09',
  received_date: '2026-05-10',
  delivery_date: null,
  status: 'registered',
  currency: 'SEK',
  exchange_rate: null,
  exchange_rate_date: null,
  subtotal: 1000,
  subtotal_sek: null,
  vat_amount: 250,
  vat_amount_sek: null,
  total: 1250,
  total_sek: null,
  vat_treatment: 'standard_25',
  reverse_charge: false,
  payment_reference: null,
  paid_at: null,
  paid_amount: 0,
  remaining_amount: 1250,
  is_credit_note: false,
  credited_invoice_id: null,
  registration_journal_entry_id: null,
  payment_journal_entry_id: null,
  transaction_id: null,
  document_id: null,
  notes: null,
  reversed_at: null,
  created_at: '2026-05-13T15:00:00Z',
  updated_at: '2026-05-13T15:00:00Z',
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedReg.mockResolvedValue({ id: 'je-reg-1' })
  mockedPayment.mockResolvedValue({ id: 'je-pay-1' })
  mockedCash.mockResolvedValue({ id: 'je-cash-1' })
  mockedCredit.mockResolvedValue({ id: 'je-credit-1' })
  mockValidate.mockResolvedValue({
    userId: USER_ID,
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['suppliers:read', 'suppliers:write'],
    mode: 'live',
  })
})

describe('GET /api/v1/companies/:companyId/supplier-invoices', () => {
  it('returns paginated SIs with supplier_name inlined', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        supplier_invoices: {
          data: [{ ...SAMPLE_SI, supplier: { id: SUPPLIER_ID, name: 'Office Depot AB' } }],
          error: null,
        },
      }),
    )
    const res = await listSIs(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/supplier-invoices`),
      companyParams(COMPANY_ID),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0].supplier_name).toBe('Office Depot AB')
    expect(body.data[0].total).toBe(1250)
  })

  it('rejects malformed date_from with 400', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )
    const res = await listSIs(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/supplier-invoices?date_from=2026/05/10`),
      companyParams(COMPANY_ID),
    )
    expect(res.status).toBe(400)
  })
})

describe('GET /api/v1/companies/:companyId/supplier-invoices/:id', () => {
  it('returns the SI when found', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        supplier_invoices: { data: SAMPLE_SI, error: null },
      }),
    )
    const res = await getSI(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/supplier-invoices/${SI_ID}`),
      detailParams(COMPANY_ID, SI_ID),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.id).toBe(SI_ID)
  })

  it('returns 404 SI_NOT_FOUND when missing', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        supplier_invoices: { data: null, error: null },
      }),
    )
    const res = await getSI(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/supplier-invoices/${SI_ID}`),
      detailParams(COMPANY_ID, SI_ID),
    )
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('SI_NOT_FOUND')
  })
})

describe('POST /api/v1/companies/:companyId/supplier-invoices', () => {
  const validBody = {
    supplier_id: SUPPLIER_ID,
    supplier_invoice_number: '2026-1234',
    invoice_date: '2026-05-10',
    due_date: '2026-06-09',
    items: [
      { description: 'Office supplies', amount: 1000, account_number: '5410', vat_rate: 0.25 },
    ],
  }

  it('registers the SI + posts the registration JE under accrual', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        suppliers: { data: SAMPLE_SUPPLIER, error: null },
        company_settings: { data: { accounting_method: 'accrual' }, error: null },
        fiscal_periods: { data: { id: 'fp-1', is_closed: false, locked_at: null }, error: null },
        supplier_invoices: { data: SAMPLE_SI, error: null },
        supplier_invoice_items: { data: null, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await createSI(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/supplier-invoices`, {
        method: 'POST',
        body: JSON.stringify(validBody),
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(201)
    expect(mockedReg).toHaveBeenCalledTimes(1)
    const body = await res.json()
    expect(body.data.id).toBe(SI_ID)
  })

  it('returns 404 SUPPLIER_NOT_FOUND when supplier does not exist', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        suppliers: { data: null, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )
    const res = await createSI(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/supplier-invoices`, {
        method: 'POST',
        body: JSON.stringify(validBody),
      }),
      companyParams(COMPANY_ID),
    )
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('SUPPLIER_NOT_FOUND')
  })

  it('returns 400 PERIOD_LOCKED when invoice_date falls in a locked period', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        suppliers: { data: SAMPLE_SUPPLIER, error: null },
        company_settings: { data: { bookkeeping_locked_through: '2026-12-31' }, error: null },
        fiscal_periods: { data: { id: 'fp-1', is_closed: false, locked_at: null }, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )
    const res = await createSI(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/supplier-invoices`, {
        method: 'POST',
        body: JSON.stringify(validBody),
      }),
      companyParams(COMPANY_ID),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('PERIOD_LOCKED')
  })

  it('strict-mode: rolls back SI row when registration JE creation throws', async () => {
    mockedReg.mockRejectedValueOnce(new Error('engine boom'))
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        suppliers: { data: SAMPLE_SUPPLIER, error: null },
        company_settings: { data: { accounting_method: 'accrual' }, error: null },
        fiscal_periods: { data: { id: 'fp-1', is_closed: false, locked_at: null }, error: null },
        supplier_invoices: { data: SAMPLE_SI, error: null },
        supplier_invoice_items: { data: null, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )
    const res = await createSI(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/supplier-invoices`, {
        method: 'POST',
        body: JSON.stringify(validBody),
      }),
      companyParams(COMPANY_ID),
    )
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error.code).toBe('SI_CREATE_FAILED')
    expect(body.error.details.step).toBe('registration_journal_entry')
  })

  it('rolls back SI row and returns SI_CREATE_NO_FISCAL_PERIOD when no period covers invoice_date', async () => {
    // Engine returns null (not a throw) when no fiscal period covers the date.
    mockedReg.mockResolvedValueOnce(null)
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        suppliers: { data: SAMPLE_SUPPLIER, error: null },
        company_settings: { data: { accounting_method: 'accrual' }, error: null },
        fiscal_periods: { data: { id: 'fp-1', is_closed: false, locked_at: null }, error: null },
        supplier_invoices: { data: SAMPLE_SI, error: null },
        supplier_invoice_items: { data: null, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )
    const res = await createSI(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/supplier-invoices`, {
        method: 'POST',
        body: JSON.stringify(validBody),
      }),
      companyParams(COMPANY_ID),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('SI_CREATE_NO_FISCAL_PERIOD')
  })

  it('returns a dry-run preview when ?dry_run=true', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        suppliers: { data: SAMPLE_SUPPLIER, error: null },
        company_settings: { data: { bookkeeping_locked_through: null }, error: null },
        fiscal_periods: { data: { id: 'fp-1', is_closed: false, locked_at: null }, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )
    const res = await createSI(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/supplier-invoices?dry_run=true`, {
        method: 'POST',
        body: JSON.stringify(validBody),
      }),
      companyParams(COMPANY_ID),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    expect(mockedReg).not.toHaveBeenCalled()
  })

  it('rejects a non-Swedish VAT rate with 400 VALIDATION_ERROR', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        suppliers: { data: SAMPLE_SUPPLIER, error: null },
        company_settings: { data: { bookkeeping_locked_through: null }, error: null },
        fiscal_periods: { data: { id: 'fp-1', is_closed: false, locked_at: null }, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )
    const res = await createSI(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/supplier-invoices`, {
        method: 'POST',
        body: JSON.stringify({
          ...validBody,
          items: [{ description: 'X', amount: 1000, account_number: '5410', vat_rate: 0.15 }],
        }),
      }),
      companyParams(COMPANY_ID),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    // Since issue #310 the shared Zod schema rejects non-statutory rates
    // before the runtime ALLOWED_SV_VAT_RATES guard (kept as defense in
    // depth), so the details carry Zod issues instead of attempted_rate.
    const issues = body.error.details.issues as Array<{ field: string; message: string }>
    expect(issues.some((i) => i.field === 'items.0.vat_rate')).toBe(true)
    expect(issues.find((i) => i.field === 'items.0.vat_rate')!.message).toMatch(/decimal fraction/)
  })

  it('defaults vat_treatment to reverse_charge for eu_business suppliers', async () => {
    let insertedRow: Record<string, unknown> | null = null
    mockServiceClient.mockReturnValue({
      from: (table: string) => {
        if (table === 'suppliers') {
          return new Proxy({}, {
            get(_t, prop) {
              if (prop === 'then') {
                return (r: (v: unknown) => void) =>
                  r({ data: { ...SAMPLE_SUPPLIER, supplier_type: 'eu_business' }, error: null })
              }
              return () => new Proxy({}, this!)
            },
          })
        }
        if (table === 'supplier_invoices') {
          return new Proxy({}, {
            get(_t, prop) {
              if (prop === 'insert') {
                return (row: Record<string, unknown>) => {
                  insertedRow = row
                  return new Proxy({}, {
                    get(_t2, prop2) {
                      if (prop2 === 'then') {
                        return (r: (v: unknown) => void) => r({ data: SAMPLE_SI, error: null })
                      }
                      return () => new Proxy({}, this!)
                    },
                  })
                }
              }
              if (prop === 'then') {
                return (r: (v: unknown) => void) => r({ data: SAMPLE_SI, error: null })
              }
              return () => new Proxy({}, this!)
            },
          })
        }
        return new Proxy({}, {
          get(_t, prop) {
            if (prop === 'then') {
              const data = table === 'company_members'
                ? { company_id: COMPANY_ID, role: 'owner' }
                : table === 'fiscal_periods'
                  ? { id: 'fp-1', is_closed: false, locked_at: null }
                  : table === 'company_settings'
                    ? { bookkeeping_locked_through: null, accounting_method: 'accrual' }
                    : null
              return (r: (v: unknown) => void) => r({ data, error: null })
            }
            return () => new Proxy({}, this!)
          },
        })
      },
      rpc: vi.fn(() => Promise.resolve({ data: 42, error: null })),
    })

    const res = await createSI(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/supplier-invoices`, {
        method: 'POST',
        // No vat_treatment, no reverse_charge: supplier_type should drive
        // both. vat_rate: 0 because reverse-charge invoices must carry no
        // line-item VAT (buyer self-assesses).
        body: JSON.stringify({
          ...validBody,
          items: [
            { description: 'Office supplies', amount: 1000, account_number: '5410', vat_rate: 0 },
          ],
        }),
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(201)
    expect(insertedRow).not.toBeNull()
    expect(insertedRow!.vat_treatment).toBe('reverse_charge')
    expect(insertedRow!.reverse_charge).toBe(true)
  })

  it('rejects reverse_charge=true with non-zero item vat_rate (cross-field)', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        suppliers: { data: SAMPLE_SUPPLIER, error: null },
        company_settings: { data: { bookkeeping_locked_through: null }, error: null },
        fiscal_periods: { data: { id: 'fp-1', is_closed: false, locked_at: null }, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )
    const res = await createSI(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/supplier-invoices`, {
        method: 'POST',
        body: JSON.stringify({
          ...validBody,
          reverse_charge: true,
          // item vat_rate still 0.25: must be 0 under reverse charge
        }),
      }),
      companyParams(COMPANY_ID),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.reverse_charge).toBe(true)
    expect(body.error.details.attempted_rate).toBe(0.25)
  })

  it('normalises vat_treatment to "reverse_charge" when reverse_charge resolves true', async () => {
    // Caller explicitly passes vat_treatment='standard_25' for an
    // eu_business supplier and omits reverse_charge. Supplier-type drives
    // reverse_charge=true; vat_treatment must follow.
    let insertedRow: Record<string, unknown> | null = null
    mockServiceClient.mockReturnValue({
      from: (table: string) => {
        if (table === 'suppliers') {
          return new Proxy({}, {
            get(_t, prop) {
              if (prop === 'then') {
                return (r: (v: unknown) => void) =>
                  r({ data: { ...SAMPLE_SUPPLIER, supplier_type: 'eu_business' }, error: null })
              }
              return () => new Proxy({}, this!)
            },
          })
        }
        if (table === 'supplier_invoices') {
          return new Proxy({}, {
            get(_t, prop) {
              if (prop === 'insert') {
                return (row: Record<string, unknown>) => {
                  insertedRow = row
                  return new Proxy({}, {
                    get(_t2, prop2) {
                      if (prop2 === 'then') {
                        return (r: (v: unknown) => void) => r({ data: SAMPLE_SI, error: null })
                      }
                      return () => new Proxy({}, this!)
                    },
                  })
                }
              }
              if (prop === 'then') {
                return (r: (v: unknown) => void) => r({ data: SAMPLE_SI, error: null })
              }
              return () => new Proxy({}, this!)
            },
          })
        }
        return new Proxy({}, {
          get(_t, prop) {
            if (prop === 'then') {
              const data = table === 'company_members'
                ? { company_id: COMPANY_ID, role: 'owner' }
                : table === 'fiscal_periods'
                  ? { id: 'fp-1', is_closed: false, locked_at: null }
                  : table === 'company_settings'
                    ? { bookkeeping_locked_through: null, accounting_method: 'accrual' }
                    : null
              return (r: (v: unknown) => void) => r({ data, error: null })
            }
            return () => new Proxy({}, this!)
          },
        })
      },
      rpc: vi.fn(() => Promise.resolve({ data: 42, error: null })),
    })

    const res = await createSI(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/supplier-invoices`, {
        method: 'POST',
        body: JSON.stringify({
          ...validBody,
          vat_treatment: 'standard_25',  // explicit but should be overridden
          items: [
            { description: 'Office supplies', amount: 1000, account_number: '5410', vat_rate: 0 },
          ],
        }),
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(201)
    expect(insertedRow).not.toBeNull()
    // Even with explicit vat_treatment='standard_25', the resolved
    // reverse_charge=true forces normalisation to 'reverse_charge'.
    expect(insertedRow!.vat_treatment).toBe('reverse_charge')
    expect(insertedRow!.reverse_charge).toBe(true)
  })

  it('persists default_dimensions + items[].dimensions and hands the item bags to the JE engine', async () => {
    let insertedInvoice: Record<string, unknown> | null = null
    let insertedItems: Array<Record<string, unknown>> | null = null
    mockServiceClient.mockReturnValue({
      from: (table: string) => {
        if (table === 'supplier_invoices') {
          return new Proxy({}, {
            get(_t, prop) {
              if (prop === 'insert') {
                return (row: Record<string, unknown>) => {
                  insertedInvoice = row
                  return new Proxy({}, {
                    get(_t2, prop2) {
                      if (prop2 === 'then') {
                        return (r: (v: unknown) => void) => r({ data: SAMPLE_SI, error: null })
                      }
                      return () => new Proxy({}, this!)
                    },
                  })
                }
              }
              if (prop === 'then') {
                return (r: (v: unknown) => void) => r({ data: SAMPLE_SI, error: null })
              }
              return () => new Proxy({}, this!)
            },
          })
        }
        if (table === 'supplier_invoice_items') {
          return new Proxy({}, {
            get(_t, prop) {
              if (prop === 'insert') {
                return (rows: Array<Record<string, unknown>>) => {
                  insertedItems = rows
                  return new Proxy({}, {
                    get(_t2, prop2) {
                      if (prop2 === 'then') {
                        return (r: (v: unknown) => void) => r({ data: null, error: null })
                      }
                      return () => new Proxy({}, this!)
                    },
                  })
                }
              }
              if (prop === 'then') {
                return (r: (v: unknown) => void) => r({ data: null, error: null })
              }
              return () => new Proxy({}, this!)
            },
          })
        }
        return new Proxy({}, {
          get(_t, prop) {
            if (prop === 'then') {
              const data = table === 'company_members'
                ? { company_id: COMPANY_ID, role: 'owner' }
                : table === 'suppliers'
                  ? SAMPLE_SUPPLIER
                  : table === 'fiscal_periods'
                    ? { id: 'fp-1', is_closed: false, locked_at: null }
                    : table === 'company_settings'
                      ? { bookkeeping_locked_through: null, accounting_method: 'accrual' }
                      : null
              return (r: (v: unknown) => void) => r({ data, error: null })
            }
            return () => new Proxy({}, this!)
          },
        })
      },
      rpc: vi.fn(() => Promise.resolve({ data: 42, error: null })),
    })

    const res = await createSI(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/supplier-invoices`, {
        method: 'POST',
        body: JSON.stringify({
          ...validBody,
          default_dimensions: { '6': 'P001' },
          items: [
            {
              description: 'Office supplies',
              amount: 1000,
              account_number: '5410',
              vat_rate: 0.25,
              dimensions: { '1': 'KS01' },
            },
          ],
        }),
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(201)
    expect(insertedInvoice).not.toBeNull()
    expect(insertedInvoice!.default_dimensions).toEqual({ '6': 'P001' })
    expect(insertedItems).not.toBeNull()
    expect(insertedItems![0].dimensions).toEqual({ '1': 'KS01' })
    // The engine receives the item rows WITH their bags so the registration
    // JE expense lines are tagged (bag merge happens inside the generator).
    expect(mockedReg).toHaveBeenCalledTimes(1)
    const engineItems = mockedReg.mock.calls[0][4] as Array<{ dimensions?: Record<string, string> }>
    expect(engineItems[0].dimensions).toEqual({ '1': 'KS01' })
  })

  it('dry-run preview carries default_dimensions and per-item dimensions', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        suppliers: { data: SAMPLE_SUPPLIER, error: null },
        company_settings: { data: { bookkeeping_locked_through: null }, error: null },
        fiscal_periods: { data: { id: 'fp-1', is_closed: false, locked_at: null }, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )
    const res = await createSI(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/supplier-invoices?dry_run=true`, {
        method: 'POST',
        body: JSON.stringify({
          ...validBody,
          default_dimensions: { '6': 'P001' },
          items: [
            {
              description: 'Office supplies',
              amount: 1000,
              account_number: '5410',
              vat_rate: 0.25,
              dimensions: { '1': 'KS01' },
            },
          ],
        }),
      }),
      companyParams(COMPANY_ID),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    const body = await res.json()
    expect(body.data.preview.default_dimensions).toEqual({ '6': 'P001' })
    expect(body.data.preview.items[0].dimensions).toEqual({ '1': 'KS01' })
  })
})

describe('POST /api/v1/companies/:companyId/supplier-invoices: exchange rate + SEK amounts', () => {
  const captured: InsertRecord[] = []

  const validBody = {
    supplier_id: SUPPLIER_ID,
    supplier_invoice_number: '2026-FX',
    invoice_date: '2026-05-10',
    due_date: '2026-06-09',
    items: [
      { description: 'Cloud hosting', amount: 1000, account_number: '5410', vat_rate: 0.25 },
    ],
  }

  function installSupabase() {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase(
        {
          company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
          suppliers: { data: SAMPLE_SUPPLIER, error: null },
          company_settings: { data: { accounting_method: 'cash' }, error: null },
          fiscal_periods: { data: { id: 'fp-1', is_closed: false, locked_at: null }, error: null },
          supplier_invoices: { data: SAMPLE_SI, error: null },
          supplier_invoice_items: { data: null, error: null },
          idempotency_keys: { data: null, error: null },
        },
        captured,
      ),
    )
  }

  const siInsert = () => captured.find((c) => c.table === 'supplier_invoices')?.payload

  function post(body: Record<string, unknown>) {
    return createSI(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/supplier-invoices`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
      companyParams(COMPANY_ID),
    )
  }

  beforeEach(() => {
    captured.length = 0
    mockFetchExchangeRate.mockReset()
    installSupabase()
  })

  it('returns 401 UNAUTHORIZED when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'invalid api key', status: 401 })
    const res = await post(validBody)
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error.code).toBe('UNAUTHORIZED')
    expect(mockFetchExchangeRate).not.toHaveBeenCalled()
  })

  it('returns 400 VALIDATION_ERROR when the body is malformed', async () => {
    const res = await post({ ...validBody, invoice_date: '10/05/2026' })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('returns 404 SUPPLIER_NOT_FOUND before any rate lookup', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase(
        {
          company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
          suppliers: { data: null, error: null },
        },
        captured,
      ),
    )
    const res = await post({ ...validBody, currency: 'EUR' })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('SUPPLIER_NOT_FOUND')
    expect(mockFetchExchangeRate).not.toHaveBeenCalled()
  })

  it('populates total_sek for a SEK invoice without touching Riksbanken', async () => {
    const res = await post(validBody)
    expect(res.status).toBe(201)

    const payload = siInsert()
    expect(payload).toBeDefined()
    expect(payload!.subtotal_sek).toBe(1000)
    expect(payload!.vat_amount_sek).toBe(250)
    expect(payload!.total_sek).toBe(1250)
    expect(payload!.total_sek).toBe(payload!.total)
    expect(payload!.exchange_rate).toBeNull()
    expect(payload!.exchange_rate_date).toBeNull()
    expect(mockFetchExchangeRate).not.toHaveBeenCalled()
  })

  it('honours a caller-supplied rate on a foreign invoice', async () => {
    const res = await post({
      ...validBody,
      currency: 'USD',
      exchange_rate: 10.5,
      // SAMPLE_SUPPLIER is a Swedish business, so reverse_charge stays off and
      // the 25 % line VAT is legal here.
    })
    expect(res.status).toBe(201)

    const payload = siInsert()
    expect(payload!.currency).toBe('USD')
    expect(payload!.exchange_rate).toBe(10.5)
    expect(payload!.subtotal_sek).toBe(10500)
    expect(payload!.vat_amount_sek).toBe(2625)
    expect(payload!.total_sek).toBe(13125)
    expect(mockFetchExchangeRate).not.toHaveBeenCalled()
  })

  it('fetches the invoice-date rate when the agent omits exchange_rate', async () => {
    mockFetchExchangeRate.mockResolvedValue({ currency: 'EUR', rate: 11.4, date: '2026-05-08' })

    const res = await post({ ...validBody, currency: 'EUR' })
    expect(res.status).toBe(201)

    expect(mockFetchExchangeRate).toHaveBeenCalledTimes(1)
    const [currencyArg, dateArg, clientArg] = mockFetchExchangeRate.mock.calls[0]
    expect(currencyArg).toBe('EUR')
    expect((dateArg as Date).toISOString().slice(0, 10)).toBe('2026-05-10')
    // Passed through so the shared exchange_rates cache is read and written.
    expect(clientArg).toBeDefined()

    const payload = siInsert()
    expect(payload!.exchange_rate).toBe(11.4)
    expect(payload!.exchange_rate_date).toBe('2026-05-08')
    expect(payload!.total_sek).toBe(14250)
  })

  it('refuses the create with 400 SI_FX_RATE_MISSING when no rate can be resolved', async () => {
    mockFetchExchangeRate.mockResolvedValue(null)

    const res = await post({ ...validBody, currency: 'EUR' })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('SI_FX_RATE_MISSING')
    expect(body.error.details.currency).toBe('EUR')
    // No row, no ankomstnummer, no verifikat: a NULL-rate row would only
    // relocate the failure into the booking path.
    expect(siInsert()).toBeUndefined()
    expect(mockedReg).not.toHaveBeenCalled()
  })

  it('surfaces the same refusal in a dry run', async () => {
    mockFetchExchangeRate.mockResolvedValue(null)

    const res = await createSI(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/supplier-invoices?dry_run=true`, {
        method: 'POST',
        body: JSON.stringify({ ...validBody, currency: 'EUR' }),
      }),
      companyParams(COMPANY_ID),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('SI_FX_RATE_MISSING')
  })

  // v1 shares CreateSupplierInvoiceSchema with POST /api/supplier-invoices and
  // the inbox convert route, so the constraint mirror is enforced identically
  // on all three. These pin that agreement: an agent posting a pasted total
  // where a rate belongs gets a structured 400, never a 23514-driven 500.
  it('rejects an out-of-range exchange rate with 400 VALIDATION_ERROR, not a 500', async () => {
    const res = await post({ ...validBody, currency: 'EUR', exchange_rate: 250000 })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    const issue = body.error.details.issues.find(
      (i: { field: string }) => i.field === 'exchange_rate',
    )
    expect(issue?.message).toContain('100 000')
    expect(siInsert()).toBeUndefined()
    expect(mockedReg).not.toHaveBeenCalled()
    expect(mockFetchExchangeRate).not.toHaveBeenCalled()
  })

  it('rejects exactly 100000: the CHECK bound is exclusive', async () => {
    const res = await post({ ...validBody, currency: 'EUR', exchange_rate: 100000 })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(siInsert()).toBeUndefined()
  })

  it('accepts 99999.99, the largest rate the CHECK allows', async () => {
    const res = await post({ ...validBody, currency: 'EUR', exchange_rate: 99999.99 })
    expect(res.status).toBe(201)
    expect(siInsert()!.exchange_rate).toBe(99999.99)
  })

  it('rejects a zero or negative rate the same way', async () => {
    for (const rate of [0, -11.5]) {
      captured.length = 0
      const res = await post({ ...validBody, currency: 'EUR', exchange_rate: rate })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error.code).toBe('VALIDATION_ERROR')
      expect(siInsert()).toBeUndefined()
    }
  })
})

describe('PATCH /api/v1/companies/:companyId/supplier-invoices/:id', () => {
  it('updates a registered SI', async () => {
    const updated = { ...SAMPLE_SI, payment_reference: 'OCR-9999' }
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        supplier_invoices: { data: updated, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )
    const res = await updateSI(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/supplier-invoices/${SI_ID}`, {
        method: 'PATCH',
        body: JSON.stringify({ payment_reference: 'OCR-9999' }),
      }),
      detailParams(COMPANY_ID, SI_ID),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.payment_reference).toBe('OCR-9999')
  })

  it('refuses to update an approved SI (400 SI_NOT_DRAFT)', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        supplier_invoices: { data: { ...SAMPLE_SI, status: 'approved' }, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )
    const res = await updateSI(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/supplier-invoices/${SI_ID}`, {
        method: 'PATCH',
        body: JSON.stringify({ payment_reference: 'OCR-9999' }),
      }),
      detailParams(COMPANY_ID, SI_ID),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('SI_NOT_DRAFT')
  })

  // #1230: the shared guard has to hold on the API-key path too, not just in
  // the dashboard route: invoice_date is the posted entry's entry_date and
  // supplier_invoice_number is in its description.
  it('refuses to move invoice_date on an SI that already has a registration verifikat', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        supplier_invoices: {
          data: { ...SAMPLE_SI, registration_journal_entry_id: JE_ID },
          error: null,
        },
        idempotency_keys: { data: null, error: null },
      }),
    )
    const res = await updateSI(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/supplier-invoices/${SI_ID}`, {
        method: 'PATCH',
        body: JSON.stringify({ invoice_date: '2026-06-01' }),
      }),
      detailParams(COMPANY_ID, SI_ID),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('SI_EDIT_VERIFIKAT_LOCKED')
    expect(body.error.details.fields).toEqual(['invoice_date'])
  })

  it('still patches due_date on a booked SI, and accepts unchanged verifikat fields', async () => {
    const booked = { ...SAMPLE_SI, registration_journal_entry_id: JE_ID }
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        supplier_invoices: { data: { ...booked, due_date: '2026-07-31' }, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )
    const res = await updateSI(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/supplier-invoices/${SI_ID}`, {
        method: 'PATCH',
        body: JSON.stringify({
          due_date: '2026-07-31',
          invoice_date: SAMPLE_SI.invoice_date,
          supplier_invoice_number: SAMPLE_SI.supplier_invoice_number,
        }),
      }),
      detailParams(COMPANY_ID, SI_ID),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.due_date).toBe('2026-07-31')
  })

  it('reports the lock, not a generic race, when a registration entry lands mid-flight', async () => {
    // Queue: pre-flight read (unbooked) -> pinned update matches nothing ->
    // re-read shows the entry that landed in between.
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        supplier_invoices: [
          { data: SAMPLE_SI, error: null },
          { data: null, error: null },
          { data: { ...SAMPLE_SI, registration_journal_entry_id: JE_ID }, error: null },
        ],
        idempotency_keys: { data: null, error: null },
      }),
    )
    const res = await updateSI(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/supplier-invoices/${SI_ID}`, {
        method: 'PATCH',
        body: JSON.stringify({ invoice_date: '2026-06-01' }),
      }),
      detailParams(COMPANY_ID, SI_ID),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('SI_EDIT_VERIFIKAT_LOCKED')
    expect(body.error.details.reason).toBe('race')
  })

  it('rejects unknown body keys (V4.5 strict schema)', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        supplier_invoices: { data: SAMPLE_SI, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )
    const res = await updateSI(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/supplier-invoices/${SI_ID}`, {
        method: 'PATCH',
        // `status` is not in UpdateSupplierInvoiceSchema: must be rejected.
        body: JSON.stringify({ status: 'approved' }),
      }),
      detailParams(COMPANY_ID, SI_ID),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })
})

describe('POST /api/v1/companies/:companyId/supplier-invoices/:id/approve', () => {
  it('flips registered → approved', async () => {
    const registered = { ...SAMPLE_SI, status: 'registered' }
    const approved = { ...SAMPLE_SI, status: 'approved' }
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        // Queue: 1st = pre-flight (registered), 2nd = post-update (approved).
        supplier_invoices: [
          { data: registered, error: null },
          { data: approved, error: null },
        ],
        idempotency_keys: { data: null, error: null },
      }),
    )
    const res = await approveSI(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/supplier-invoices/${SI_ID}/approve`, {
        method: 'POST',
      }),
      detailParams(COMPANY_ID, SI_ID),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.status).toBe('approved')
  })

  it('attests an overdue SI, which stays overdue while it is still late (#1206)', async () => {
    // The daily cron flips unbooked payables past due_date to 'overdue'. Attest
    // must stay reachable there, and it does not make late money on time.
    const overdue = { ...SAMPLE_SI, status: 'overdue', due_date: '2000-01-01', approved_at: null }
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        supplier_invoices: [
          { data: overdue, error: null },
          { data: { ...overdue, approved_at: '2026-07-27T08:00:00Z' }, error: null },
        ],
        idempotency_keys: { data: null, error: null },
      }),
    )
    const res = await approveSI(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/supplier-invoices/${SI_ID}/approve`, {
        method: 'POST',
      }),
      detailParams(COMPANY_ID, SI_ID),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.status).toBe('overdue')
    expect(body.data.approved_at).toBe('2026-07-27T08:00:00Z')
  })

  it('refuses on an already-attested SI (400 SI_APPROVE_NOT_REGISTERED)', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        supplier_invoices: {
          data: { ...SAMPLE_SI, status: 'overdue', approved_at: '2026-07-01T08:00:00Z' },
          error: null,
        },
        idempotency_keys: { data: null, error: null },
      }),
    )
    const res = await approveSI(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/supplier-invoices/${SI_ID}/approve`, {
        method: 'POST',
      }),
      detailParams(COMPANY_ID, SI_ID),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('SI_APPROVE_NOT_REGISTERED')
  })
})

describe('POST /api/v1/companies/:companyId/supplier-invoices/:id/mark-paid', () => {
  const approvedSI = {
    ...SAMPLE_SI,
    status: 'approved',
    supplier: { id: SUPPLIER_ID, name: 'Office Depot AB', supplier_type: 'swedish_business' },
    items: [],
  }

  it('books the payment JE and flips status to paid', async () => {
    const updated = {
      id: SI_ID,
      status: 'paid',
      total: 1250,
      paid_amount: 1250,
      remaining_amount: 0,
      paid_at: '2026-05-13T16:00:00Z',
      payment_journal_entry_id: 'je-pay-1',
    }
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        supplier_invoices: { data: approvedSI, error: null },
        company_settings: { data: { accounting_method: 'accrual' }, error: null },
        fiscal_periods: { data: { id: 'fp-1', is_closed: false, locked_at: null }, error: null },
        supplier_invoice_payments: { data: null, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )
    // The .update() returns a different table-keyed response. To return the
    // updated row we re-mock with a queue once the route updates supplier_invoices.
    // Simpler: rebind makeFlexibleSupabase to also return `updated` on the
    // second call. We rely on the fact that the route's first read uses one
    // proxy chain and the update uses another. Returning the same response
    // for every supplier_invoices read works for the happy-path test.
    mockServiceClient.mockReturnValueOnce(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        supplier_invoices: { data: approvedSI, error: null },
        company_settings: { data: { accounting_method: 'accrual' }, error: null },
        fiscal_periods: { data: { id: 'fp-1', is_closed: false, locked_at: null }, error: null },
        supplier_invoice_payments: { data: null, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )

    // For the update path, simulate the .update().select().maybeSingle()
    // returning the new row. The flexible mock returns the same response per
    // table, so set the supplier_invoices response to the updated row: both
    // the pre-flight read AND the update read will return it. We only check
    // the response shape from the latter, which the route maps directly.
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        supplier_invoices: { data: { ...approvedSI, ...updated }, error: null },
        company_settings: { data: { accounting_method: 'accrual' }, error: null },
        fiscal_periods: { data: { id: 'fp-1', is_closed: false, locked_at: null }, error: null },
        supplier_invoice_payments: { data: null, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await markPaidSI(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/supplier-invoices/${SI_ID}/mark-paid`, {
        method: 'POST',
      }),
      detailParams(COMPANY_ID, SI_ID),
    )

    expect(res.status).toBe(200)
    expect(mockedPayment).toHaveBeenCalledTimes(1)
  })

  it('returns 400 SI_PAID_PERIOD_LOCKED when payment_date is in a locked period', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        supplier_invoices: { data: approvedSI, error: null },
        company_settings: { data: { bookkeeping_locked_through: '2030-01-01' }, error: null },
        fiscal_periods: { data: { id: 'fp-1', is_closed: false, locked_at: null }, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )
    const res = await markPaidSI(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/supplier-invoices/${SI_ID}/mark-paid`, {
        method: 'POST',
      }),
      detailParams(COMPANY_ID, SI_ID),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('SI_PAID_PERIOD_LOCKED')
    expect(mockedPayment).not.toHaveBeenCalled()
  })

  it('returns 409 SI_PAID_ALREADY when SI is already paid', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        supplier_invoices: { data: { ...approvedSI, status: 'paid' }, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )
    const res = await markPaidSI(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/supplier-invoices/${SI_ID}/mark-paid`, {
        method: 'POST',
      }),
      detailParams(COMPANY_ID, SI_ID),
    )
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('SI_PAID_ALREADY')
  })

  it('strict-mode: aborts before SI mutation when JE engine throws', async () => {
    mockedPayment.mockRejectedValueOnce(new Error('engine fail'))
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        supplier_invoices: { data: approvedSI, error: null },
        company_settings: { data: { accounting_method: 'accrual' }, error: null },
        fiscal_periods: { data: { id: 'fp-1', is_closed: false, locked_at: null }, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )
    const res = await markPaidSI(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/supplier-invoices/${SI_ID}/mark-paid`, {
        method: 'POST',
      }),
      detailParams(COMPANY_ID, SI_ID),
    )
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error.code).toBe('SI_PAID_FAILED')
  })

  it('requires exchange_rate_difference for non-SEK accrual', async () => {
    const eurSI = { ...approvedSI, currency: 'EUR' }
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        supplier_invoices: { data: eurSI, error: null },
        company_settings: { data: { accounting_method: 'accrual', bookkeeping_locked_through: null }, error: null },
        fiscal_periods: { data: { id: 'fp-1', is_closed: false, locked_at: null }, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )
    // POST with NO body → no exchange_rate_difference supplied.
    const res = await markPaidSI(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/supplier-invoices/${SI_ID}/mark-paid`, {
        method: 'POST',
      }),
      detailParams(COMPANY_ID, SI_ID),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.issues[0].field).toBe('exchange_rate_difference')
    expect(body.error.details.invoice_currency).toBe('EUR')
    // JE engine must NOT have been called.
    expect(mockedPayment).not.toHaveBeenCalled()
  })

  it('passes when exchange_rate_difference is supplied (even as 0) for non-SEK accrual', async () => {
    const eurSI = { ...approvedSI, currency: 'EUR' }
    const paidEurSI = { ...eurSI, status: 'paid', paid_amount: 1250, remaining_amount: 0 }
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        // 1st read: pre-flight (approved). 2nd read: post-update select (paid).
        supplier_invoices: [
          { data: eurSI, error: null },
          { data: paidEurSI, error: null },
        ],
        company_settings: { data: { accounting_method: 'accrual', bookkeeping_locked_through: null }, error: null },
        fiscal_periods: { data: { id: 'fp-1', is_closed: false, locked_at: null }, error: null },
        supplier_invoice_payments: { data: null, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )
    const res = await markPaidSI(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/supplier-invoices/${SI_ID}/mark-paid`, {
        method: 'POST',
        body: JSON.stringify({ exchange_rate_difference: 0 }),
      }),
      detailParams(COMPANY_ID, SI_ID),
    )
    expect(res.status).toBe(200)
    expect(mockedPayment).toHaveBeenCalledTimes(1)
  })

  it('rejects a future payment_date with 400 VALIDATION_ERROR', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        // The pre-flight fetch should not even fire: the schema check runs first.
        supplier_invoices: { data: approvedSI, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )
    const future = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString().split('T')[0]
    const res = await markPaidSI(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/supplier-invoices/${SI_ID}/mark-paid`, {
        method: 'POST',
        body: JSON.stringify({ payment_date: future }),
      }),
      detailParams(COMPANY_ID, SI_ID),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.field).toBe('payment_date')
    expect(body.error.details.attempted).toBe(future)
    expect(mockedPayment).not.toHaveBeenCalled()
  })

  it('rejects payment amount exceeding remaining_amount', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        // approvedSI.remaining_amount === 1250
        supplier_invoices: { data: approvedSI, error: null },
        company_settings: { data: { accounting_method: 'accrual', bookkeeping_locked_through: null }, error: null },
        fiscal_periods: { data: { id: 'fp-1', is_closed: false, locked_at: null }, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )
    const res = await markPaidSI(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/supplier-invoices/${SI_ID}/mark-paid`, {
        method: 'POST',
        // 1500 > 1250 remaining: must be rejected, not silently clamped.
        body: JSON.stringify({ amount: 1500 }),
      }),
      detailParams(COMPANY_ID, SI_ID),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.field).toBe('amount')
    expect(body.error.details.attempted).toBe(1500)
    expect(body.error.details.remaining_amount).toBe(1250)
    expect(mockedPayment).not.toHaveBeenCalled()
  })
})

describe('POST /api/v1/companies/:companyId/supplier-invoices/:id/credit', () => {
  const registeredSI = {
    ...SAMPLE_SI,
    supplier: { id: SUPPLIER_ID, name: 'Office Depot AB', supplier_type: 'swedish_business' },
    items: [
      {
        sort_order: 0,
        description: 'Office supplies',
        quantity: 1,
        unit: 'st',
        unit_price: 1000,
        line_total: 1000,
        account_number: '5410',
        vat_code: null,
        vat_rate: 25,
        vat_amount: 250,
      },
    ],
  }

  it('issues a credit note + posts the reversing JE', async () => {
    const creditNoteRow = {
      ...SAMPLE_SI,
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      arrival_number: 43,
      supplier_invoice_number: 'KREDIT-2026-1234',
      is_credit_note: true,
      credited_invoice_id: SI_ID,
    }
    let siReadCount = 0
    let insertedItems: Array<{ vat_rate: number }> = []
    mockServiceClient.mockReturnValue({
      from: (table: string) => {
        return new Proxy({}, {
          get(_t, prop) {
            if (prop === 'then') {
              return (resolve: (v: unknown) => void) => {
                if (table === 'company_members') {
                  resolve({ data: { company_id: COMPANY_ID, role: 'owner' }, error: null })
                } else if (table === 'supplier_invoices') {
                  const n = siReadCount++
                  // 1st: pre-flight fetch of original (with supplier + items)
                  // 2nd: insert credit-note row
                  // 3rd: update credit-note with reg JE id (no return needed)
                  // 4th: flip original's status to credited
                  if (n === 0) resolve({ data: registeredSI, error: null })
                  else if (n === 1) resolve({ data: creditNoteRow, error: null })
                  else resolve({ data: { id: SI_ID, status: 'credited' }, error: null })
                } else if (table === 'company_settings') {
                  resolve({ data: { accounting_method: 'accrual' }, error: null })
                } else if (table === 'fiscal_periods') {
                  resolve({ data: { id: 'fp-1', is_closed: false, locked_at: null }, error: null })
                } else {
                  resolve({ data: null, error: null })
                }
              }
            }
            return (...args: unknown[]) => {
              if (table === 'supplier_invoice_items' && prop === 'insert') {
                insertedItems = args[0] as Array<{ vat_rate: number }>
              }
              return new Proxy({}, this!)
            }
          },
        })
      },
      rpc: vi.fn(() => Promise.resolve({ data: 43, error: null })),
    })

    const res = await creditSI(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/supplier-invoices/${SI_ID}/credit`, {
        method: 'POST',
      }),
      detailParams(COMPANY_ID, SI_ID),
    )

    expect(res.status).toBe(200)
    expect(mockedCredit).toHaveBeenCalledTimes(1)
    expect(insertedItems[0]?.vat_rate).toBe(0.25)
    expect(mockedCredit.mock.calls[0]?.[4]).toBe(registeredSI.items)
    expect((mockedCredit.mock.calls[0]?.[4] as typeof registeredSI.items)[0]?.vat_rate).toBe(25)
    const body = await res.json()
    expect(body.data.credit_note_id).toBe(creditNoteRow.id)
    expect(body.data.original_id).toBe(SI_ID)
  })

  it('returns 409 SI_CREDIT_ALREADY_CREDITED when status=credited', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        supplier_invoices: { data: { ...registeredSI, status: 'credited' }, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )
    const res = await creditSI(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/supplier-invoices/${SI_ID}/credit`, {
        method: 'POST',
      }),
      detailParams(COMPANY_ID, SI_ID),
    )
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('SI_CREDIT_ALREADY_CREDITED')
  })

  it('returns 400 SI_CREDIT_PERIOD_LOCKED when today falls in a locked period', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        supplier_invoices: { data: registeredSI, error: null },
        company_settings: { data: { bookkeeping_locked_through: '2030-01-01' }, error: null },
        fiscal_periods: { data: { id: 'fp-1', is_closed: false, locked_at: null }, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )
    const res = await creditSI(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/supplier-invoices/${SI_ID}/credit`, {
        method: 'POST',
      }),
      detailParams(COMPANY_ID, SI_ID),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('SI_CREDIT_PERIOD_LOCKED')
  })

  it('dry-run returns preview without arrival_number allocation or JE creation', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        supplier_invoices: { data: registeredSI, error: null },
        company_settings: { data: { bookkeeping_locked_through: null }, error: null },
        fiscal_periods: { data: { id: 'fp-1', is_closed: false, locked_at: null }, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )
    const res = await creditSI(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/supplier-invoices/${SI_ID}/credit?dry_run=true`, {
        method: 'POST',
      }),
      detailParams(COMPANY_ID, SI_ID),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    expect(mockedCredit).not.toHaveBeenCalled()
  })
})
