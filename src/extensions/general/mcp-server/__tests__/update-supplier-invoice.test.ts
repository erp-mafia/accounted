/**
 * gnubok_update_supplier_invoice (operation supplier-invoices.update,
 * crm#1848): an agent could change a customer invoice over MCP but not the
 * due date or payment reference of a supplier invoice. The tool is generated
 * from the operation, whose rule (lib/supplier-invoices/update-header.ts) is
 * the one the dashboard PUT and the v1 PATCH call, and approval runs the same
 * run() through commitRegisteredOperation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'
import { operationForPendingType } from '@/lib/operations/registry'
import { supplierInvoicesUpdate } from '@/lib/operations/supplier-invoice-actions'
import { TOOL_SCOPE_MAP } from '@/lib/auth/scope-catalog'
import { OPERATION_RISK_TIERS } from '@/lib/pending-operations/risk-tiers'
import { tools } from '../server'

const COMPANY = 'company-1'
const INVOICE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const ENTRY_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const ACTOR = { type: 'api_key', id: 'key-1' } as const

const STORED = {
  id: INVOICE_ID,
  arrival_number: 118,
  supplier_invoice_number: '55012',
  invoice_date: '2026-09-03',
  due_date: '2999-10-03',
  delivery_date: null,
  payment_reference: null,
  notes: null,
  status: 'approved',
  currency: 'SEK',
  total: 6250,
  remaining_amount: 6250,
  registration_journal_entry_id: ENTRY_ID,
  is_credit_note: false,
  is_self_billed: false,
  approved_at: '2026-09-04T08:00:00Z',
}

const tool = tools.find((t) => t.name === 'gnubok_update_supplier_invoice')!

/** One stored invoice, answered only to the company that owns it. */
function client(stored: Record<string, unknown> | null, owner = COMPANY) {
  const invoices: TableMockResolver = (chain) => {
    const company = chain.find((c) => c.method === 'eq' && c.args[0] === 'company_id')?.args[1]
    return { data: stored && company === owner ? stored : null }
  }
  return createTableMockSupabase({ supplier_invoices: invoices, pending_operations: { data: { id: 'op-1' } } })
}

function call(mock: ReturnType<typeof client>, args: Record<string, unknown>) {
  return tool.execute({ supplier_invoice_id: INVOICE_ID, ...args }, COMPANY, 'user-1', mock.supabase as never, ACTOR)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_update_supplier_invoice: registration', () => {
  it('is a search-only staging tool, medium risk, gated by suppliers:write', () => {
    expect(tool).toBeDefined()
    expect(tool.catalogVisibility).toBe('search')
    expect(tool.description).toMatch(/^Stage /)
    expect(TOOL_SCOPE_MAP.gnubok_update_supplier_invoice).toBe('suppliers:write')
    expect(OPERATION_RISK_TIERS.update_supplier_invoice).toBe('medium')
    expect(operationForPendingType('update_supplier_invoice')).toBe(supplierInvoicesUpdate)
  })

  it('takes the header fields and nothing that reaches the books', () => {
    const schema = tool.inputSchema as { properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean }
    expect(schema.additionalProperties).toBe(false)
    expect(schema.required).toEqual(['supplier_invoice_id'])
    const fields = Object.keys(schema.properties)
    expect(fields).toEqual(
      expect.arrayContaining([
        'supplier_invoice_id', 'due_date', 'payment_reference', 'notes', 'delivery_date', 'invoice_date', 'supplier_invoice_number',
      ]),
    )
    for (const forbidden of ['status', 'total', 'vat_amount', 'items', 'account_number', 'supplier_id', 'currency', 'auto_debit']) {
      expect(fields, forbidden).not.toContain(forbidden)
    }
  })
})

