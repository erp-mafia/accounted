/**
 * A staged betalfil pays exactly what its approver saw. Staging
 * gnubok_create_supplier_payment_batch pins each line's payee (a fingerprint
 * of the exact bankgiro / plusgiro / clearing + account) and amount into the
 * staged params; the commit (commitPendingOperation, the approval path)
 * refuses with SI_BATCH_PAYEE_CHANGED when a supplier's payment details or
 * the amount changed in between, instead of paying the new account.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/operations/registry', async () => {
  const actual = await vi.importActual<typeof import('@/lib/operations/registry')>('@/lib/operations/registry')
  const ops = await vi.importActual<typeof import('@/lib/operations/supplier-payment-batches')>(
    '@/lib/operations/supplier-payment-batches',
  )
  return {
    ...actual,
    operationForPendingType: (type: string) =>
      type === 'create_supplier_payment_batch' ? ops.supplierPaymentBatchesCreate : actual.operationForPendingType(type),
  }
})

import { eventBus } from '@/lib/events'
import type { PendingOperation } from '@/types'
import { commitPendingOperation } from '@/lib/pending-operations/commit'
import { createOperationTools } from '@/extensions/general/mcp-server/operation-tools'
import { assertNoPlaintextPersonnummer } from '@/extensions/general/mcp-server/staging-pii-guard'
import { supplierPaymentBatchesCreate } from '@/lib/operations/supplier-payment-batches'

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const INVOICE_ID = '11111111-1111-4111-8111-111111111111'
const BATCH_ID = 'b1111111-1111-4111-8111-111111111111'

interface World {
  supplier: Record<string, unknown>
  remaining: number
}

/** A table-keyed client over mutable state, so a test can edit the supplier between stage and commit. */
function makeClient(world: World) {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = []
  const answer = (table: string): unknown => {
    switch (table) {
      case 'companies':
        return { data: { name: 'Testbolaget AB', org_number: '556677-8899' }, error: null }
      case 'company_settings':
        return {
          data: {
            company_name: 'Testbolaget AB',
            org_number: '556677-8899',
            city: 'Stockholm',
            iban: 'SE3550000000054910000003',
            bic: 'ESSESESS',
            bankgiro: null,
          },
          error: null,
        }
      case 'supplier_invoices':
        return {
          data: [
            {
              id: INVOICE_ID,
              status: 'approved',
              approved_at: '2026-08-01T10:00:00Z',
              due_date: '2099-08-20',
              remaining_amount: world.remaining,
              currency: 'SEK',
              is_credit_note: false,
              payment_reference: null,
              supplier_invoice_number: 'CD3014794407',
              supplier: { ...world.supplier },
            },
          ],
          error: null,
        }
      case 'supplier_payment_batch_items':
        return { data: [], error: null }
      case 'pending_operations':
        return { data: { id: 'op-1' }, error: null }
      case 'rpc':
        return {
          data: {
            ok: true,
            batch: {
              id: BATCH_ID,
              msg_id: 'ACCOUNTED-5566778899-BB1111111',
              format: 'pain001',
              status: 'created',
              currency: 'SEK',
              total_amount: world.remaining,
              item_count: 1,
              created_at: '2026-09-26T09:00:00Z',
            },
          },
          error: null,
        }
      default:
        return { data: null, error: null }
    }
  }
  const chain = (table: string): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(answer(table))
          return (...args: unknown[]) => {
            calls.push({ table, method: String(prop), args })
            return chain(table)
          }
        },
      },
    )
  const rpc = vi.fn((...args: unknown[]) => {
    calls.push({ table: 'rpc', method: String(args[0]), args })
    return chain('rpc')
  })
  return { calls, rpc, from: vi.fn((table: string) => chain(table)) }
}

const BANKGIRO_SUPPLIER: Record<string, unknown> = {
  id: 'sup-1',
  name: 'Derome Bygg AB',
  city: 'Varberg',
  bankgiro: '5050-1055',
  plusgiro: null,
  bank_account: null,
  clearing_number: null,
  account_number: null,
}

/** Stage through the generated MCP tool; answers the params and preview it would store. */
async function stage(world: World, args: Record<string, unknown> = {}) {
  const staged: { params?: Record<string, unknown>; preview?: Record<string, unknown> } = {}
  const [tool] = createOperationTools([supplierPaymentBatchesCreate], {
    readOnly: {},
    stagedWrite: {},
    stagedSchema: {},
    stagingArgs: {},
    stagePendingOperation: async (
      _s: unknown,
      _c: string,
      _u: string,
      _type: string,
      _title: string,
      params: Record<string, unknown>,
      previewData: Record<string, unknown>,
    ) => {
      // The real stagePendingOperation runs this guard on both payloads.
      assertNoPlaintextPersonnummer(params, 'params')
      assertNoPlaintextPersonnummer(previewData, 'preview_data')
      staged.params = params
      staged.preview = previewData
      return { staged: true }
    },
  } as never)
  const client = makeClient(world)
  await tool.execute(
    { format: 'pain001', items: [{ supplier_invoice_id: INVOICE_ID }], ...args },
    COMPANY_ID,
    'user-1',
    client as never,
    { type: 'api_key', id: 'key-1' } as never,
  )
  expect(client.rpc).not.toHaveBeenCalled()
  return staged as { params: Record<string, unknown>; preview: Record<string, unknown> }
}

