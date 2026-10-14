/**
 * Changed supplier bank details over MCP (lib/payments/payee-alerts.ts): the
 * supplier invoice list says which invoices wait on their bank details
 * (payee_alert) without handing out the accounts, and the staged
 * gnubok_confirm_supplier_payee is approvable by a person in Accounted only.
 */
import { describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

import { tools, isStagingTool } from '../server'
import { TOOL_SCOPE_MAP } from '@/lib/auth/scope-catalog'
import { getRiskLevel, requiresWebApproval } from '@/lib/pending-operations/risk-tiers'

const COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const USER_ID = '22222222-2222-4222-8222-222222222222'
const INVOICE_ID = '44444444-4444-4444-8444-444444444444'
const OTHER_ID = '44444444-4444-4444-8444-444444444445'

const CARD = { id: 'sup-1', name: 'Derome Bygg AB', bankgiro: '5050-1055', plusgiro: null, bank_account: null, clearing_number: null, account_number: null, iban: null }

function invoice(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    supplier_id: 'sup-1',
    supplier_invoice_number: `F-${id.slice(-1)}`,
    invoice_date: '2026-10-01',
    due_date: '2026-10-31',
    status: 'approved',
    total: 1000,
    total_sek: 1000,
    currency: 'SEK',
    vat_treatment: 'standard_25',
    remaining_amount: 1000,
    is_credit_note: false,
    default_dimensions: {},
    payee_bankgiro: '9020-0007',
    payee_plusgiro: null,
    payee_clearing: null,
    payee_account: null,
    payee_iban: null,
    supplier: CARD,
    ...overrides,
  }
}

/** Answers each table with what it is given and records writes (tests/helpers.ts createTableMockSupabase). */
function recordingClient(tables: Record<string, unknown>) {
  const db = createTableMockSupabase(Object.fromEntries(Object.entries(tables).map(([table, data]) => [table, { data }])))
  return {
    client: db.supabase as never,
    mutations: () => db.calls.filter((c) => ['insert', 'update', 'upsert', 'delete'].includes(c.method)).map((c) => ({ table: c.table, op: c.method })),
  }
}

const tool = (name: string) => {
  const found = tools.find((t) => t.name === name)
  if (!found) throw new Error(`tool ${name} not registered`)
  return found
}

describe('gnubok_list_supplier_invoices: payee_alert', () => {
  it('marks an invoice whose stated bank details wait for a person, and never answers the accounts', async () => {
    const { client } = recordingClient({
      supplier_invoices: [invoice(INVOICE_ID), invoice(OTHER_ID, { payee_bankgiro: null })],
      supplier_payee_confirmations: [],
    })
    const result = (await tool('gnubok_list_supplier_invoices').execute({ status: 'all' }, COMPANY_ID, USER_ID, client)) as {
      invoices: Array<Record<string, unknown>>
    }
    expect(result.invoices.map((row) => [row.id, row.payee_alert])).toEqual([
      [INVOICE_ID, 'changed'],
      [OTHER_ID, null],
    ])
    expect(result.invoices[0]!.supplier).toEqual({ id: 'sup-1', name: 'Derome Bygg AB' })
    expect(JSON.stringify(result)).not.toMatch(/payee_bankgiro|9020-0007|5050-1055/)
  })

  it('says rejected once a person rejected the account, and nothing once one confirmed it', async () => {
    for (const [decision, expected] of [['rejected', 'rejected'], ['confirmed', null]] as const) {
      const { client } = recordingClient({
        supplier_invoices: [invoice(INVOICE_ID)],
        supplier_payee_confirmations: [{ supplier_id: 'sup-1', payee_key: 'bankgiro:90200007', decision, decided_at: '2026-10-14T10:00:00Z' }],
      })
      const result = (await tool('gnubok_list_supplier_invoices').execute({}, COMPANY_ID, USER_ID, client)) as { invoices: Array<Record<string, unknown>> }
      expect(result.invoices[0]!.payee_alert).toBe(expected)
    }
  })
})

describe('gnubok_confirm_supplier_payee', () => {
  it('is a search-only staging tool at high risk, approvable in the web UI only', () => {
    const confirm = tool('gnubok_confirm_supplier_payee')
    expect(confirm.catalogVisibility).toBe('search')
    expect(isStagingTool(confirm)).toBe(true)
    expect(TOOL_SCOPE_MAP.gnubok_confirm_supplier_payee).toBe('suppliers:write')
    expect(getRiskLevel('confirm_supplier_payee')).toBe('high')
    expect(requiresWebApproval('confirm_supplier_payee')).toBe(true)
  })

  it('stages the approval after a preview that writes nothing but the pending operation', async () => {
    const { client, mutations } = recordingClient({
      supplier_invoices: invoice(INVOICE_ID),
      supplier_payee_confirmations: [],
      pending_operations: { id: 'pending-1', status: 'pending', operation_type: 'confirm_supplier_payee', created_at: '2026-10-14T09:00:00Z' },
    })
    const result = (await tool('gnubok_confirm_supplier_payee').execute({ supplier_invoice_id: INVOICE_ID }, COMPANY_ID, USER_ID, client, {
      type: 'api_key',
      id: 'key-1',
    })) as Record<string, unknown>
    expect(result.staged).toBe(true)
    expect(result.risk_level).toBe('high')
    expect(mutations().map((m) => m.table)).toEqual(['pending_operations'])
    expect(result.preview).toMatchObject({ supplier_name: 'Derome Bygg AB', current_supplier_account: 'BG 5050-1055', invoice_account: 'BG 9020-0007' })
  })

  it('refuses at staging when the invoice states nothing to decide', async () => {
    const { client, mutations } = recordingClient({ supplier_invoices: invoice(INVOICE_ID, { payee_bankgiro: '5050-1055' }), supplier_payee_confirmations: [] })
    await expect(
      tool('gnubok_confirm_supplier_payee').execute({ supplier_invoice_id: INVOICE_ID }, COMPANY_ID, USER_ID, client),
    ).rejects.toMatchObject({ code: 'SUPPLIER_PAYEE_NOTHING_TO_DECIDE' })
    expect(mutations()).toEqual([])
  })

  it('cannot be approved over MCP: a person approves it in Accounted', async () => {
    const { client, mutations } = recordingClient({
      pending_operations: { id: 'pending-1', company_id: COMPANY_ID, status: 'pending', operation_type: 'confirm_supplier_payee', risk_level: 'high', params: { supplier_invoice_id: INVOICE_ID } },
    })
    await expect(
      tool('gnubok_approve_pending_operation').execute({ operation_id: '66666666-6666-4666-8666-666666666666', confirmed: true }, COMPANY_ID, USER_ID, client, {
        type: 'api_key',
        id: 'key-1',
      }),
    ).rejects.toMatchObject({ code: 'COLLECTION_ATTESTATION_WEB_ONLY' })
    expect(mutations()).toEqual([])
  })
})
