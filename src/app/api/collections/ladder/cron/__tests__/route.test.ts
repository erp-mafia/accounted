/**
 * GET /api/collections/ladder/cron: the cron secret, the off switch, and one
 * run over an in-memory database that stages a batch and sends nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { CollectionsAdapter } from '@/lib/collections/port'
import type { CollectionsGateFacts } from '@/lib/collections/flags'
import { createFakeCollectionsAdapter, createFakeCollectionsStore } from '@/lib/collections/adapters/fake'
import { ADMIN_ID, COMPANY_ID, createMemorySupabase, seedCompany, type MemorySupabase } from '@/lib/collections/__tests__/memory-supabase'

let db: MemorySupabase
let adapter: CollectionsAdapter
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => db.client }))
vi.mock('@/lib/collections/adapters', () => ({ collectionsAdapterFor: () => adapter, ensureCollectionsAdapters: () => {} }))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/collections/availability', () => ({
  loadCollectionsGateFacts: vi.fn(
    async (): Promise<CollectionsGateFacts> => ({
      companyId: COMPANY_ID,
      capability: true,
      sandbox: false,
      connection: { route: 'fake', state: 'active', subStatus: null, health: 'ok', distributionEnabled: false, ladderMode: 'staged', displayName: 'Acme Inkasso' },
      obligations: { openCases: 0, unbookedCollectedPayments: 0, unbookedSettlements: 0 },
    }),
  ),
}))

import { GET } from '../route'

const call = (authorization?: string) =>
  GET(new Request('http://localhost/api/collections/ladder/cron', { headers: authorization ? { authorization } : {} }))

const INVOICE_ID = '55555555-5555-4555-8555-555555555555'

beforeEach(() => {
  vi.stubEnv('CRON_SECRET', 'secret')
  vi.stubEnv('COLLECTIONS_ENABLED', '1')
  vi.stubEnv('COLLECTIONS_PILOT_COMPANIES', COMPANY_ID)
  vi.stubEnv('COLLECTIONS_LADDER_ENABLED', '1')
  db = createMemorySupabase()
  seedCompany(db)
  adapter = createFakeCollectionsAdapter({ store: createFakeCollectionsStore() })
  const now = Date.now()
  const customer = { id: 'cust-1', company_id: COMPANY_ID, name: 'Kund AB', customer_type: 'swedish_business', country: 'SE', address_line1: 'Gatan 1', address_line2: null, postal_code: '111 22', city: 'Stockholm', org_number: '5560125790', vat_number: null, customer_number: '1', email: 'kund@test.se', phone: null, collections_excluded: false }
  db.seed('customers', [customer])
  db.seed('invoices', [
    {
      id: INVOICE_ID,
      company_id: COMPANY_ID,
      customer_id: 'cust-1',
      status: 'sent',
      document_type: 'invoice',
      credited_invoice_id: null,
      is_self_billed: false,
      currency: 'SEK',
      invoice_number: '1001',
      invoice_date: '2026-01-01',
      due_date: '2026-01-31',
      total: 1250,
      vat_amount: 250,
      paid_amount: 0,
      paid_at: null,
      remaining_amount: 1250,
      deduction_total: null,
      deduction_reclaimed_total: null,
      ore_rounding: null,
      payment_cash_account_id: null,
      your_reference: null,
      customer,
    },
  ])
  db.seed('invoice_deliveries', [{ id: 'd-1', company_id: COMPANY_ID, invoice_id: INVOICE_ID, status: 'sent', provider_status: 'delivered' }])
  db.rows('cash_accounts')[0]!.bank_connection_id = 'bc-1'
  db.seed('bank_connections', [{ id: 'bc-1', company_id: COMPANY_ID, status: 'active', last_synced_at: new Date(now - 3_600_000).toISOString() }])
  db.seed('company_members', [{ company_id: COMPANY_ID, user_id: ADMIN_ID, role: 'owner' }])
  db.seed('collection_connections', [
    {
      id: 'conn-1',
      company_id: COMPANY_ID,
      route: 'fake',
      display_name: 'Acme Inkasso',
      state: 'active',
      minimum_amount: 100,
      default_start_step: 'reminder',
      reminder_fee_terms_since: null,
      ladder_mode: 'staged',
      ladder_days_after_due: 10,
      ladder_enabled_by: ADMIN_ID,
      ladder_enabled_at: '2026-01-01T00:00:00Z',
    },
  ])
})
afterEach(() => vi.unstubAllEnvs())

describe('GET /api/collections/ladder/cron', () => {
  it('refuses a call without the cron secret', async () => {
    expect((await call()).status).toBe(401)
    expect((await call('Bearer wrong')).status).toBe(401)
  })

  it('does nothing while the ladder flag is off', async () => {
    vi.stubEnv('COLLECTIONS_LADDER_ENABLED', '')
    const res = await call('Bearer secret')
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ enabled: false, companies: 0, staged: 0 })
    expect(db.rows('pending_operations')).toEqual([])
  })

  it('stages the day\'s batch for review and hands nothing over', async () => {
    const openCase = vi.spyOn(adapter, 'openCase')
    const caseAction = vi.spyOn(adapter, 'caseAction')
    const res = await call('Bearer secret')
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ enabled: true, companies: 1, staged: 1, failed: 0 })
    expect(db.rows('pending_operations')).toEqual([
      expect.objectContaining({ operation_type: 'collections_daily_batch', status: 'pending', user_id: ADMIN_ID, risk_level: 'high' }),
    ])
    expect(openCase).not.toHaveBeenCalled()
    expect(caseAction).not.toHaveBeenCalled()
    expect(db.rows('collection_cases')).toEqual([])
  })
})
