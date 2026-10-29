// The error classes and the refusal mapping stay real: the executor answers
// a database refusal by its class and code (crm#1272).
vi.mock('@/lib/import/sie-jobs',async (importOriginal)=>({
  ...(await importOriginal<typeof import('@/lib/import/sie-jobs')>()),submitSIEJob:vi.fn(),requestSIEJobAction:vi.fn(),
}))
/**
 * Unit tests for the executors added to bring every declared op type up to a
 * callable state through `commitPendingOperation`. Tests run through the
 * public dispatcher (executors are not exported individually) so the wiring
 * is exercised alongside executor logic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import {
  createQueuedMockSupabase,
  makeCustomer,
  makeInvoice,
  makeFiscalPeriod,
  makeSupplierInvoice,
} from '@/tests/helpers'
import type { PendingOperation } from '@/types'
import { decryptPersonnummer, encryptPersonnummer } from '@/lib/salary/personnummer'

// The link_document_to_voucher inbox stamp reports through the logger, so
// `warn` is the assertion surface. Same shape as bank-reconciliation.test.ts:
// the REAL logger module is kept and only `warn` is swapped, so child() and
// every other level stay real for the rest of this suite.
const { logWarn } = vi.hoisted(() => ({ logWarn: vi.fn() }))
vi.mock('@/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logger')>()
  return {
    ...actual,
    createLogger: (module: string, base?: Parameters<typeof actual.createLogger>[1]) => ({
      ...actual.createLogger(module, base),
      warn: logWarn,
    }),
  }
})

vi.mock('@/lib/core/bookkeeping/period-service', async () => {
  const actual = await vi.importActual<typeof import('@/lib/core/bookkeeping/period-service')>(
    '@/lib/core/bookkeeping/period-service'
  )
  return {
    ...actual,
    unlockPeriod: vi.fn(),
  }
})

// create_transaction and create_invoice now resolve a Riksbanken rate for any
// non-SEK row (and refuse when there is none), so the foreign-currency cases
// below must not reach the real API. FX behaviour itself is covered in
// staged-fx-rates.test.ts.
vi.mock('@/lib/currency/riksbanken', async () => {
  const actual = await vi.importActual<typeof import('@/lib/currency/riksbanken')>(
    '@/lib/currency/riksbanken'
  )
  return {
    ...actual,
    fetchExchangeRate: vi.fn(async (currency: string) => ({
      currency,
      rate: 10.5,
      date: '2026-05-01',
    })),
  }
})

// The attach operation compares the document with the row first
// (lib/documents/bank-match/fit.ts, crm#1479), which reads the document's
// reading; the commit cases below queue their reads exactly, so the check
// answers "no verdict" here. It has its own tests.
vi.mock('@/lib/documents/bank-match/fit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/documents/bank-match/fit')>()),
  documentFitGate: vi.fn(() => async () => null),
}))

vi.mock('@/lib/import/sie-parser', () => ({
  parseSIEFile: vi.fn(),
  calculateFileHash: vi.fn(async () => 'mock-hash'),
}))

vi.mock('@/lib/bokslut/assets/depreciation-engine', () => ({
  commitAnnualPostings: vi.fn(),
}))

vi.mock('@/lib/bookkeeping/invoice-entries', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/bookkeeping/invoice-entries')>(
      '@/lib/bookkeeping/invoice-entries'
    )
  return {
    ...actual,
    createCreditNoteJournalEntry: vi.fn(),
  }
})

vi.mock('@/lib/bookkeeping/supplier-invoice-entries', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/bookkeeping/supplier-invoice-entries')>(
      '@/lib/bookkeeping/supplier-invoice-entries'
    )
  return {
    ...actual,
    createSupplierCreditNoteEntry: vi.fn(),
  }
})

vi.mock('@/lib/transactions/categorize-core', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/transactions/categorize-core')>(
      '@/lib/transactions/categorize-core'
    )
  return {
    ...actual,
    categorizeMatchedTransaction: vi.fn(),
  }
})

vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return { ...actual, hasCapability: vi.fn().mockResolvedValue(true) }
})

vi.mock('@/lib/email/invoice-sender', () => ({
  resolveInvoiceSender: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/email/service', () => ({
  getEmailService: () => ({
    isConfigured: () => true,
    sendEmail: vi.fn(),
  }),
}))

vi.mock('@/lib/invoices/ensure-invoice-number', () => ({
  ensureInvoiceNumber: vi.fn(),
}))

const mockRecordManualInvoiceDelivery = vi.fn().mockResolvedValue({ id: 'delivery-1' })
const mockReserveInvoiceDelivery = vi.fn().mockResolvedValue('delivery-1')
vi.mock('@/lib/invoices/invoice-deliveries', () => ({
  recordManualInvoiceDelivery: (...args: unknown[]) => mockRecordManualInvoiceDelivery(...args),
  reserveInvoiceDelivery: (...args: unknown[]) => mockReserveInvoiceDelivery(...args),
  sendTrackedInvoiceEmail: vi.fn(),
}))

import { commitPendingOperation } from '../commit'
import { unlockPeriod } from '@/lib/core/bookkeeping/period-service'
import { codedRefusal } from '@/lib/errors/refusal'
import { parseSIEFile } from '@/lib/import/sie-parser'
import { jobDatabaseError, requestSIEJobAction, submitSIEJob } from '@/lib/import/sie-jobs'
import { commitAnnualPostings } from '@/lib/bokslut/assets/depreciation-engine'
import { createSupplierCreditNoteEntry } from '@/lib/bookkeeping/supplier-invoice-entries'
import { categorizeMatchedTransaction } from '@/lib/transactions/categorize-core'
import { ensureInvoiceNumber } from '@/lib/invoices/ensure-invoice-number'

function makePendingOp(overrides: Partial<PendingOperation>): PendingOperation {
  return {
    id: 'op-1',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'create_customer',
    status: 'pending',
    title: 'test',
    params: {},
    preview_data: {},
    result_data: null,
    actor_type: 'user',
    actor_id: null,
    actor_label: null,
    risk_level: 'high',
    created_at: '2026-05-03T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-05-03T00:00:00Z',
    ...overrides,
  } as PendingOperation
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

// ─── unlock_period ──────────────────────────────────────────────────
// No executor of its own: the registry's default branch runs the operation
// fiscal-periods.unlock (unlockFiscalPeriod over period-service unlockPeriod),
// the same run() the v1 endpoint and the dashboard use.

describe('commitPendingOperation: unlock_period', () => {
  const FP_ID = 'a8f1c2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d'

  it('happy path: clears locked_at and returns the period', async () => {
    const period = makeFiscalPeriod({ id: FP_ID, locked_at: null })
    vi.mocked(unlockPeriod).mockResolvedValueOnce(period)

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's pending_operations update

    const op = makePendingOp({
      operation_type: 'unlock_period',
      params: { fiscal_period_id: FP_ID },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ id: FP_ID, locked_at: null })
    expect(unlockPeriod).toHaveBeenCalledWith(expect.anything(), 'company-1', 'user-1', FP_ID)
  })

  it('rejects when fiscal_period_id is missing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's reject update
    const op = makePendingOp({ operation_type: 'unlock_period', params: {} })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.code).toBe('VALIDATION_ERROR')
    expect(unlockPeriod).not.toHaveBeenCalled()
  })

  it('answers the service refusal with its code', async () => {
    vi.mocked(unlockPeriod).mockRejectedValueOnce(codedRefusal('PERIOD_UNLOCK_NOT_LOCKED', 'Period is not locked'))

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's reject update
    const op = makePendingOp({
      operation_type: 'unlock_period',
      params: { fiscal_period_id: FP_ID },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).not.toBe('committed')
    expect(result.code).toBe('PERIOD_UNLOCK_NOT_LOCKED')
  })
})

// ─── undo_sie_import ────────────────────────────────────────────────
// No executor of its own: the operation imports.sie.undo runs
// (requestSIEImportAction), which queues the batch storno through the same
// requestSIEJobAction the hand-written executor called, after the owner/admin
// gate checks the approving user.

describe('commitPendingOperation: undo_sie_import', () => {
  const IMPORT_ID = '7ce91a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b'
  const job = { id: IMPORT_ID, job_state: 'completed', job_kind: 'import', job_phase: null, user_id: 'user-1', execution_actor_id: null, fiscal_period_id: null }

  it('queues the undo through requestSIEJobAction, as the old executor did', async () => {
    vi.mocked(requestSIEJobAction).mockResolvedValueOnce({ id: IMPORT_ID, job_state: 'undoing', job_phase: 'undo' } as never)
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: { id: 'op-1' } }, // CAS claim
      { data: job }, // sie_imports lookup
      { data: { role: 'owner' } }, // company_members: owner/admin gate
      { data: null }, // dispatcher commit update
    ])

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({ operation_type: 'undo_sie_import', params: { import_id: IMPORT_ID } }),
    )

    expect(result.status).toBe('committed')
    expect(requestSIEJobAction).toHaveBeenCalledWith(expect.anything(), 'company-1', 'user-1', IMPORT_ID, 'undo')
    expect(result.data).toMatchObject({ import_id: IMPORT_ID, action: 'undo', state: 'undoing', accepted: true })
  })

  it('refuses an approver who is not owner or admin before queueing anything', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: { id: 'op-1' } }, // CAS claim
      { data: job }, // sie_imports lookup
      { data: { role: 'member' } }, // company_members
      { data: null }, // dispatcher reject update
    ])

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({ operation_type: 'undo_sie_import', params: { import_id: IMPORT_ID } }),
    )

    expect(result.status).not.toBe('committed')
    expect(result.code).toBe('FORBIDDEN')
    expect(requestSIEJobAction).not.toHaveBeenCalled()
  })
})

// ─── lock_period: a year an SIE import still holds (crm#1029) ────────

describe('commitPendingOperation: lock_period on a year an SIE import holds', () => {
  it('answers with the stable code and the Swedish sentence, not UNKNOWN_ERROR', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: makeFiscalPeriod({ id: 'fp-1', name: 'Räkenskapsår 2024', import_hold: 'imp-1' }),
      error: null,
    }) // lockPeriod's period fetch
    enqueue({ data: null, error: null }) // dispatcher's reject update
    const op = makePendingOp({ operation_type: 'lock_period', params: { fiscal_period_id: 'fp-1' } })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
    expect(result.code).toBe('PERIOD_HAS_UNFINISHED_SIE_IMPORT')
    expect(result.error).toContain('Räkenskapsår 2024 kan inte låsas')
  })
})

// ─── create_customer ────────────────────────────────────────────────

describe('commitPendingOperation: create_customer', () => {
  it('inserts the staged customer_number', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // company_settings read (payment-terms default)
    enqueue({
      data: makeCustomer({ id: 'cust-1', customer_number: 'K-1001' }),
      error: null,
    }) // customers insert
    enqueue({ data: null, error: null }) // dispatcher's pending_operations update

    const op = makePendingOp({
      operation_type: 'create_customer',
      params: {
        name: 'Kund AB',
        customer_type: 'swedish_business',
        customer_number: 'K-1001',
        email: 'faktura@example.test',
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(findCall('customers', 'insert')?.[0]).toMatchObject({
      company_id: 'company-1',
      name: 'Kund AB',
      customer_number: 'K-1001',
      email: 'faktura@example.test',
    })
  })

  it('rejects a staged customer_number longer than 32 characters without inserting', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's reject update

    const op = makePendingOp({
      operation_type: 'create_customer',
      params: {
        name: 'Kund AB',
        customer_type: 'swedish_business',
        customer_number: 'X'.repeat(33),
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toMatch(/32/)
    expect(findCall('customers', 'insert')).toBeUndefined()
  })

  it('inserts customer_number as null when not staged', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // company_settings read (payment-terms default)
    enqueue({ data: makeCustomer({ id: 'cust-1' }), error: null }) // customers insert
    enqueue({ data: null, error: null }) // dispatcher's pending_operations update

    const op = makePendingOp({
      operation_type: 'create_customer',
      params: { name: 'Kund AB', customer_type: 'swedish_business' },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(findCall('customers', 'insert')?.[0]).toMatchObject({ customer_number: null })
  })

  // Synthetic personnummer, never a real one. Ciphertext shape enforced by
  // customers_personal_number_check (20260726110000).
  const PERSONAL_NUMBER = '19900101-1234'
  const CIPHERTEXT_SHAPE = /^[0-9a-f]{76,255}$/

  it('stores the staged personal_number_encrypted as the customer personal_number, with the staged payment terms', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    // payment_terms were resolved at staging, so no company_settings read here
    enqueue({ data: makeCustomer({ id: 'cust-1', customer_type: 'individual' }), error: null }) // customers insert
    enqueue({ data: null, error: null }) // dispatcher's pending_operations update

    const encrypted = encryptPersonnummer(PERSONAL_NUMBER)
    const op = makePendingOp({
      operation_type: 'create_customer',
      params: {
        name: 'Anna Andersson',
        customer_type: 'individual',
        payment_terms: 10,
        personal_number_encrypted: encrypted,
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(findCall('customers', 'insert')?.[0]).toMatchObject({
      personal_number: encrypted,
      org_number: null,
      default_payment_terms: 10,
    })
  })

  it('moves a personnummer staged as org_number on an individual into personal_number, encrypted', async () => {
    // An operation staged before gnubok_create_customer had a personal_number
    // input, committed after this deploy.
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // company_settings read (payment-terms default)
    enqueue({ data: makeCustomer({ id: 'cust-1', customer_type: 'individual' }), error: null }) // customers insert
    enqueue({ data: null, error: null }) // dispatcher's pending_operations update

    const op = makePendingOp({
      operation_type: 'create_customer',
      params: { name: 'Bertil Bengtsson', customer_type: 'individual', org_number: PERSONAL_NUMBER },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    const inserted = findCall('customers', 'insert')?.[0] as { org_number: string | null; personal_number: string | null }
    expect(inserted.org_number).toBeNull()
    expect(inserted.personal_number).toMatch(CIPHERTEXT_SHAPE)
    expect(decryptPersonnummer(inserted.personal_number!)).toBe(PERSONAL_NUMBER)
    expect(JSON.stringify(inserted)).not.toContain(PERSONAL_NUMBER)
  })

  it('still refuses a personnummer-shaped org_number on a foreign business customer', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's reject update

    const op = makePendingOp({
      operation_type: 'create_customer',
      params: { name: 'Auslandsfirma GmbH', customer_type: 'eu_business', org_number: PERSONAL_NUMBER },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(findCall('customers', 'insert')).toBeUndefined()
  })

  // #2367: a Swedish enskild firma has no org number of its own, so its
  // owner's personnummer is the firm's org number and is stored as one.
  it('commits a personnummer-shaped org_number on swedish_business as the org number', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // company_settings read (payment-terms default)
    enqueue({ data: makeCustomer({ id: 'cust-1' }), error: null }) // customers insert
    enqueue({ data: null, error: null }) // dispatcher's pending_operations update

    const op = makePendingOp({
      operation_type: 'create_customer',
      params: { name: 'Enskild Firma X', customer_type: 'swedish_business', org_number: PERSONAL_NUMBER },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    const inserted = findCall('customers', 'insert')?.[0] as {
      org_number: string | null
      personal_number: string | null
    }
    expect(inserted.org_number).toBe(PERSONAL_NUMBER)
    expect(inserted.personal_number).toBeNull()
  })
})

describe('commitPendingOperation: credit-note issuance guard', () => {
  it('rejects mark_invoice_sent before the ordinary invoice executor can book it', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: makeInvoice({
        id: 'credit-1',
        status: 'draft',
        credited_invoice_id: 'invoice-1',
      }),
      error: null,
    })
    enqueue({ data: null, error: null }) // dispatcher's rejected update

    const op = makePendingOp({
      operation_type: 'mark_invoice_sent',
      params: { invoice_id: 'credit-1' },
    })

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      op,
    )

    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
    expect(result.error).toContain('Credit notes must be issued')
  })

  it('records delivery history when a regular invoice is marked as sent', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: makeInvoice({
        id: 'invoice-1',
        status: 'draft',
        invoice_number: 'F-2026001',
        credited_invoice_id: null,
      }),
      error: null,
    })
    enqueue({
      data: { accounting_method: 'cash', entity_type: 'enskild_firma', bankgiro: '123-4567' },
      error: null,
    })
    enqueue({ data: [{ id: 'invoice-1' }], error: null }) // status flip draft -> sent (compare-and-set)
    enqueue({ data: null, error: null }) // dispatcher update

    const op = makePendingOp({
      operation_type: 'mark_invoice_sent',
      params: { invoice_id: 'invoice-1' },
    })

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      op,
    )

    expect(result.status).toBe('committed')
    expect(mockRecordManualInvoiceDelivery).toHaveBeenCalledWith({
      supabase,
      companyId: 'company-1',
      userId: 'user-1',
      invoiceId: 'invoice-1',
    })
  })

  it.each(['SEK', 'EUR'] as const)(
    'rejects a %s invoice without a payment account before number allocation',
    async (currency) => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: makeInvoice({
        id: 'invoice-1',
        status: 'draft',
        invoice_number: null,
        credited_invoice_id: null,
        currency,
      }),
      error: null,
    })
    enqueue({ data: { invoice_payment_accounts: {} }, error: null })
    enqueue({ data: null, error: null }) // dispatcher rejected update

    const op = makePendingOp({
      operation_type: 'mark_invoice_sent',
      params: { invoice_id: 'invoice-1' },
    })

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      op,
    )

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(ensureInvoiceNumber).not.toHaveBeenCalled()
    expect(mockRecordManualInvoiceDelivery).not.toHaveBeenCalled()
    },
  )
})

describe('commitPendingOperation: invoice send payment account guard', () => {
  it.each(['SEK', 'EUR'] as const)(
    'rejects a %s invoice before delivery reservation and number allocation',
    async (currency) => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: makeInvoice({
        id: 'invoice-1',
        status: 'draft',
        invoice_number: null,
        currency,
        customer: makeCustomer({ id: 'customer-1', email: 'customer@example.test' }),
        items: [],
      }),
      error: null,
    })
    enqueue({
      data: {
        company_name: 'Test AB',
        invoice_payment_accounts: {},
      },
      error: null,
    })
    enqueue({ data: null, error: null }) // dispatcher's rejected update

    const op = makePendingOp({
      operation_type: 'send_invoice',
      params: { invoice_id: 'invoice-1' },
    })

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      op,
    )

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(ensureInvoiceNumber).not.toHaveBeenCalled()
    expect(supabase.from).not.toHaveBeenCalledWith('invoice_deliveries')
    },
  )
})

describe('commitPendingOperation: seller VAT number guard', () => {
  it('rejects mark_invoice_sent for a registered company without VAT number', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: makeInvoice({
        id: 'invoice-1',
        status: 'draft',
        invoice_number: null,
        credited_invoice_id: null,
      }),
      error: null,
    })
    enqueue({
      data: { bankgiro: '123-4567', vat_registered: true, vat_number: null },
      error: null,
    })
    enqueue({ data: null, error: null }) // dispatcher rejected update

    const op = makePendingOp({
      operation_type: 'mark_invoice_sent',
      params: { invoice_id: 'invoice-1' },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(ensureInvoiceNumber).not.toHaveBeenCalled()
    expect(mockRecordManualInvoiceDelivery).not.toHaveBeenCalled()
  })

  it('rejects send_invoice for a registered company without VAT number', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: makeInvoice({
        id: 'invoice-1',
        status: 'draft',
        invoice_number: null,
        customer: makeCustomer({ id: 'customer-1', email: 'customer@example.test' }),
        items: [],
      }),
      error: null,
    })
    enqueue({
      data: {
        company_name: 'Test AB',
        bankgiro: '123-4567',
        vat_registered: true,
        vat_number: null,
      },
      error: null,
    })
    enqueue({ data: null, error: null }) // dispatcher's rejected update

    const op = makePendingOp({
      operation_type: 'send_invoice',
      params: { invoice_id: 'invoice-1' },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(ensureInvoiceNumber).not.toHaveBeenCalled()
    expect(supabase.from).not.toHaveBeenCalledWith('invoice_deliveries')
  })
})

describe('commitPendingOperation: invoice send recipient limit', () => {
  it('rejects an oversized configured recipient set before reservation and allocation', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: makeInvoice({
        id: 'invoice-1',
        status: 'draft',
        invoice_number: null,
        customer: makeCustomer({ id: 'customer-1', email: 'customer@example.test' }),
        items: [],
      }),
      error: null,
    })
    enqueue({
      data: {
        company_name: 'Test AB',
        bankgiro: '123-4567',
        invoice_email_cc_addresses: Array.from(
          { length: 20 },
          (_, index) => `fixed-${index}@example.test`,
        ),
        invoice_email_bcc_addresses: [],
      },
      error: null,
    })
    enqueue({ data: null, error: null }) // dispatcher's rejected update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({
        operation_type: 'send_invoice',
        params: { invoice_id: 'invoice-1' },
      }),
    )

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(mockReserveInvoiceDelivery).not.toHaveBeenCalled()
    expect(ensureInvoiceNumber).not.toHaveBeenCalled()
  })
})

// ─── post_annual_depreciation ───────────────────────────────────────

describe('commitPendingOperation: post_annual_depreciation', () => {
  it('happy path: routes to commitAnnualPostings and returns the posted entries', async () => {
    vi.mocked(commitAnnualPostings).mockResolvedValueOnce({
      posted: [
        { assetId: 'asset-1', entry: { id: 'je-1', voucher_number: 7 } as never, scheduleId: 'sch-1' },
      ],
      skipped: [],
    })

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher update

    const op = makePendingOp({
      operation_type: 'post_annual_depreciation',
      params: { fiscal_period_id: 'fp-1', asset_ids: ['asset-1'] },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({
      posted_count: 1,
      skipped_count: 0,
      posted: [{ asset_id: 'asset-1', journal_entry_id: 'je-1', voucher_number: 7, schedule_id: 'sch-1' }],
    })
    expect(commitAnnualPostings).toHaveBeenCalledWith(
      expect.anything(), 'company-1', 'user-1', 'fp-1', { assetIds: ['asset-1'] }
    )
  })

  it('rejects with 400 when fiscal_period_id is missing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // reject update
    const op = makePendingOp({ operation_type: 'post_annual_depreciation', params: {} })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(commitAnnualPostings).not.toHaveBeenCalled()
  })

  it('surfaces engine errors (e.g. locked period) as a failed commit', async () => {
    vi.mocked(commitAnnualPostings).mockRejectedValueOnce(new Error('Period is locked or closed'))
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // reject update
    const op = makePendingOp({
      operation_type: 'post_annual_depreciation',
      params: { fiscal_period_id: 'fp-1' },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/locked or closed/)
  })
})

// ─── create_transaction ─────────────────────────────────────────────

describe('commitPendingOperation: create_transaction', () => {
  // The stored row, its dedup and its kassakonto binding: the executor runs
  // the shared ingest pipeline, covered in create-transaction-ingest.test.ts.
  it('rejects with 400 when required fields are missing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's reject update

    const op = makePendingOp({
      operation_type: 'create_transaction',
      params: { date: '2026-05-01' }, // missing amount + description
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
  })

  it('rejects a non-19xx ledger_account with 400', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's reject update

    const op = makePendingOp({
      operation_type: 'create_transaction',
      params: {
        date: '2026-05-01',
        amount: -200,
        description: 'WISE KORT ST',
        ledger_account: '3001',
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toMatch(/19xx cash account/)
  })
})

// ─── import_sie ─────────────────────────────────────────────────────

describe('commitPendingOperation: import_sie', () => {
  it('happy path: parses, imports, returns committed with summary', async () => {
    vi.mocked(parseSIEFile).mockReturnValueOnce({} as never)
    vi.mocked(submitSIEJob).mockResolvedValueOnce({id:'imp-1',fiscal_period_id:'fp-1',job_state:'queued'} as never)

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's update

    const op = makePendingOp({
      operation_type: 'import_sie',
      params: {
        file_content: '#FLAGGA 0\n',
        filename: 'test.sie',
        mappings: [],
        create_fiscal_period: true,
        import_opening_balances: true,
        import_transactions: true,
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({
      import_id: 'imp-1',
      accepted:true,state:'queued',status_tool:'gnubok_sie_import_status',
    })
    expect(parseSIEFile).not.toHaveBeenCalled()
    // Operations staged before update_account_names existed (params without
    // the key) must default to true: Boolean(undefined) would flip it off.
    expect(submitSIEJob).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.anything(),
      [],
      expect.objectContaining({ updateAccountNames: true }),
      undefined,
      'sie_file',
      expect.objectContaining({ source: 'sie', via: 'mcp' }),
    )
  })

  it('passes update_account_names: false through to submitSIEJob', async () => {
    vi.mocked(parseSIEFile).mockReturnValueOnce({} as never)
    vi.mocked(submitSIEJob).mockResolvedValueOnce({id:'imp-1',fiscal_period_id:'fp-1',job_state:'queued'} as never)

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's update

    const op = makePendingOp({
      operation_type: 'import_sie',
      params: {
        file_content: '#FLAGGA 0\n',
        filename: 'test.sie',
        mappings: [],
        create_fiscal_period: true,
        import_opening_balances: true,
        import_transactions: true,
        update_account_names: false,
      },
    })

    await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(submitSIEJob).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.anything(),
      [],
      expect.objectContaining({ updateAccountNames: false }),
      undefined,
      'sie_file',
      expect.objectContaining({ source: 'sie', via: 'mcp' }),
    )
  })

  // #63: only a literal true reaches the job; submitSIEJob drops the
  // unused definitions' mappings.
  it.each([[true, true], ['true', undefined], [undefined, undefined]])(
    'passes only_used_accounts %j to submitSIEJob as onlyUsedAccounts %j',
    async (param, expected) => {
      vi.mocked(submitSIEJob).mockResolvedValueOnce({id:'imp-1',fiscal_period_id:'fp-1',job_state:'queued'} as never)
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
      enqueue({ data: null, error: null }) // dispatcher's update

      const op = makePendingOp({
        operation_type: 'import_sie',
        params: {
          file_content: '#FLAGGA 0\n',
          filename: 'test.sie',
          mappings: [],
          ...(param === undefined ? {} : { only_used_accounts: param }),
        },
      })

      await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

      expect(vi.mocked(submitSIEJob).mock.calls.at(-1)?.[5].onlyUsedAccounts).toBe(expected)
    },
  )

  it.each([
    [true, true],
    [undefined, false],
    ['true', false],
  ])('passes confirm_org_number_mismatch=%s through to submitSIEJob as %s', async (param, expected) => {
    vi.mocked(submitSIEJob).mockResolvedValueOnce({id:'imp-1',fiscal_period_id:'fp-1',job_state:'queued'} as never)

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's update

    const op = makePendingOp({
      operation_type: 'import_sie',
      params: {
        file_content: '#FLAGGA 0\n',
        filename: 'test.sie',
        mappings: [],
        ...(param === undefined ? {} : { confirm_org_number_mismatch: param }),
      },
    })

    await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    // Only a literal true confirms: submitSIEJob re-checks the file's #ORGNR.
    expect(submitSIEJob).toHaveBeenCalledWith(
      expect.anything(), 'company-1', 'user-1', expect.anything(), [],
      expect.objectContaining({ confirmOrgNumberMismatch: expected }), undefined, 'sie_file',
      expect.objectContaining({ source: 'sie', via: 'mcp' }),
    )
  })

  // Absent flags take the job's defaults (import everything); a row staged
  // before stored explicit booleans and commits exactly as approved.
  it.each([
    ['absent flags', {}, { createFiscalPeriod: true, importOpeningBalances: true, importTransactions: true }],
    [
      'explicit false (an old row that omitted them)',
      { create_fiscal_period: false, import_opening_balances: false, import_transactions: true },
      { createFiscalPeriod: false, importOpeningBalances: false, importTransactions: true },
    ],
  ])('%s', async (_label, flags, expected) => {
    vi.mocked(submitSIEJob).mockResolvedValueOnce({id:'imp-1',fiscal_period_id:'fp-1',job_state:'queued'} as never)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's update

    const op = makePendingOp({
      operation_type: 'import_sie',
      params: { file_content: '#FLAGGA 0\n', filename: 'test.sie', mappings: [], ...flags },
    })
    await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(submitSIEJob).toHaveBeenCalledWith(
      expect.anything(), 'company-1', 'user-1', expect.anything(), [],
      expect.objectContaining(expected), undefined, 'sie_file',
      expect.objectContaining({ source: 'sie', via: 'mcp' }),
    )
  })

  it('rejects when required params are missing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's reject update
    const op = makePendingOp({ operation_type: 'import_sie', params: { filename: 'x.sie' } })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(parseSIEFile).not.toHaveBeenCalled()
  })

  it('returns the submitSIEJob errors when success=false', async () => {
    vi.mocked(parseSIEFile).mockReturnValueOnce({} as never)
    vi.mocked(submitSIEJob).mockRejectedValueOnce(new Error('duplicate import'))

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's reject update
    const op = makePendingOp({
      operation_type: 'import_sie',
      params: {
        file_content: '#FLAGGA 0\n',
        filename: 'test.sie',
        mappings: [],
        create_fiscal_period: true,
        import_opening_balances: false,
        import_transactions: true,
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/duplicate import/)
  })

  // crm#1272: the approval answered the database's English ("Existing SIE
  // import requires reviewed replacement or reconciliation") with no code,
  // so the agent had nothing to act on.
  const sieOp = (importOpeningBalances: boolean) => makePendingOp({
    operation_type: 'import_sie',
    params: {
      file_content: '#FLAGGA 0\n', filename: 'test.sie', mappings: [],
      create_fiscal_period: true, import_opening_balances: importOpeningBalances, import_transactions: true,
    },
  })

  it('answers a year that already has a booked IB with its code, the sentence and the way out', async () => {
    const sentence = 'Räkenskapsåret 2026-01-01 till 2026-12-31 har redan en bokförd ingående balans (verifikation A1, 2026-01-01), ' +
      'och importen skulle bokföra filens ingående balans en gång till. Importera filen utan ingående balanser.'
    vi.mocked(submitSIEJob).mockRejectedValueOnce(jobDatabaseError({
      code: '55000', message: `SIE_IMPORT_PERIOD_HAS_OPENING_BALANCE: ${sentence}`,
    }))
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's reject update

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', sieOp(true))

    expect(result).toMatchObject({
      status: 'rejected',
      http_status: 409,
      code: 'SIE_IMPORT_PERIOD_HAS_OPENING_BALANCE',
      error: sentence,
      data: { remediation: { tool: 'gnubok_import_sie', args: { import_opening_balances: false } } },
    })
  })

  it('answers an earlier import of the year with the registry sentence, not the database English', async () => {
    vi.mocked(submitSIEJob).mockRejectedValueOnce(jobDatabaseError({
      code: '55000', message: 'Existing SIE import requires reviewed replacement or reconciliation',
    }))
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's reject update

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', sieOp(false))

    expect(result).toMatchObject({ status: 'rejected', code: 'SIE_IMPORT_PERIOD_ALREADY_IMPORTED' })
    expect(result.error).toMatch(/^Räkenskapsåret har redan importerats/)
    expect(result.data).toMatchObject({ remediation: { tool: 'gnubok_sie_import_status' } })
  })

  // Issue #108: an append staged with on_existing_year reaches the job as
  // onExistingPeriod 'append'; its refusal answers with the planner's sentence.
  const appendOp = (extra: Record<string, unknown> = {}) => makePendingOp({
    operation_type: 'import_sie',
    params: { file_content: '#FLAGGA 0\n', filename: 'append.se', mappings: [], on_existing_year: 'append', ...extra },
  })

  it('submits an append with its possible-duplicate choice', async () => {
    vi.mocked(submitSIEJob).mockResolvedValueOnce({ id: 'imp-2', fiscal_period_id: 'fp-1', job_state: 'queued' } as never)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's update

    await commitPendingOperation(supabase as never, 'user-1', 'company-1', appendOp({ include_possible_duplicates: true }))

    expect(vi.mocked(submitSIEJob).mock.calls[0][5]).toMatchObject({ onExistingPeriod: 'append', includePossibleDuplicates: true })
  })

  it('answers an append refusal with its code and the sentence naming the vouchers', async () => {
    const { SIEJobValidationError: RealError } = await vi.importActual<typeof import('@/lib/import/sie-jobs')>('@/lib/import/sie-jobs')
    const { userFacing } = await import('@/lib/errors/user-facing')
    const sentence = '1 av filens verifikationer har samma nummer som bokförda verifikationer men annat innehåll: A2.'
    vi.mocked(submitSIEJob).mockRejectedValueOnce(
      userFacing(new RealError(sentence, 'SIE_IMPORT_APPEND_CONFLICT', { conflicts: [] }), 'SIE_IMPORT_APPEND_CONFLICT'))
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's reject update

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', appendOp())

    expect(result).toMatchObject({ status: 'rejected', http_status: 409, code: 'SIE_IMPORT_APPEND_CONFLICT', error: sentence })
  })
})

// ─── credit_invoice ─────────────────────────────────────────────────

describe('commitPendingOperation: credit_invoice', () => {
  // The credit itself (the mirrored credit note, the reversal, the period
  // checked first, fail closed) runs in creditInvoice and is pinned in
  // lib/invoices/__tests__/credit-invoice.test.ts; the executor's mapping in
  // credit-invoice-executor.test.ts. These refusals run through both.
  it('auto-rejects when invoice is already credited (409)', async () => {
    const original = makeInvoice({ id: 'inv-1', status: 'credited', document_type: 'invoice' })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: { ...original, items: [] }, error: null })
    // dispatcher auto-reject path also does an update
    enqueue({ data: null, error: null })

    const op = makePendingOp({
      operation_type: 'credit_invoice',
      params: { invoice_id: 'inv-1' },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('rejected')
    expect(result.auto_rejected).toBe(true)
    expect(result.http_status).toBe(409)
  })

  it('rejects when invoice_id is missing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's reject update
    const op = makePendingOp({ operation_type: 'credit_invoice', params: {} })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
  })

  it('rejects invoices with status outside sent/paid/overdue', async () => {
    const original = makeInvoice({ id: 'inv-1', status: 'draft', document_type: 'invoice' })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: { ...original, items: [] }, error: null })
    enqueue({ data: null, error: null }) // dispatcher's reject update

    const op = makePendingOp({
      operation_type: 'credit_invoice',
      params: { invoice_id: 'inv-1' },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
  })
})

// ─── credit_supplier_invoice ────────────────────────────────────────

describe('commitPendingOperation: credit_supplier_invoice', () => {
  it('normalizes copied storage and reverses with the untouched original items', async () => {
    const originalItems = [
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
        dimensions: {},
      },
    ]
    const original = {
      // The header its rows add up to: the credit is refused otherwise.
      ...makeSupplierInvoice({ id: 'supplier-invoice-1', status: 'registered', subtotal: 1000, vat_amount: 250, total: 1250 }),
      supplier: { name: 'Office Depot AB', supplier_type: 'swedish_business' },
      items: originalItems,
    }
    const creditNote = makeSupplierInvoice({
      id: 'supplier-credit-1',
      is_credit_note: true,
      credited_invoice_id: original.id,
    })
    const { supabase, enqueueMany, findCall } = createQueuedMockSupabase()
    // The shared credit service (lib/supplier-invoices/credit.ts) reads the
    // original, checks the period lock and the method, then writes.
    enqueueMany([
      { data: { id: 'op-1' }, error: null }, // CAS claim
      { data: original, error: null },
      { data: { bookkeeping_locked_through: null }, error: null }, // lock date
      { data: null, error: null }, // fiscal period: none covering, not locked
      { data: { accounting_method: 'accrual' }, error: null },
      { data: 2, error: null }, // arrival number
      { data: creditNote, error: null }, // credit note insert
      { data: null, error: null }, // items insert
      { data: null, error: null }, // link the verifikat
      { data: { id: original.id }, error: null }, // flip the original
      { data: null, error: null },
      { data: null, error: null },
      { data: null, error: null },
    ])
    vi.mocked(createSupplierCreditNoteEntry).mockResolvedValueOnce({ id: 'je-1' } as never)

    const op = makePendingOp({
      operation_type: 'credit_supplier_invoice',
      params: { supplier_invoice_id: original.id },
    })
    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      op,
    )

    expect(result.status).toBe('committed')
    const insertArgs = findCall('supplier_invoice_items', 'insert')
    const insertedItems = insertArgs?.[0] as Array<{ vat_rate: number }>
    expect(insertedItems[0]?.vat_rate).toBe(0.25)
    expect(createSupplierCreditNoteEntry).toHaveBeenCalledWith(
      supabase,
      'company-1',
      'user-1',
      expect.objectContaining({ id: creditNote.id }),
      originalItems,
      'swedish_business',
      'Office Depot AB',
      original.total, // the original's payable, which the reversal must match
      expect.any(Function), // what the door saw, read by the posting port only while POSTING_EVENTS is on
    )
  })

  it('refuses a partial inbox credit note at commit and writes nothing', async () => {
    const original = {
      ...makeSupplierInvoice({ id: 'supplier-invoice-1', status: 'registered', total: 1250 }),
      supplier: { name: 'Office Depot AB', supplier_type: 'swedish_business' },
      items: [],
    }
    const { supabase, enqueueMany, findCall } = createQueuedMockSupabase()
    enqueueMany([
      { data: { id: 'op-1' }, error: null },
      { data: original, error: null },
      {
        data: {
          id: 'inbox-1',
          document_id: null,
          matched_supplier_id: null,
          created_supplier_invoice_id: null,
          created_journal_entry_id: null,
          extracted_data: { documentKind: 'credit_note', invoice: { currency: 'SEK' }, totals: { total: -250 } },
        },
        error: null,
      },
      { data: null, error: null },
    ])

    const op = makePendingOp({
      operation_type: 'credit_supplier_invoice',
      params: { supplier_invoice_id: original.id, inbox_item_id: '66666666-6666-4666-8666-666666666666' },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.code).toBe('SI_CREDIT_PARTIAL')
    // The figures the remediation points at reach the approver.
    expect(result.data).toMatchObject({ credit_total: 250, invoice_total: 1250 })
    expect(findCall('supplier_invoices', 'insert')).toBeUndefined()
  })

  it('rejects a staged credit whose rows do not add up, with both figures and no ankomstnummer drawn', async () => {
    // Staged before the rows were held to the invoice, or changed since: an
    // invoice without rows gives the reversal nothing to take off 2440.
    const original = {
      ...makeSupplierInvoice({ id: 'supplier-invoice-1', status: 'registered', total: 1250 }),
      supplier: { name: 'Office Depot AB', supplier_type: 'swedish_business' },
      items: [],
    }
    const { supabase, enqueueMany, findCall, calls } = createQueuedMockSupabase()
    enqueueMany([
      { data: { id: 'op-1' }, error: null }, // CAS claim
      { data: original, error: null },
      { data: { bookkeeping_locked_through: null }, error: null }, // lock date
      { data: null, error: null }, // fiscal period: none covering, not locked
      { data: { accounting_method: 'accrual' }, error: null },
      { data: null, error: null }, // the dispatcher's reject update
    ])

    const op = makePendingOp({
      operation_type: 'credit_supplier_invoice',
      params: { supplier_invoice_id: original.id },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('rejected')
    expect(result.auto_rejected).toBe(true)
    expect(result.http_status).toBe(409)
    expect(result.code).toBe('SI_CREDIT_ROWS_MISMATCH')
    expect(result.data).toEqual({ rows_payable_sek: 0, invoice_payable_sek: 1250 })
    // ...and are kept on the operation for whoever reads it later.
    const rejected = calls
      .filter((c) => c.table === 'pending_operations' && c.method === 'update')
      .map((c) => c.args[0] as { status?: string; result_data?: Record<string, unknown> })
      .find((payload) => payload.status === 'rejected')
    expect(rejected?.result_data).toMatchObject({
      error_code: 'SI_CREDIT_ROWS_MISMATCH',
      details: { rows_payable_sek: 0, invoice_payable_sek: 1250 },
    })
    expect(calls.some((c) => c.table === 'rpc:get_next_arrival_number')).toBe(false)
    expect(findCall('supplier_invoices', 'insert')).toBeUndefined()
    expect(createSupplierCreditNoteEntry).not.toHaveBeenCalled()
  })
})

// ─── attach_document_to_transaction ─────────────────────────────────

describe('commitPendingOperation: attach_document_to_transaction', () => {
  // No executor of its own: the operation transactions.attach-document runs
  // (lib/transactions/document-attach.ts), whose input takes uuids.
  const TX = '1f2e3d4c-5b6a-4978-8a6b-5c4d3e2f1a0b'
  const DOC = '4f1c2b3a-4d5e-4f60-8a9b-0c1d2e3f4a5b'
  const baseOp: Partial<PendingOperation> = {
    operation_type: 'attach_document_to_transaction',
    params: { transaction_id: TX, document_id: DOC },
  }

  it('auto-rejects 404 when transaction is not in the company', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // tx fetch: not found
    enqueue({ data: null, error: null }) // dispatcher reject update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp(baseOp),
    )
    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(404)
  })

  it('auto-rejects 409 when existing pinned doc is räkenskapsinformation', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: { id: TX, document_id: 'doc-old', journal_entry_id: null }, error: null })
    enqueue({ data: { journal_entry_id: 'je-99' }, error: null }) // existing doc fetch: locked
    enqueue({ data: null, error: null }) // dispatcher reject update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp(baseOp),
    )
    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
  })

  it('translates BFL_DOCUMENT_IMMUTABILITY trigger error into auto-reject 409', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: { id: TX, document_id: null, journal_entry_id: null }, error: null })
    enqueue({ data: { id: DOC }, error: null }) // doc fetch
    enqueue({
      data: null,
      error: {
        code: 'P0001',
        message: 'BFL_DOCUMENT_IMMUTABILITY: cannot detach or swap document …',
      },
    })
    enqueue({ data: null, error: null }) // dispatcher reject update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp(baseOp),
    )
    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
  })

  it('happy path uncategorized: attaches without propagation', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: { id: TX, document_id: null, journal_entry_id: null }, error: null })
    enqueue({ data: { id: DOC }, error: null }) // doc fetch
    enqueue({ data: { journal_entry_id: null }, error: null }) // UPDATE returning
    enqueue({ data: null, error: null }) // invoice_inbox_items best-effort link
    enqueue({ data: [], error: null }) // voucher-link resolution: not bulk-booked either
    enqueue({ data: null, error: null }) // dispatcher commit update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp(baseOp),
    )
    expect(result.status).toBe('committed')
  })

  it('propagates to journal entry when tx was categorized between staging and commit', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: { id: TX, document_id: null, journal_entry_id: null }, error: null })
    enqueue({ data: { id: DOC }, error: null }) // doc fetch
    enqueue({ data: { journal_entry_id: 'je-7' }, error: null }) // UPDATE returning post-state
    enqueue({ data: null, error: null }) // invoice_inbox_items best-effort link
    enqueue({ data: null, error: null }) // doc propagation update
    enqueue({ data: { document_id: null }, error: null }) // completion: tx pin lookup
    enqueue({ data: [], error: null }) // completion: matched inbox items (none)
    enqueue({ data: null, error: null }) // dispatcher commit update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp(baseOp),
    )
    expect(result.status).toBe('committed')
  })

  it('completes matched inbox items when the tx is anchored via a bulk-book samlingsverifikat', async () => {
    // A bulk-booked tx keeps transactions.journal_entry_id null: the verifikat
    // hangs off transaction_voucher_links. Attaching a hunted receipt to it
    // must still resolve the matched inbox item, or it strands as "linked"
    // forever (the 2026-08-12 report).
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: { id: TX, document_id: null, journal_entry_id: null }, error: null })
    enqueue({ data: { id: DOC }, error: null }) // doc fetch
    enqueue({ data: { journal_entry_id: null }, error: null }) // UPDATE returning (still null)
    enqueue({ data: null, error: null }) // invoice_inbox_items best-effort link
    enqueue({ data: [{ transaction_id: TX, journal_entry_id: 'je-9' }], error: null }) // voucher links
    enqueue({ data: { document_id: null }, error: null }) // propagation: tx pin lookup
    enqueue({ data: [{ id: 'inbox-9', document_id: null }], error: null }) // matched inbox items
    enqueue({ data: null, error: null }) // created_journal_entry_id stamp
    enqueue({ data: null, error: null }) // dispatcher commit update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp(baseOp),
    )
    expect(result.status).toBe('committed')
    expect(findCalls('invoice_inbox_items', 'update')).toContainEqual([
      { created_journal_entry_id: 'je-9' },
    ])
  })

  it('still commits when the inbox-link best-effort update errors', async () => {
    // Inbox sync is best-effort: a failure to mark the inbox row as matched
    // must not roll back the (compliant) doc→tx attach. Mirrors the REST
    // route's swallow-and-log behaviour. The Supabase client resolves with
    // { error } rather than rejecting, so we both confirm the op commits AND
    // that the error was actually inspected and logged (not silently dropped).
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: { id: TX, document_id: null, journal_entry_id: null }, error: null })
    enqueue({ data: { id: DOC }, error: null }) // doc fetch
    enqueue({ data: { journal_entry_id: null }, error: null }) // tx UPDATE returning
    enqueue({ data: null, error: { message: 'inbox row missing or RLS-blocked' } }) // inbox link: errors
    enqueue({ data: [], error: null }) // voucher-link resolution: not bulk-booked either
    enqueue({ data: null, error: null }) // dispatcher commit update

    // The executor now runs lib/transactions/document-attach.ts, which logs
    // the failure through the structured logger (coded cause) instead of
    // console.error, so the assertion is on the outcome only.
    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp(baseOp),
    )
    expect(result.status).toBe('committed')
  })

  it('touches the invoice_inbox_items table to sync matched_transaction_id', async () => {
    // Argument-level check that the executor actually reaches into
    // invoice_inbox_items to keep the inbox UI in sync with the staged-write
    // path. Otherwise the inbox row stays in "Behöver åtgärd" forever.
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: { id: TX, document_id: null, journal_entry_id: null }, error: null })
    enqueue({ data: { id: DOC }, error: null }) // doc fetch
    enqueue({ data: { journal_entry_id: null }, error: null }) // tx UPDATE returning
    enqueue({ data: null, error: null }) // invoice_inbox_items link
    enqueue({ data: null, error: null }) // dispatcher commit update

    await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp(baseOp),
    )
    const tablesTouched = (supabase.from as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0])
    expect(tablesTouched).toContain('invoice_inbox_items')
  })

  it('auto-rejects 409 when the document already belongs to a different verifikation', async () => {
    // Without this guard the attach would pin a consumed doc (undetachable
    // per the transactions immutability trigger) and the later propagation
    // would corrupt or be blocked by the doc-metadata immutability trigger.
    // Mirrors the REST route's guard.
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: { id: TX, document_id: null, journal_entry_id: 'je-1' }, error: null })
    enqueue({ data: { id: DOC, journal_entry_id: 'je-OTHER' }, error: null }) // doc fetch
    enqueue({ data: null, error: null }) // dispatcher reject update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp(baseOp),
    )
    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
  })

  it('skips the propagation write on an idempotent re-attach (doc already on the same verifikation)', async () => {
    // The period-lock trigger raises on ANY journal_entry_id write: even a
    // same-value rewrite: so an unconditional re-run would fail an otherwise
    // idempotent re-attach once the period locks.
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: { id: TX, document_id: DOC, journal_entry_id: 'je-1' }, error: null })
    enqueue({ data: { id: DOC, journal_entry_id: 'je-1' }, error: null }) // doc fetch: same JE
    enqueue({ data: { journal_entry_id: 'je-1' }, error: null }) // tx UPDATE returning
    enqueue({ data: null, error: null }) // invoice_inbox_items link
    enqueue({ data: null, error: null }) // dispatcher commit update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp(baseOp),
    )
    expect(result.status).toBe('committed')
    // document_attachments touched once (the doc fetch): no propagation write.
    const tablesTouched = (supabase.from as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0])
    expect(tablesTouched.filter((t) => t === 'document_attachments')).toHaveLength(1)
  })

  it('maps a period-lock propagation failure to auto-reject 409', async () => {
    // A retry could never succeed until the period is unlocked, so the
    // generic 500 "försök igen" would be a false promise. Mirrors the REST
    // route's mapping.
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: { id: TX, document_id: null, journal_entry_id: null }, error: null })
    enqueue({ data: { id: DOC, journal_entry_id: null }, error: null }) // doc fetch
    enqueue({ data: { journal_entry_id: 'je-7' }, error: null }) // tx UPDATE returning: booked meanwhile
    enqueue({ data: null, error: null }) // invoice_inbox_items link
    enqueue({
      data: null,
      error: { message: 'cannot link document in a locked/closed fiscal period' },
    }) // propagation blocked by enforce_period_lock
    enqueue({ data: null, error: null }) // dispatcher reject update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp(baseOp),
    )
    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
  })
})

// ─── link_document_to_voucher ─────────────────────────────────

describe('commitPendingOperation: link_document_to_voucher', () => {
  const baseOp: Partial<PendingOperation> = {
    operation_type: 'link_document_to_voucher',
    params: { document_id: 'doc-1', journal_entry_id: 'je-1' },
  }

  beforeEach(() => {
    logWarn.mockClear()
  })

  it('auto-rejects 404 when document is not in the company', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null })            // doc fetch: not found
    enqueue({ data: { id: 'je-1' }, error: null })                              // shared check: the verifikat
    enqueue({ data: null, error: null })            // dispatcher reject update

    const result = await commitPendingOperation(
      supabase as never, 'user-1', 'company-1', makePendingOp(baseOp),
    )
    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(404)
  })

  it('auto-rejects 409 when doc is already linked to a different posted JE (WORM guard)', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })                              // CAS claim
    enqueue({ data: { id: 'doc-1', journal_entry_id: 'je-OTHER' }, error: null }) // doc fetch
    enqueue({ data: { id: 'je-1' }, error: null })                              // shared check: the verifikat
    enqueue({ data: { status: 'posted', voucher_series: 'A', voucher_number: 12 }, error: null }) // holder
    enqueue({ data: null, error: null })                                         // dispatcher reject update

    const result = await commitPendingOperation(
      supabase as never, 'user-1', 'company-1', makePendingOp(baseOp),
    )
    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
    expect(result.error).toMatch(/^Bilagan är redan kopplad till verifikation A12 /)
    expect(result.error).toMatch(/rätta den \(Rätta, correct_entry\)/)
    // Refused before any write: the document row is never updated.
    expect(findCall('document_attachments', 'update')).toBeUndefined()
  })

  it('auto-rejects 409 with a Swedish reason, not a 500, when the holder is a reversed verifikat (feedback seq 932068)', async () => {
    // The immutability trigger refuses any change of a set journal_entry_id,
    // whatever the holder's status. The guard used to refuse only a posted
    // holder, so a document on a reversed verifikat passed staging and died
    // at commit on the raw trigger text as HTTP 500 "Något gick fel".
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })                              // CAS claim
    enqueue({ data: { id: 'doc-1', journal_entry_id: 'je-REVERSED' }, error: null }) // doc fetch
    enqueue({ data: { id: 'je-1' }, error: null })                              // shared check: the verifikat
    enqueue({ data: { status: 'reversed', voucher_series: 'a', voucher_number: 57 }, error: null }) // holder
    enqueue({ data: null, error: null })                                         // dispatcher reject update

    const result = await commitPendingOperation(
      supabase as never, 'user-1', 'company-1', makePendingOp(baseOp),
    )
    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
    expect(result.error).toMatch(/^Bilagan är redan kopplad till verifikation A57 och kan inte flyttas/)
    expect(result.error).toMatch(/makulerad/)
    expect(result.error).toMatch(/Rätta \(correct_entry\)/)
    expect(findCall('document_attachments', 'update')).toBeUndefined()
  })

  it('auto-rejects 409 when the existing linked JE is a draft: the trigger refuses that move too', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })                              // CAS claim
    enqueue({ data: { id: 'doc-1', journal_entry_id: 'je-DRAFT' }, error: null }) // doc fetch
    enqueue({ data: { id: 'je-1' }, error: null })                              // shared check: the verifikat
    enqueue({ data: { status: 'draft', voucher_series: 'A', voucher_number: null }, error: null }) // holder
    enqueue({ data: null, error: null })                                         // dispatcher reject update

    const result = await commitPendingOperation(
      supabase as never, 'user-1', 'company-1', makePendingOp(baseOp),
    )
    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
    expect(result.error).toMatch(/^Bilagan är redan kopplad till ett verifikationsutkast/)
    expect(findCall('document_attachments', 'update')).toBeUndefined()
  })

  it('auto-rejects 409 when the doc is linked elsewhere even if the holder row cannot be read', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })                              // CAS claim
    enqueue({ data: { id: 'doc-1', journal_entry_id: 'je-OTHER' }, error: null }) // doc fetch
    enqueue({ data: { id: 'je-1' }, error: null })                              // shared check: the verifikat
    enqueue({ data: null, error: null })                                         // holder: not visible
    enqueue({ data: null, error: null })                                         // dispatcher reject update

    const result = await commitPendingOperation(
      supabase as never, 'user-1', 'company-1', makePendingOp(baseOp),
    )
    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
    expect(result.error).toMatch(/^Bilagan är redan kopplad till en annan verifikation/)
  })

  it('auto-rejects 409 when the immutability trigger refuses the write the precheck let through (race or line-level link)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })                              // CAS claim
    enqueue({ data: { id: 'doc-1', journal_entry_id: null }, error: null })     // doc fetch: unlinked at precheck
    enqueue({ data: { id: 'je-1' }, error: null })                              // shared check: the verifikat
    enqueue({ data: { id: 'je-1' }, error: null })                              // linkToJournalEntry: JE ownership
    enqueue({
      data: null,
      error: {
        message:
          'BFL_DOCUMENT_IMMUTABILITY: cannot clear or change journal_entry_id on document doc-1 once set (BFL 5 kap 6 §). Reverse the journal entry first.',
      },
    })                                                                           // linkToJournalEntry: doc update refused
    enqueue({ data: null, error: null })                                         // dispatcher reject update

    const result = await commitPendingOperation(
      supabase as never, 'user-1', 'company-1', makePendingOp(baseOp),
    )
    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
    expect(result.error).toBe('Bilagan är redan kopplad till en verifikation och kopplingen kan inte ändras (BFL 5 kap 6 §).')
  })

  it('happy path: links doc to verifikation with no prior journal_entry_id', async () => {
    const { supabase, enqueue, calls, findCall } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })                              // CAS claim
    enqueue({ data: { id: 'doc-1', journal_entry_id: null }, error: null })     // doc fetch
    enqueue({ data: { id: 'je-1' }, error: null })                              // shared check: the verifikat
    enqueue({ data: { id: 'je-1' }, error: null })                              // linkToJournalEntry: JE ownership
    enqueue({
      data: { id: 'doc-1', file_name: 'faktura.pdf', journal_entry_id: 'je-1', journal_entry_line_id: null },
      error: null,
    })                                                                           // linkToJournalEntry: doc update
    enqueue({ data: [{ id: 'inbox-1' }], error: null })                         // inbox stamp: one row claimed
    enqueue({ data: null, error: null })                                         // dispatcher commit update

    const result = await commitPendingOperation(
      supabase as never, 'user-1', 'company-1', makePendingOp(baseOp),
    )
    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({
      document_id: 'doc-1',
      journal_entry_id: 'je-1',
    })
    // The inbox item the document came from is stamped as handled, keyed on
    // document_id and CAS-guarded on both link columns: otherwise
    // list_inbox_items / list_unmatched_documents keep listing an attached
    // document as unprocessed forever.
    expect(findCall('invoice_inbox_items', 'update')).toEqual([{ created_journal_entry_id: 'je-1' }])
    const inboxFilters = calls
      .filter((c) => c.table === 'invoice_inbox_items' && (c.method === 'eq' || c.method === 'is'))
      .map((c) => c.args)
    expect(inboxFilters).toEqual([
      ['document_id', 'doc-1'],
      ['company_id', 'company-1'],
      ['created_journal_entry_id', null],
      ['created_supplier_invoice_id', null],
    ])
  })

  it('stamps a second document on the same voucher too: keyed on the document, never on the voucher being unclaimed', async () => {
    // Invoice + payment confirmation on one verifikat (feedback seq 389343,
    // 395894, 395931, 366701). The UNIQUE on created_journal_entry_id that
    // made this stamp fail with 23505 is gone (migration 20260911120500), so
    // the second document's inbox row is claimed exactly like the first.
    const { supabase, enqueue, calls, findCall } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })                              // CAS claim
    enqueue({ data: { id: 'doc-2', journal_entry_id: null }, error: null })     // doc fetch
    enqueue({ data: { id: 'je-1' }, error: null })                              // shared check: the verifikat
    enqueue({ data: { id: 'je-1' }, error: null })                              // linkToJournalEntry: JE ownership
    enqueue({
      data: { id: 'doc-2', file_name: 'betalbekraftelse.pdf', journal_entry_id: 'je-1', journal_entry_line_id: null },
      error: null,
    })                                                                           // linkToJournalEntry: doc update
    enqueue({ data: [{ id: 'inbox-2' }], error: null })                         // inbox stamp: second row claimed
    enqueue({ data: null, error: null })                                         // dispatcher commit update

    const result = await commitPendingOperation(
      supabase as never, 'user-1', 'company-1',
      makePendingOp({ ...baseOp, params: { document_id: 'doc-2', journal_entry_id: 'je-1' } }),
    )
    expect(result.status).toBe('committed')
    expect(findCall('invoice_inbox_items', 'update')).toEqual([{ created_journal_entry_id: 'je-1' }])
    const inboxFilters = calls
      .filter((c) => c.table === 'invoice_inbox_items' && (c.method === 'eq' || c.method === 'is'))
      .map((c) => c.args)
    expect(inboxFilters).toEqual([
      ['document_id', 'doc-2'],
      ['company_id', 'company-1'],
      ['created_journal_entry_id', null],
      ['created_supplier_invoice_id', null],
    ])
    expect(logWarn).not.toHaveBeenCalled()
  })

  it('zero stamped rows (document not from the inbox, or row already claimed) logs a warning naming both ids; the link stays committed', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })                              // CAS claim
    enqueue({ data: { id: 'doc-1', journal_entry_id: null }, error: null })     // doc fetch
    enqueue({ data: { id: 'je-1' }, error: null })                              // shared check: the verifikat
    enqueue({ data: { id: 'je-1' }, error: null })                              // linkToJournalEntry: JE ownership
    enqueue({
      data: { id: 'doc-1', file_name: 'faktura.pdf', journal_entry_id: 'je-1', journal_entry_line_id: null },
      error: null,
    })                                                                           // linkToJournalEntry: doc update
    enqueue({ data: [], error: null })                                           // inbox stamp: no row matched
    enqueue({ data: null, error: null })                                         // dispatcher commit update

    const result = await commitPendingOperation(
      supabase as never, 'user-1', 'company-1', makePendingOp(baseOp),
    )
    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ document_id: 'doc-1', journal_entry_id: 'je-1' })
    expect(logWarn).toHaveBeenCalledTimes(1)
    expect(logWarn).toHaveBeenCalledWith(
      expect.stringMatching(/No inbox item stamped after document link/),
      { documentId: 'doc-1', journalEntryId: 'je-1' },
    )
  })

  it('inbox stamp is best-effort: a failed stamp is logged and never fails the committed link', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })                              // CAS claim
    enqueue({ data: { id: 'doc-1', journal_entry_id: null }, error: null })     // doc fetch
    enqueue({ data: { id: 'je-1' }, error: null })                              // shared check: the verifikat
    enqueue({ data: { id: 'je-1' }, error: null })                              // linkToJournalEntry: JE ownership
    enqueue({
      data: { id: 'doc-1', file_name: 'faktura.pdf', journal_entry_id: 'je-1', journal_entry_line_id: null },
      error: null,
    })                                                                           // linkToJournalEntry: doc update
    enqueue({ data: null, error: { code: '42501', message: 'permission denied for table invoice_inbox_items' } }) // inbox stamp failed
    enqueue({ data: null, error: null })                                         // dispatcher commit update

    const result = await commitPendingOperation(
      supabase as never, 'user-1', 'company-1', makePendingOp(baseOp),
    )
    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ document_id: 'doc-1', journal_entry_id: 'je-1' })
    expect(logWarn).toHaveBeenCalledWith(
      expect.stringMatching(/Failed to mark inbox item handled after document link/),
      {
        documentId: 'doc-1',
        journalEntryId: 'je-1',
        error: 'permission denied for table invoice_inbox_items',
      },
    )
  })

  it('auto-rejects 409 when linkToJournalEntry throws a period-lock error', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })                              // CAS claim
    enqueue({ data: { id: 'doc-1', journal_entry_id: null }, error: null })     // doc fetch
    enqueue({ data: { id: 'je-1' }, error: null })                              // shared check: the verifikat
    enqueue({ data: { id: 'je-1' }, error: null })                              // linkToJournalEntry: JE ownership
    enqueue({
      data: null,
      error: { message: 'cannot link document in a locked/closed fiscal period' },
    })                                                                           // linkToJournalEntry: doc update: period locked
    enqueue({ data: null, error: null })                                         // dispatcher reject update

    const result = await commitPendingOperation(
      supabase as never, 'user-1', 'company-1', makePendingOp(baseOp),
    )
    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
  })

  // The shared rules (lib/documents/link-document.ts) refuse before any write
  // what the door used to let through to a permanent wrong pin or a trigger.
  it('auto-rejects 404 for a line that is not on the verifikat, writing nothing', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })                              // CAS claim
    enqueue({ data: { id: 'doc-1', journal_entry_id: null }, error: null })     // doc fetch
    enqueue({ data: { id: 'je-1' }, error: null })                              // shared check: the verifikat
    enqueue({ data: null, error: null })                                         // shared check: no such line on it
    enqueue({ data: null, error: null })                                         // dispatcher reject update

    const result = await commitPendingOperation(
      supabase as never, 'user-1', 'company-1',
      makePendingOp({ ...baseOp, params: { ...baseOp.params, journal_entry_line_id: 'line-of-je-9' } }),
    )
    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(404)
    expect(result.error).toBe('Raden finns inte på verifikationen.')
    expect(findCall('document_attachments', 'update')).toBeUndefined()
  })

  it('auto-rejects 409 for a verifikat in a locked period before the write', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })                              // CAS claim
    enqueue({ data: { id: 'doc-1', journal_entry_id: null }, error: null })     // doc fetch
    enqueue({ data: { id: 'je-1', fiscal_period_id: 'fp-1' }, error: null })    // shared check: the verifikat
    enqueue({
      data: { id: 'fp-1', period_start: '2025-01-01', is_closed: true, locked_at: '2026-02-01T00:00:00Z', closed_externally: false, closing_entry_id: 'je-close' },
      error: null,
    })                                                                           // shared check: its period, closed
    enqueue({ data: null, error: null })                                         // dispatcher reject update

    const result = await commitPendingOperation(
      supabase as never, 'user-1', 'company-1', makePendingOp(baseOp),
    )
    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
    expect(result.error).toBe('Verifikationens period är låst: bilagan kan inte länkas.')
    expect(findCall('document_attachments', 'update')).toBeUndefined()
  })
})

// ─── link_documents_to_vouchers (bulk) ─────────────────────────────

describe('commitPendingOperation: link_documents_to_vouchers', () => {
  const baseOp: Partial<PendingOperation> = {
    operation_type: 'link_documents_to_vouchers',
    params: {
      links: [
        { document_id: 'doc-1', journal_entry_id: 'je-1', journal_entry_line_id: null },
        { document_id: 'doc-2', journal_entry_id: 'je-2', journal_entry_line_id: null },
      ],
    },
  }

  it('happy path: links every row and reports zero skipped', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    // row 1: doc-1 -> je-1
    enqueue({ data: { id: 'doc-1', journal_entry_id: null }, error: null })  // doc fetch
    enqueue({ data: { id: 'je-1' }, error: null })                              // shared check: the verifikat
    enqueue({ data: { id: 'je-1' }, error: null })                          // linkToJournalEntry: JE ownership
    enqueue({
      data: { id: 'doc-1', file_name: 'kvitto1.pdf', journal_entry_id: 'je-1', journal_entry_line_id: null },
      error: null,
    })                                                                       // linkToJournalEntry: doc update
    enqueue({ data: null, error: null })                                   // inbox stamp (best-effort)
    // row 2: doc-2 -> je-2
    enqueue({ data: { id: 'doc-2', journal_entry_id: null }, error: null })  // doc fetch
    enqueue({ data: { id: 'je-1' }, error: null })                              // shared check: the verifikat
    enqueue({ data: { id: 'je-2' }, error: null })                          // linkToJournalEntry: JE ownership
    enqueue({
      data: { id: 'doc-2', file_name: 'kvitto2.pdf', journal_entry_id: 'je-2', journal_entry_line_id: null },
      error: null,
    })                                                                       // linkToJournalEntry: doc update
    enqueue({ data: null, error: null })                                   // inbox stamp (best-effort)
    enqueue({ data: null, error: null })                                    // dispatcher commit update

    const result = await commitPendingOperation(
      supabase as never, 'user-1', 'company-1', makePendingOp(baseOp),
    )
    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({
      linked_count: 2,
      skipped_count: 0,
    })
  })

  it('mixed batch: a missing document is skipped without blocking the other rows', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })                          // CAS claim
    // row 1: doc-1 not found in this company
    enqueue({ data: null, error: null })                                   // doc fetch: not found
    enqueue({ data: { id: 'je-1' }, error: null })                              // shared check: the verifikat
    // row 2: doc-2 -> je-2 succeeds
    enqueue({ data: { id: 'doc-2', journal_entry_id: null }, error: null }) // doc fetch
    enqueue({ data: { id: 'je-1' }, error: null })                              // shared check: the verifikat
    enqueue({ data: { id: 'je-2' }, error: null })                         // linkToJournalEntry: JE ownership
    enqueue({
      data: { id: 'doc-2', file_name: 'kvitto2.pdf', journal_entry_id: 'je-2', journal_entry_line_id: null },
      error: null,
    })                                                                      // linkToJournalEntry: doc update
    enqueue({ data: null, error: null })                                  // inbox stamp (best-effort)
    enqueue({ data: null, error: null })                                   // dispatcher commit update

    const result = await commitPendingOperation(
      supabase as never, 'user-1', 'company-1', makePendingOp(baseOp),
    )
    // Non-transactional bulk op: overall status is 'committed' even with
    // partial skips (mirrors bulk_book_inbox_items's booked/skipped split),
    // since no irreversible side-effect was posted for the skipped row.
    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ linked_count: 1, skipped_count: 1 })
    expect((result.data as { skipped: Array<{ document_id: string; reason: string }> }).skipped[0]).toMatchObject({
      document_id: 'doc-1',
      reason: 'Bilagan hittades inte.',
    })
  })

  it('WORM guard skips a row whose doc is already linked to a different posted JE', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })                                  // CAS claim
    // row 1: doc-1 already linked to je-OTHER (posted) -> skipped
    enqueue({ data: { id: 'doc-1', journal_entry_id: 'je-OTHER' }, error: null })   // doc fetch
    enqueue({ data: { id: 'je-1' }, error: null })                              // shared check: the verifikat
    enqueue({ data: { status: 'posted', voucher_series: 'A', voucher_number: 3 }, error: null }) // holder
    // row 2: doc-2 -> je-2 succeeds
    enqueue({ data: { id: 'doc-2', journal_entry_id: null }, error: null })         // doc fetch
    enqueue({ data: { id: 'je-1' }, error: null })                              // shared check: the verifikat
    enqueue({ data: { id: 'je-2' }, error: null })                                 // linkToJournalEntry: JE ownership
    enqueue({
      data: { id: 'doc-2', file_name: 'kvitto2.pdf', journal_entry_id: 'je-2', journal_entry_line_id: null },
      error: null,
    })                                                                              // linkToJournalEntry: doc update
    enqueue({ data: null, error: null })                                          // inbox stamp (best-effort)
    enqueue({ data: null, error: null })                                           // dispatcher commit update

    const result = await commitPendingOperation(
      supabase as never, 'user-1', 'company-1', makePendingOp(baseOp),
    )
    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ linked_count: 1, skipped_count: 1 })
  })

  it('auto-rejects 409 when every row is skipped instead of recording a committed no-op', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })                                  // CAS claim
    // row 1: doc-1 already linked to a posted JE -> WORM skip
    enqueue({ data: { id: 'doc-1', journal_entry_id: 'je-OTHER' }, error: null })   // doc fetch
    enqueue({ data: { id: 'je-1' }, error: null })                              // shared check: the verifikat
    enqueue({ data: { status: 'posted', voucher_series: 'A', voucher_number: 3 }, error: null }) // holder
    // row 2: doc-2 not found -> skip
    enqueue({ data: null, error: null })                                           // doc fetch: not found
    enqueue({ data: { id: 'je-1' }, error: null })                              // shared check: the verifikat
    enqueue({ data: null, error: null })                                           // dispatcher reject update

    const result = await commitPendingOperation(
      supabase as never, 'user-1', 'company-1', makePendingOp(baseOp),
    )
    // Partial skips stay 'committed' (see the mixed-batch case), but a batch
    // that linked nothing must not leave an audit record asserting a run that
    // changed nothing: the single-document executor returns 409 for the same
    // conditions, and the bulk path must not be the weaker one.
    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
  })

  it('fails 400 when the staged params carry an empty links array', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })  // CAS claim
    enqueue({ data: null, error: null })            // dispatcher failure update

    const result = await commitPendingOperation(
      supabase as never, 'user-1', 'company-1',
      makePendingOp({ ...baseOp, params: { links: [] } }),
    )
    // 400 is not auto-reject territory (only 404 and 409 are), so the operation
    // is recorded as failed rather than rejected.
    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
  })

  it('fails 400 when links is missing entirely', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })  // CAS claim
    enqueue({ data: null, error: null })            // dispatcher failure update

    const result = await commitPendingOperation(
      supabase as never, 'user-1', 'company-1',
      makePendingOp({ ...baseOp, params: {} }),
    )
    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
  })
})

// ─── categorize_transaction: dimensions propagation (PR7) ──────────

describe('commitPendingOperation: categorize_transaction: dimensions propagation (PR7)', () => {
  it('threads the staged dimensions bag into categorizeMatchedTransaction opts', async () => {
    vi.mocked(categorizeMatchedTransaction).mockResolvedValueOnce({
      data: { journal_entry_id: 'je-1' },
    })

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's commit update

    const op = makePendingOp({
      operation_type: 'categorize_transaction',
      params: {
        transaction_id: 'tx-1',
        category: 'office_supplies',
        dimensions: { '1': 'KS01', '6': 'P001' },
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(categorizeMatchedTransaction).toHaveBeenCalledTimes(1)
    const call = vi.mocked(categorizeMatchedTransaction).mock.calls[0]
    expect(call[1]).toBe('user-1')
    expect(call[2]).toBe('company-1')
    expect(call[3]).toBe('tx-1')
    expect(call[4].dimensions).toEqual({ '1': 'KS01', '6': 'P001' })
  })

  it('coerces an INVALID staged bag to undefined (drift/tamper gate)', async () => {
    vi.mocked(categorizeMatchedTransaction).mockResolvedValueOnce({
      data: { journal_entry_id: 'je-1' },
    })

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's commit update

    const op = makePendingOp({
      operation_type: 'categorize_transaction',
      params: {
        transaction_id: 'tx-1',
        category: 'office_supplies',
        // '0' is not a valid SIE dimension number: the whole bag is rejected
        // and booking proceeds without dimensions.
        dimensions: { '0': 'X' },
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    const opts = vi.mocked(categorizeMatchedTransaction).mock.calls[0][4]
    expect(opts.dimensions).toBeUndefined()
  })

  it('passes no dimensions when nothing was staged', async () => {
    vi.mocked(categorizeMatchedTransaction).mockResolvedValueOnce({
      data: { journal_entry_id: 'je-1' },
    })

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's commit update

    const op = makePendingOp({
      operation_type: 'categorize_transaction',
      params: { transaction_id: 'tx-1', category: 'office_supplies' },
    })

    await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    const opts = vi.mocked(categorizeMatchedTransaction).mock.calls[0][4]
    expect(opts.dimensions).toBeUndefined()
  })
})

// ─── categorize_transaction: account_override tamper gate ───────────────────

describe('commitPendingOperation: categorize_transaction account_override', () => {
  it('rejects loudly when a stored override is present but malformed (tamper/drift)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's rejected update

    const op = makePendingOp({
      operation_type: 'categorize_transaction',
      params: { transaction_id: 'tx-1', category: 'expense_other', account_override: '40a0' },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    // Never degrade to the category default: the approver approved a preview
    // showing the override account. 400 lands as 'failed' (the dispatcher
    // reserves auto-reject for 404/409); the point is that the core is never
    // called and the error names the override.
    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toContain('account_override')
    expect(categorizeMatchedTransaction).not.toHaveBeenCalled()
  })

  it('threads a valid stored override into the core opts', async () => {
    vi.mocked(categorizeMatchedTransaction).mockResolvedValueOnce({
      data: { journal_entry_id: 'je-1' },
    })

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's commit update

    const op = makePendingOp({
      operation_type: 'categorize_transaction',
      params: { transaction_id: 'tx-1', category: 'expense_other', account_override: '4020' },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    const opts = vi.mocked(categorizeMatchedTransaction).mock.calls[0][4]
    expect(opts.accountOverride).toBe('4020')
  })

  it('passes undefined when the staged params carry account_override: null (no override)', async () => {
    vi.mocked(categorizeMatchedTransaction).mockResolvedValueOnce({
      data: { journal_entry_id: 'je-1' },
    })

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's commit update

    const op = makePendingOp({
      operation_type: 'categorize_transaction',
      params: { transaction_id: 'tx-1', category: 'expense_other', account_override: null },
    })

    await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    const opts = vi.mocked(categorizeMatchedTransaction).mock.calls[0][4]
    expect(opts.accountOverride).toBeUndefined()
  })
})

// ─── categorize_transaction: reverse-charge basis box (#2919) ────────────────

describe('commitPendingOperation: categorize_transaction reverse_charge_kind', () => {
  it('threads the staged kind into the core opts so the approved ruta is the posted one', async () => {
    vi.mocked(categorizeMatchedTransaction).mockResolvedValueOnce({
      data: { journal_entry_id: 'je-1' },
    })

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's commit update

    const op = makePendingOp({
      operation_type: 'categorize_transaction',
      params: {
        transaction_id: 'tx-1',
        category: 'expense_software',
        vat_treatment: 'reverse_charge',
        reverse_charge_kind: 'non_eu_services',
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    const opts = vi.mocked(categorizeMatchedTransaction).mock.calls[0][4]
    expect(opts.vatTreatment).toBe('reverse_charge')
    expect(opts.reverseChargeKind).toBe('non_eu_services')
  })

  it('passes undefined for an operation staged before the kind existed (plain reverse_charge)', async () => {
    vi.mocked(categorizeMatchedTransaction).mockResolvedValueOnce({
      data: { journal_entry_id: 'je-1' },
    })

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's commit update

    const op = makePendingOp({
      operation_type: 'categorize_transaction',
      params: { transaction_id: 'tx-1', category: 'expense_software', vat_treatment: 'reverse_charge' },
    })

    await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    const opts = vi.mocked(categorizeMatchedTransaction).mock.calls[0][4]
    expect(opts.reverseChargeKind).toBeUndefined()
  })

  it('rejects loudly when a stored kind is present but unknown (tamper/drift)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's rejected update

    const op = makePendingOp({
      operation_type: 'categorize_transaction',
      params: {
        transaction_id: 'tx-1',
        category: 'expense_software',
        vat_treatment: 'reverse_charge',
        reverse_charge_kind: 'import_goods',
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toContain('reverse_charge_kind')
    expect(categorizeMatchedTransaction).not.toHaveBeenCalled()
  })
})

describe('commitPendingOperation: mark_invoice_sent honours defer_invoice_booking (#967)', () => {
  it('marks the invoice sent WITHOUT booking when the company defers invoice booking', async () => {
    const invoiceEntries = await import('@/lib/bookkeeping/invoice-entries')
    const bookSpy = vi.spyOn(invoiceEntries, 'createInvoiceJournalEntry')
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: makeInvoice({
        id: 'invoice-1',
        status: 'draft',
        invoice_number: 'F-2026001',
        credited_invoice_id: null,
      }),
      error: null,
    })
    enqueue({
      data: {
        accounting_method: 'accrual',
        defer_invoice_booking: true,
        entity_type: 'enskild_firma',
        bankgiro: '123-4567',
      },
      error: null,
    })
    enqueue({ data: [{ id: 'invoice-1' }], error: null }) // status flip draft -> sent (compare-and-set)
    enqueue({ data: null, error: null }) // dispatcher update

    const op = makePendingOp({
      operation_type: 'mark_invoice_sent',
      params: { invoice_id: 'invoice-1' },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ status: 'sent', journal_entry_id: null })
    // Same gate as the dashboard: deferred companies book via the explicit
    // Bokför step, never at mark-sent.
    expect(bookSpy).not.toHaveBeenCalled()
    bookSpy.mockRestore()
  })
})
