import { createHash } from 'node:crypto'
import type { CollectionsOpenCaseRequest } from '@accounted/connect-contract'
import { createFakeCollectionsAdapter, createFakeCollectionsStore, type FakeCollectionsStore } from '../adapters/fake'
import { CollectionsError } from '../errors'
import type { CollectionsEnv, CollectionsGateFacts } from '../flags'
import type { CollectionsAdapter } from '../port'
import type { CollectionsServiceDeps } from '../service-deps'
import { ADMIN_ID, CASH_ACCOUNT_ID, COMPANY_ID, createMemorySupabase, seedCompany, type MemorySupabase } from './memory-supabase'

/**
 * A company with an active fake collections connection, one overdue
 * delivered business invoice, a fresh bank and the fake provider on an
 * injectable clock: the world the case service tests (open-case,
 * case-actions, sync, invoice-collection) run in.
 */

export const CONNECTION_ID = '44444444-4444-4444-8444-444444444444'
export const INVOICE_ID = '55555555-5555-4555-8555-555555555555'
export const CUSTOMER_ID = '66666666-6666-4666-8666-666666666666'
export const DOCUMENT_ID = '77777777-7777-4777-8777-777777777777'
export const OPENED_AT = Date.parse('2026-10-06T08:00:00Z')
export const MINUTE = 60_000

const PDF = Buffer.from('%PDF-1.4 handover test document')
export const TEST_DOCUMENT = {
  documentId: DOCUMENT_ID,
  filename: 'Faktura 20261042.pdf',
  sha256: createHash('sha256').update(PDF).digest('hex'),
  base64: PDF.toString('base64'),
}

export const ENV_ON: CollectionsEnv = {
  enabled: true,
  pilot: '*',
  ladderEnabled: false,
  deliveryEnabled: false,
  fakeAdapterRequested: false,
}
export const ENV_OFF: CollectionsEnv = { ...ENV_ON, enabled: false, pilot: new Set() }

export const BUSINESS_CUSTOMER = {
  id: CUSTOMER_ID,
  company_id: COMPANY_ID,
  name: 'Kundbolaget Norr AB',
  customer_type: 'swedish_business',
  country: 'SE',
  address_line1: 'Norrgatan 5',
  address_line2: null,
  postal_code: '903 25',
  city: 'Umeå',
  org_number: '556012-5790',
  vat_number: 'SE556012579001',
  customer_number: 'K-17',
  email: 'ekonomi@kundbolaget.se',
  phone: null,
  personal_number: null,
}

export interface CaseWorld {
  db: MemorySupabase
  clock: { now: number }
  now: () => Date
  store: FakeCollectionsStore
  fake: CollectionsAdapter
  /** Every openCase request the adapter received. */
  openRequests: CollectionsOpenCaseRequest[]
  /** Answers the next openCase calls with these errors first (then the fake). */
  openFailures: CollectionsError[]
  adapter: CollectionsAdapter
  deps(overrides?: Partial<CollectionsServiceDeps>): CollectionsServiceDeps
  facts(overrides?: Partial<CollectionsGateFacts>): CollectionsGateFacts
}

export function invoiceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const customer = (overrides.customer as Record<string, unknown> | undefined) ?? BUSINESS_CUSTOMER
  return {
    id: INVOICE_ID,
    company_id: COMPANY_ID,
    customer_id: customer.id,
    status: 'sent',
    document_type: 'invoice',
    credited_invoice_id: null,
    is_self_billed: false,
    currency: 'SEK',
    invoice_number: '20261042',
    invoice_date: '2026-08-01',
    due_date: '2026-08-31',
    total: 1250,
    vat_amount: 250,
    paid_amount: 0,
    paid_at: null,
    remaining_amount: 1250,
    deduction_total: null,
    deduction_reclaimed_total: null,
    ore_rounding: null,
    payment_cash_account_id: null,
    your_reference: 'Anna Andersson',
    ...overrides,
    // The memory client has no embedding: the joined customer rides on the row.
    customer,
  }
}

