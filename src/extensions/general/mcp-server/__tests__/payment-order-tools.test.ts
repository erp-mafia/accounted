/**
 * The bank payment tools generated from src/lib/operations/payment-orders.ts:
 * an agent lists, prepares (staged) and cancels (staged) bank payments and
 * hands out the Betalningar link. No tool approves or signs: approval and
 * BankID signing are a person's acts in Accounted.
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
import { toToolError } from '../tool-result'
import { TOOL_SCOPE_MAP } from '@/lib/auth/scope-catalog'
import {
  registerPaymentInitiationProvider,
  resetPaymentInitiationProviders,
  type PaymentInitiationProvider,
} from '@/lib/payments/initiation/provider'

const COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const USER_ID = '22222222-2222-4222-8222-222222222222'
const ORDER_ID = '33333333-3333-4333-8333-333333333333'
const INVOICE_ID = '44444444-4444-4444-8444-444444444444'
const ACCOUNT_ID = '55555555-5555-4555-8555-555555555555'

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
  getCompanyVerification: async () => ({ status: 'valid' as const, validUntil: '2027-10-03' }),
  startCompanyVerification: noBank,
} as unknown as PaymentInitiationProvider

interface Recording {
  mutations: Array<{ table: string; op: string }>
  rpcs: string[]
}

/** A client that answers each table with its rows (arrays, or a row for single reads) and records writes. */
function recordingClient(rows: Record<string, Record<string, unknown> | Record<string, unknown>[] | null>) {
  const recording: Recording = { mutations: [], rpcs: [] }
  const builder = (table: string): unknown => {
    let single = false
    const chain: unknown = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            return (resolve: (value: unknown) => void) => {
              const value = rows[table] ?? []
              const list = Array.isArray(value) ? value : value === null ? [] : [value]
              resolve({ data: single ? (list[0] ?? null) : list, error: null, count: list.length })
            }
          }
          return (..._args: unknown[]) => {
            const op = String(prop)
            if (op === 'single' || op === 'maybeSingle') single = true
            if (op === 'insert' || op === 'update' || op === 'upsert' || op === 'delete') recording.mutations.push({ table, op })
            return chain
          }
        },
      },
    )
    return chain
  }
  const client = {
    from: vi.fn((table: string) => builder(table)),
    rpc: vi.fn((name: string) => {
      recording.rpcs.push(name)
      return builder(`rpc:${name}`)
    }),
  }
  return { client: client as never, recording }
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