describe('gnubok_update_supplier_invoice: staging', () => {
  it('stages the header change with the invoice named in the title, and writes no invoice', async () => {
    const mock = client(STORED)

    const result = (await call(mock, { due_date: '2999-10-15', payment_reference: '5501200018' })) as {
      staged: boolean
      risk_level: string
      preview: Record<string, unknown>
    }

    expect(result.staged).toBe(true)
    expect(result.risk_level).toBe('medium')
    expect(result.preview).toMatchObject({
      supplier_invoice_id: INVOICE_ID,
      due_date: '2999-10-15',
      changes: {
        due_date: { from: '2999-10-03', to: '2999-10-15' },
        payment_reference: { from: null, to: '5501200018' },
      },
    })
    // No bare id, and nothing the rules read for themselves.
    expect(result.preview).not.toHaveProperty('id')
    expect(result.preview).not.toHaveProperty('is_self_billed')

    const insert = mock.findCall('pending_operations', 'insert')?.[0] as {
      operation_type: string
      title: string
      params: Record<string, unknown>
    }
    expect(insert.operation_type).toBe('update_supplier_invoice')
    expect(insert.title).toBe('Ändra leverantörsfaktura 55012')
    expect(insert.params).toEqual({ supplier_invoice_id: INVOICE_ID, due_date: '2999-10-15', payment_reference: '5501200018' })
    // Approval re-parses the staged params with the operation's input.
    expect(supplierInvoicesUpdate.input.parse(insert.params)).toEqual(insert.params)
    // Staging only reads the invoice: the write waits for the approval.
    expect(mock.payloads('supplier_invoices', 'update')).toEqual([])
    expect(mock.tables().filter((t) => t.startsWith('journal_'))).toEqual([])
  })

  it('a dry run previews and stages nothing', async () => {
    const mock = client(STORED)
    const result = (await call(mock, { notes: 'Betalas efter uppgörelse', dry_run: true })) as { staged: boolean; dry_run: boolean }
    expect(result).toMatchObject({ staged: false, dry_run: true })
    expect(mock.findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('refuses a call with no field to change', async () => {
    const mock = client(STORED)
    await expect(call(mock, {})).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(mock.findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('refuses a malformed date before anything is read', async () => {
    const mock = client(STORED)
    await expect(call(mock, { due_date: '15/10/2026' })).rejects.toBeDefined()
    expect(mock.tables()).not.toContain('pending_operations')
  })

  it('refuses an unknown invoice at staging, not at approval', async () => {
    const mock = client(null)
    await expect(call(mock, { due_date: '2999-10-15' })).rejects.toMatchObject({ code: 'SI_NOT_FOUND' })
    expect(mock.findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it("refuses another company's invoice as not found", async () => {
    const mock = client(STORED, 'company-2')
    await expect(call(mock, { due_date: '2999-10-15' })).rejects.toMatchObject({ code: 'SI_NOT_FOUND' })
    expect(mock.findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('refuses a paid invoice', async () => {
    const mock = client({ ...STORED, status: 'paid', remaining_amount: 0 })
    await expect(call(mock, { due_date: '2999-10-15' })).rejects.toMatchObject({ code: 'SI_EDIT_INVALID_STATUS' })
    expect(mock.findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it.each([{ invoice_date: '2026-09-10' }, { supplier_invoice_number: '55013' }])(
    'refuses %j: the posted registration verifikat carries it',
    async (args) => {
      const mock = client(STORED)
      await expect(call(mock, args)).rejects.toMatchObject({ code: 'SI_EDIT_VERIFIKAT_LOCKED' })
      expect(mock.findCall('pending_operations', 'insert')).toBeUndefined()
    },
  )
})

describe('supplier-invoices.update: the approval', () => {
  const ctx = (mock: ReturnType<typeof createTableMockSupabase>) =>
    ({ supabase: mock.supabase, companyId: COMPANY, userId: 'user-1', log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }) as never

  it('writes the header and answers it under the qualified id', async () => {
    const mock = createTableMockSupabase({
      supplier_invoices: [{ data: STORED }, { data: { ...STORED, due_date: '2999-10-15' } }],
    })

    const outcome = await supplierInvoicesUpdate.run(ctx(mock), { supplier_invoice_id: INVOICE_ID, due_date: '2999-10-15' }, { dryRun: false })

    expect(outcome).toMatchObject({ ok: true, data: { supplier_invoice_id: INVOICE_ID, due_date: '2999-10-15', status: 'approved' } })
    expect(mock.payloads('supplier_invoices', 'update')).toEqual([{ due_date: '2999-10-15' }])
    expect(new Set(mock.tables())).toEqual(new Set(['supplier_invoices']))
    if (outcome.ok && !outcome.dryRun) expect(supplierInvoicesUpdate.output.safeParse(outcome.data).success).toBe(true)
  })

  it('an invoice paid between staging and approval is refused, not edited', async () => {
    const mock = createTableMockSupabase({ supplier_invoices: { data: { ...STORED, status: 'paid', remaining_amount: 0 } } })

    const outcome = await supplierInvoicesUpdate.run(ctx(mock), { supplier_invoice_id: INVOICE_ID, due_date: '2999-10-15' }, { dryRun: false })

    expect(outcome).toMatchObject({ ok: false, code: 'SI_EDIT_INVALID_STATUS' })
    expect(mock.payloads('supplier_invoices', 'update')).toEqual([])
  })
})