export async function createCaseWorld(options: { invoice?: Record<string, unknown>; customer?: Record<string, unknown> } = {}): Promise<CaseWorld> {
  const db = createMemorySupabase()
  seedCompany(db)
  const clock = { now: OPENED_AT }
  const now = () => new Date(clock.now)
  const store = createFakeCollectionsStore()
  const fake = createFakeCollectionsAdapter({ now, store, minuteMs: MINUTE })
  const openRequests: CollectionsOpenCaseRequest[] = []
  const openFailures: CollectionsError[] = []
  const adapter: CollectionsAdapter = {
    ...fake,
    route: 'fake',
    async openCase(ctx, input) {
      openRequests.push(structuredClone(input))
      const failure = openFailures.shift()
      if (failure) throw failure
      return fake.openCase(ctx, input)
    },
  }

  // A fresh bank behind the account the invoice asks the customer to pay to.
  const cash = db.rows('cash_accounts').find((r) => r.id === CASH_ACCOUNT_ID)!
  cash.bank_connection_id = 'bc-1'
  db.seed('bank_connections', [{ id: 'bc-1', company_id: COMPANY_ID, status: 'active', last_synced_at: new Date(OPENED_AT - 3_600_000).toISOString() }])

  const customer = { ...BUSINESS_CUSTOMER, ...(options.customer ?? {}) }
  db.seed('customers', [customer])
  db.seed('invoices', [invoiceRow({ customer, ...(options.invoice ?? {}) })])
  db.seed('invoice_deliveries', [
    {
      id: 'del-1',
      company_id: COMPANY_ID,
      invoice_id: INVOICE_ID,
      status: 'sent',
      provider_status: 'delivered',
      document_attachment_id: DOCUMENT_ID,
      sent_at: '2026-08-01T09:00:00Z',
    },
  ])
  db.seed('collection_sync_state', [{ id: 1, cursor: null, last_run_at: null, last_error: null }])

  const { error } = await db.client.from('collection_connections').insert({
    id: CONNECTION_ID,
    company_id: COMPANY_ID,
    route: 'fake',
    provider_ref: 'acme-inkasso',
    display_name: 'Acme Inkasso',
    connection_handle: 'fake-connection-company',
    state: 'active',
    catalogue_terms_version: 'fake-2026-10',
    consented_by: ADMIN_ID,
    consented_at: '2026-10-01T08:00:00Z',
    ladder_mode: 'off',
    // The company's terms state a reminder fee, so a handover may start with
    // a reminder (start-step.ts); the no-fee path sets this back to null.
    reminder_fee_terms_since: '2026-01-01',
  })
  if (error) throw new Error(error.message)

  const facts = (overrides: Partial<CollectionsGateFacts> = {}): CollectionsGateFacts => ({
    companyId: COMPANY_ID,
    capability: true,
    sandbox: false,
    connection: {
      route: 'fake',
      state: 'active',
      subStatus: null,
      health: 'ok',
      distributionEnabled: false,
      ladderMode: 'off',
      displayName: 'Acme Inkasso',
    },
    obligations: { openCases: 0, unbookedCollectedPayments: 0, unbookedSettlements: 0 },
    ...overrides,
  })

  return {
    db,
    clock,
    now,
    store,
    fake,
    openRequests,
    openFailures,
    adapter,
    facts,
    deps: (overrides = {}) => ({
      db: db.client,
      companyId: COMPANY_ID,
      actor: { userId: ADMIN_ID, name: 'Ada Admin' },
      channel: 'web',
      facts: facts(),
      env: ENV_ON,
      now,
      adapterFor: () => adapter,
      ...overrides,
    }),
  }
}

export function retryableError(code = 'CONNECTOR_UNREACHABLE'): CollectionsError {
  return new CollectionsError('Connector openCase: could not reach the service', { code, retryable: true })
}

export function refusedError(code = 'CONNECTOR_COLLECTIONS_DEBTOR_INVALID'): CollectionsError {
  return new CollectionsError('Connector openCase: refused', { code, retryable: false, status: 422 })
}