describe('bank payment tools', () => {
  it('registers the four tools under the suppliers scopes, stays out of tools/list, and the two writes stage', () => {
    for (const name of ['gnubok_list_payment_orders', 'gnubok_prepare_payments', 'gnubok_cancel_payment_order', 'gnubok_get_payments_signing_link']) {
      expect(tool(name).catalogVisibility).toBe('search')
      expect(TOOL_SCOPE_MAP[name]).toBeDefined()
    }
    expect(isStagingTool(tool('gnubok_prepare_payments'))).toBe(true)
    expect(isStagingTool(tool('gnubok_cancel_payment_order'))).toBe(true)
    expect(STAGE_BRIDGE_TARGETS.map((t) => t.name)).toEqual(expect.arrayContaining(['gnubok_prepare_payments', 'gnubok_cancel_payment_order']))
    expect(TOOL_SCOPE_MAP.gnubok_prepare_payments).toBe('suppliers:write')
    expect(TOOL_SCOPE_MAP.gnubok_list_payment_orders).toBe('suppliers:read')
  })

  it('offers no tool that approves, signs or resolves a bank payment', () => {
    const names = tools.map((t) => t.name)
    expect(names.filter((n) => /payment_order|payments/.test(n) && /approve|sign|resolve|poll/.test(n))).toEqual([
      'gnubok_get_payments_signing_link',
    ])
  })

  it('prepare stages a pending operation after a bank-free preview, and writes nothing else', async () => {
    const { client, recording } = recordingClient({
      company_settings: { org_number: '5566778899', is_sandbox: false },
      cash_accounts: { id: ACCOUNT_ID, iban: 'SE3550000000054910000003', currency: 'SEK', name: 'Företagskonto', enabled: true, bank_connection: { bank_name: 'SEB' } },
      supplier_invoices: [
        {
          id: INVOICE_ID, supplier_id: 'sup-1', status: 'approved', approved_at: '2026-08-01T10:00:00Z', due_date: '2099-08-20', remaining_amount: 737.5,
          currency: 'SEK', is_credit_note: false, payment_reference: null, supplier_invoice_number: 'CD3014794407',
          payee_bankgiro: null, payee_plusgiro: null, payee_clearing: null, payee_account: null,
        },
      ],
      suppliers: [{ id: 'sup-1', name: 'Derome Bygg AB', bankgiro: '5050-1055', plusgiro: null, bank_account: null, clearing_number: null, account_number: null }],
      supplier_payment_batch_items: [],
      payment_orders: [],
      pending_operations: { id: 'pending-1', status: 'pending', operation_type: 'prepare_payment_orders', created_at: '2026-10-10T09:00:00Z' },
    })
    const result = (await tool('gnubok_prepare_payments').execute(
      { supplier_invoice_ids: [INVOICE_ID], cash_account_id: ACCOUNT_ID },
      COMPANY_ID,
      USER_ID,
      client,
      { type: 'api_key', id: 'key-1' },
    )) as Record<string, unknown>
    expect(result.staged).toBe(true)
    expect(recording.mutations.map((m) => m.table)).toEqual(['pending_operations'])
    expect(recording.rpcs).toEqual([])
    const preview = result.preview as Record<string, unknown>
    expect(preview.lines).toEqual([expect.objectContaining({ supplier_invoice_id: INVOICE_ID, amount: 737.5 })])
  })

  it("prepare stages from an account at a bank outside the tables by its connection's BIC, and names why an account cannot pay (crm#1314)", async () => {
    const invoice = {
      id: INVOICE_ID, supplier_id: 'sup-1', status: 'approved', approved_at: '2026-08-01T10:00:00Z', due_date: '2099-08-20', remaining_amount: 113,
      currency: 'SEK', is_credit_note: false, payment_reference: null, supplier_invoice_number: 'F-1',
      payee_bankgiro: null, payee_plusgiro: null, payee_clearing: null, payee_account: null,
    }
    const rows = (bic: string | null) => ({
      company_settings: { org_number: '5566778899', is_sandbox: false },
      // 971: a Swedish IBAN at a bank outside the clearing and bank-name tables.
      cash_accounts: { id: ACCOUNT_ID, iban: 'SE5497100000012345678901', currency: 'SEK', name: 'Företagskonto', enabled: true, bank_connection: { bank_name: 'Lunar', bic } },
      supplier_invoices: [invoice],
      suppliers: [{ id: 'sup-1', name: 'Leverantör AB', bankgiro: '5050-1055', plusgiro: null, bank_account: null, clearing_number: null, account_number: null }],
      supplier_payment_batch_items: [],
      payment_orders: [],
      pending_operations: { id: 'pending-1', status: 'pending', operation_type: 'prepare_payment_orders', created_at: '2026-10-10T09:00:00Z' },
    })
    const args = { supplier_invoice_ids: [INVOICE_ID], cash_account_id: ACCOUNT_ID }

    const payable = recordingClient(rows('LUNADK2B'))
    const staged = (await tool('gnubok_prepare_payments').execute(args, COMPANY_ID, USER_ID, payable.client, { type: 'api_key', id: 'key-1' })) as Record<string, unknown>
    expect(staged.staged).toBe(true)

    const unnamed = recordingClient(rows(null))
    const refusal = await tool('gnubok_prepare_payments')
      .execute(args, COMPANY_ID, USER_ID, unnamed.client, { type: 'api_key', id: 'key-1' })
      .then(() => null, (error: unknown) => error)
    expect(toToolError(refusal).error).toMatchObject({ code: 'PAYMENT_ORDERS_ACCOUNT_NOT_PAYABLE', details: { reason: 'bank_unknown' } })
    expect(unnamed.recording.mutations).toEqual([])
  })

  it('prepare stages a payment in to the skattekonto from a filed AGI, with what it pays in the preview', async () => {
    const { client, recording } = recordingClient({
      company_settings: { org_number: '5566778899', is_sandbox: false, vat_registered: true, vat_taxable_base_over_40m: false },
      cash_accounts: { id: ACCOUNT_ID, iban: 'SE3550000000054910000003', currency: 'SEK', name: 'Företagskonto', enabled: true, bank_connection: { bank_name: 'SEB' } },
      companies: { org_number: '559547-0021', entity_type: 'aktiebolag' },
      agi_declarations: { status: 'submitted', total_tax: 18000, total_avgifter: 12568, tax_paid_at: null },
      deadlines: [],
      payment_orders: [],
      extension_data: null,
      pending_operations: { id: 'pending-3', status: 'pending', operation_type: 'prepare_payment_orders', created_at: '2026-10-16T09:00:00Z' },
    })
    const result = (await tool('gnubok_prepare_payments').execute(
      { cash_account_id: ACCOUNT_ID, skattekonto: { source: 'agi', year: 2026, month: 10 } },
      COMPANY_ID,
      USER_ID,
      client,
      { type: 'api_key', id: 'key-1' },
    )) as Record<string, unknown>
    expect(result.staged).toBe(true)
    expect(recording.mutations.map((m) => m.table)).toEqual(['pending_operations'])
    expect(recording.rpcs).toEqual([])
    expect(result.preview).toMatchObject({
      amount: 30568,
      payee: { type: 'bankgiro', label: 'BG 5050-1055', name: 'Skatteverket' },
      source: { kind: 'agi', tax_period: '2026-10', declared: 30568, filed: true },
    })
  })

  it('prepare refuses supplier invoices and skattekonto in one call', async () => {
    const { client, recording } = recordingClient({})
    await expect(
      tool('gnubok_prepare_payments').execute(
        { cash_account_id: ACCOUNT_ID, supplier_invoice_ids: [INVOICE_ID], skattekonto: { source: 'next_charge' } },
        COMPANY_ID,
        USER_ID,
        client,
      ),
    ).rejects.toThrow()
    expect(recording.mutations).toEqual([])
  })

  it('prepare refuses at staging when no provider serves the company, without staging anything', async () => {
    resetPaymentInitiationProviders()
    const { client, recording } = recordingClient({})
    await expect(
      tool('gnubok_prepare_payments').execute({ supplier_invoice_ids: [INVOICE_ID], cash_account_id: ACCOUNT_ID }, COMPANY_ID, USER_ID, client),
    ).rejects.toMatchObject({ code: 'PAYMENTS_UNAVAILABLE' })
    expect(recording.mutations).toEqual([])
  })

  it('cancel stages for a draft after a preview that asks no bank', async () => {
    const { client, recording } = recordingClient({
      payment_orders: { id: ORDER_ID, company_id: COMPANY_ID, status: 'draft', provider_payment_id: null, outcome_unknown_at: null },
      pending_operations: { id: 'pending-2', status: 'pending', operation_type: 'cancel_payment_order', created_at: '2026-10-10T09:00:00Z' },
    })
    const result = (await tool('gnubok_cancel_payment_order').execute({ payment_order_id: ORDER_ID }, COMPANY_ID, USER_ID, client)) as Record<string, unknown>
    expect(result.staged).toBe(true)
    expect(recording.mutations.map((m) => m.table)).toEqual(['pending_operations'])
    expect(result.preview).toMatchObject({ at_bank: false, bank_asked: false })
  })

  it('list answers qualified ids and never a bare id, a QR or a personnummer', async () => {
    const { client } = recordingClient({
      payment_orders: [
        {
          id: ORDER_ID, supplier_invoice_id: INVOICE_ID, batch_id: null, status: 'approved', amount: 737.5, currency: 'SEK',
          requested_execution_date: '2026-10-20', cash_account_id: ACCOUNT_ID, payee_type: 'bankgiro', payee_bankgiro: '50501055',
          payee_plusgiro: null, payee_clearing: null, payee_account: null, payee_iban: null, payee_name: 'Derome Bygg AB', payee_source: 'supplier',
          payee_check: 'known', reference_type: 'ocr', reference: '4400112233', end_to_end_id: 'ACC3333', provider_status: null,
          provider_error_code: null, outcome_unknown_at: null, approved_at: '2026-10-10T10:00:00Z', submitted_at: null, signed_at: null,
          executed_at: null, cancelled_at: null, matched_at: null, created_at: '2026-10-10T09:00:00Z', updated_at: '2026-10-10T10:00:00Z',
          supplier_invoice: { supplier_invoice_number: 'CD3014794407', due_date: '2026-10-20', supplier: { name: 'Derome Bygg AB' } },
        },
      ],
    })
    const result = (await tool('gnubok_list_payment_orders').execute({ status: 'open' }, COMPANY_ID, USER_ID, client)) as {
      payment_orders: Array<Record<string, unknown>>
    }
    expect(result.payment_orders[0]).toMatchObject({ payment_order_id: ORDER_ID, status: 'approved', payee: { label: 'BG 5050-1055' } })
    expect(result.payment_orders[0]).not.toHaveProperty('id')
    expect(JSON.stringify(result)).not.toMatch(/qr|personnummer|personal_number/i)
  })

  it('the signing link tells the agent where a person signs and what waits there', async () => {
    const { client } = recordingClient({
      company_settings: { org_number: '5566778899' },
      payment_orders: [
        { id: ORDER_ID, status: 'approved', outcome_unknown_at: null },
        { id: 'other', status: 'draft', outcome_unknown_at: null },
      ],
    })
    const result = (await tool('gnubok_get_payments_signing_link').execute({ payment_order_ids: ORDER_ID }, COMPANY_ID, USER_ID, client)) as Record<string, unknown>
    expect(result.url).toContain(`/payments?orders=${ORDER_ID}`)
    expect(result).toMatchObject({ awaiting_approval: 1, awaiting_signature: 1, at_bank: 0, verification: { status: 'valid' } })
    expect(String(result.note)).toMatch(/person/)
  })
})