function pendingOp(params: Record<string, unknown>): PendingOperation {
  return {
    id: 'op-1',
    user_id: 'user-1',
    company_id: COMPANY_ID,
    operation_type: 'create_supplier_payment_batch',
    status: 'pending',
    title: 'Ny betalfil: 1 leverantörsfaktura',
    params,
    preview_data: {},
    result_data: null,
    actor_type: 'user',
    actor_id: null,
    actor_label: null,
    risk_level: 'high',
    created_at: '2026-09-26T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-09-26T00:00:00Z',
  } as PendingOperation
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('staging pins the payee and amount', () => {
  it('stores a fingerprint and the amount per line, never the account number', async () => {
    const world = { supplier: { ...BANKGIRO_SUPPLIER }, remaining: 737.5 }
    const { params, preview } = await stage(world)
    const pins = params.expected_payees as Array<Record<string, unknown>>
    expect(pins).toEqual([
      { supplier_invoice_id: INVOICE_ID, payee_fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/), amount: 737.5 },
    ])
    expect(JSON.stringify(params)).not.toContain('50501055')
    expect((preview.items as Array<Record<string, unknown>>)[0].payee).toMatchObject({
      type: 'bankgiro',
      label: 'BG 5050-1055',
      fingerprint: pins[0].payee_fingerprint,
    })
  })

  it('carries no personnummer for a personkonto payee: not in params, masked in the preview', async () => {
    // Nordea personkonto: clearing 3300, account number = the holder's personnummer.
    const personnummer = '8001011234'
    const world = {
      supplier: { ...BANKGIRO_SUPPLIER, bankgiro: null, clearing_number: '3300', account_number: personnummer },
      remaining: 1200,
    }
    const { params, preview } = await stage(world)
    expect(JSON.stringify(params)).not.toContain(personnummer)
    expect(JSON.stringify(preview)).not.toContain(personnummer)
    expect((preview.items as Array<Record<string, unknown>>)[0].payee).toMatchObject({
      type: 'bank_account',
      label: '3300 ****1234',
    })
    for (const key of ['personnummer', 'pnr', 'personal_number', 'ssn']) {
      expect(JSON.stringify(params)).not.toContain(`"${key}"`)
    }
  })
})

describe('commit holds to the pinned payee and amount', () => {
  it('commits when nothing changed: the RPC runs with the staged payee', async () => {
    const world = { supplier: { ...BANKGIRO_SUPPLIER }, remaining: 737.5 }
    const { params } = await stage(world)
    const client = makeClient(world)
    const result = await commitPendingOperation(client as never, 'user-1', COMPANY_ID, pendingOp(params))
    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ supplier_payment_batch_id: BATCH_ID })
    expect(client.rpc).toHaveBeenCalledTimes(1)
    const rpcArgs = client.rpc.mock.calls[0][1] as { p_items: Array<Record<string, unknown>> }
    expect(rpcArgs.p_items[0]).toMatchObject({ payee_bankgiro: '50501055', amount: 737.5 })
  })

  it('refuses SI_BATCH_PAYEE_CHANGED, naming the supplier, when the bankgiro changed after staging', async () => {
    const world = { supplier: { ...BANKGIRO_SUPPLIER }, remaining: 737.5 }
    const { params } = await stage(world)
    world.supplier = { ...BANKGIRO_SUPPLIER, bankgiro: '555-5552' }
    const client = makeClient(world)
    const result = await commitPendingOperation(client as never, 'user-1', COMPANY_ID, pendingOp(params))
    expect(result.status).toBe('rejected')
    expect(result.code).toBe('SI_BATCH_PAYEE_CHANGED')
    expect(result.http_status).toBe(409)
    expect(result.error).toContain('Derome Bygg AB')
    expect(client.rpc).not.toHaveBeenCalled()
  })

  it('refuses when the payee moved from bankgiro to a bank account', async () => {
    const world = { supplier: { ...BANKGIRO_SUPPLIER }, remaining: 737.5 }
    const { params } = await stage(world)
    world.supplier = { ...BANKGIRO_SUPPLIER, bankgiro: null, clearing_number: '3300', account_number: '8001011234' }
    const client = makeClient(world)
    const result = await commitPendingOperation(client as never, 'user-1', COMPANY_ID, pendingOp(params))
    expect(result.code).toBe('SI_BATCH_PAYEE_CHANGED')
    expect(client.rpc).not.toHaveBeenCalled()
  })

  it('refuses when the amount changed (remaining amount moved and the line pays the default)', async () => {
    const world = { supplier: { ...BANKGIRO_SUPPLIER }, remaining: 737.5 }
    const { params } = await stage(world)
    world.remaining = 500
    const client = makeClient(world)
    const result = await commitPendingOperation(client as never, 'user-1', COMPANY_ID, pendingOp(params))
    expect(result.code).toBe('SI_BATCH_PAYEE_CHANGED')
    expect(client.rpc).not.toHaveBeenCalled()
  })

  it('a staged row with a tampered or missing fingerprint fails closed', async () => {
    const world = { supplier: { ...BANKGIRO_SUPPLIER }, remaining: 737.5 }
    const { params } = await stage(world)
    const tampered = {
      ...params,
      expected_payees: [{ supplier_invoice_id: INVOICE_ID, payee_fingerprint: '', amount: 737.5 }],
    }
    const client = makeClient(world)
    const result = await commitPendingOperation(client as never, 'user-1', COMPANY_ID, pendingOp(tampered))
    expect(result.status).not.toBe('committed')
    expect(client.rpc).not.toHaveBeenCalled()
  })
})
