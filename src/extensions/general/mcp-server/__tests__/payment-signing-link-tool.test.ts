/**
 * The payment signing link tool generated from
 * src/lib/operations/payment-signing-links.ts: an agent that prepared bank
 * payments (and had a person approve them) stages a request that someone
 * without an Accounted login signs them with BankID. The tool stages; the
 * link, a credential, is minted at approval only. No tool signs.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements/has-capability')>()),
  hasCapability: vi.fn().mockResolvedValue(true),
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

import { tools, isStagingTool, STAGE_BRIDGE_TARGETS } from '../server'
import { TOOL_SCOPE_MAP } from '@/lib/auth/scope-catalog'
import { registerPaymentInitiationProvider, resetPaymentInitiationProviders, type PaymentInitiationProvider } from '@/lib/payments/initiation/provider'
import { createTableMockSupabase } from '@/tests/helpers'

const COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const USER_ID = '22222222-2222-4222-8222-222222222222'
const O1 = '33333333-3333-4333-8333-333333333333'
const O2 = '33333333-3333-4333-8333-444444444444'
const TOOL = 'gnubok_request_payment_signature'

const noBank = async (): Promise<never> => {
  throw new Error('a tool contacted the bank')
}
const provider = {
  id: 'open_payments',
  isAvailableFor: () => true,
  createPayment: noBank,
  getPaymentState: noBank,
  createSigningBasket: noBank,
  startSigning: noBank,
  pollSigning: noBank,
  cancelPayment: noBank,
  getBankCapabilities: noBank,
  getCompanyVerification: noBank,
  startCompanyVerification: noBank,
} as unknown as PaymentInitiationProvider

const WRITES = new Set(['insert', 'update', 'upsert', 'delete'])

/** A table mock and the tables a tool call wrote to, in order. */
function recordingClient(rows: Record<string, unknown>) {
  const db = createTableMockSupabase(Object.fromEntries(Object.entries(rows).map(([table, data]) => [table, { data }])))
  return { client: db.supabase as never, writes: () => db.calls.filter((c) => WRITES.has(c.method)).map((c) => c.table) }
}

function approved(id: string, overrides: Record<string, unknown> = {}) {
  return { id, user_id: 'someone-else', status: 'approved', amount: 737.5, currency: 'SEK', cash_account_id: 'acct-1', payee_name: 'Derome Bygg AB', outcome_unknown_at: null, ...overrides }
}

const tool = (name: string) => {
  const found = tools.find((t) => t.name === name)
  if (!found) throw new Error(`tool ${name} not registered`)
  return found
}

beforeEach(() => {
  resetPaymentInitiationProviders()
  registerPaymentInitiationProvider(provider)
})

describe('gnubok_request_payment_signature', () => {
  it('is search-only under suppliers:write, stages, rides the stage bridge, and keeps to the description budget', () => {
    expect(tool(TOOL).catalogVisibility).toBe('search')
    expect(TOOL_SCOPE_MAP[TOOL]).toBe('suppliers:write')
    expect(isStagingTool(tool(TOOL))).toBe(true)
    expect(STAGE_BRIDGE_TARGETS.map((t) => t.name)).toContain(TOOL)
    expect(tool(TOOL).description.length).toBeLessThanOrEqual(280)
    expect(tool(TOOL).description).not.toMatch(/[\u2013\u2014]/)
  })

  it('stages for an owner after a preview that mints nothing, and names what the approval returns', async () => {
    const { client, writes } = recordingClient({
      company_members: { role: 'owner' },
      payment_orders: [approved(O1), approved(O2)],
      payment_signing_links: [],
      pending_operations: { id: 'pending-1', status: 'pending', operation_type: 'request_payment_signature', created_at: '2026-10-14T09:00:00Z' },
    })
    const result = (await tool(TOOL).execute(
      { payment_order_ids: [O1, O2], recipient_email: 'anna@example.se', note: 'Oktober' },
      COMPANY_ID,
      USER_ID,
      client,
      { type: 'api_key', id: 'key-1' },
    )) as Record<string, unknown>
    expect(result.staged).toBe(true)
    expect(writes()).toEqual(['pending_operations'])
    expect(result.preview).toMatchObject({
      payment_order_ids: [O1, O2],
      order_count: 2,
      total_amount: 1475,
      currency: 'SEK',
      recipient_email: 'anna@example.se',
      email_will_be_sent: true,
      valid_hours: 72,
      url: null,
    })
    expect(result.next).toMatchObject({ tool: 'gnubok_approve_pending_operation' })
    expect(String((result.next as { description: string }).description)).toContain('data.url')
  })

  it('is refused before anything is staged for a member who did not prepare the orders', async () => {
    const { client, writes } = recordingClient({ company_members: { role: 'member' }, payment_orders: [approved(O1)] })
    await expect(tool(TOOL).execute({ payment_order_ids: [O1] }, COMPANY_ID, USER_ID, client)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(writes()).toEqual([])
  })

  it('is refused for orders that are not approved, and when no provider serves the company', async () => {
    const draft = recordingClient({ company_members: { role: 'owner' }, payment_orders: [approved(O1, { status: 'draft' })], payment_signing_links: [] })
    await expect(tool(TOOL).execute({ payment_order_ids: [O1] }, COMPANY_ID, USER_ID, draft.client)).rejects.toMatchObject({ code: 'PAYMENT_ORDERS_WRONG_STATUS' })
    expect(draft.writes()).toEqual([])
    resetPaymentInitiationProviders()
    const dark = recordingClient({ company_members: { role: 'owner' }, payment_orders: [approved(O1)] })
    await expect(tool(TOOL).execute({ payment_order_ids: [O1] }, COMPANY_ID, USER_ID, dark.client)).rejects.toMatchObject({ code: 'PAYMENTS_UNAVAILABLE' })
    expect(dark.writes()).toEqual([])
  })
})
