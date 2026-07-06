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

function makeFlexibleSupabase(byTable: Record<string, TableResp | TableResp[]>) {
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
        return (..._args: unknown[]) => buildChain(table)
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
    expect(body.error.details.attempted_rate).toBe(0.15)
    expect(body.error.details.allowed_rates).toEqual([0, 0.06, 0.12, 0.25])
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

  it('refuses on already-approved SI (400 SI_APPROVE_NOT_REGISTERED)', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        supplier_invoices: { data: { ...SAMPLE_SI, status: 'approved' }, error: null },
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
        vat_rate: 0.25,
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
            return () => new Proxy({}, this!)
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
