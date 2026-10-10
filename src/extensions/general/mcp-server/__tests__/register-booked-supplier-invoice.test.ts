/**
 * gnubok_register_booked_supplier_invoice (crm#1094): a supplier invoice that
 * is already in the books (its verifikat came in by SIE) goes into the
 * leverantörsreskontra under the supplier's number, linked to that verifikat
 * and carrying its rows, with nothing posted. The rules live in
 * lib/supplier-invoices/register-booked.ts (tested there); this pins the agent
 * door: wiring, the staged shape the commit dispatcher reads, and the
 * refusals an agent acts on.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'
import { isRegisterBookedInvoiceParams } from '@/lib/invoices/register-booked-invoice-mode'
import { RegisterBookedSupplierInvoiceParamsSchema } from '@/lib/supplier-invoices/register-booked'
import { tools, STAGE_BRIDGE_TARGETS } from '../server'
import { toToolError } from '../tool-result'

const tool = tools.find((t) => t.name === 'gnubok_register_booked_supplier_invoice')!

const COMPANY_ID = 'company-1'
const USER_ID = 'user-1'
const ACTOR = { type: 'api_key' as const }
const SUPPLIER_ID = '33333333-3333-4333-8333-333333333333'
const VOUCHER_ID = '44444444-4444-4444-8444-444444444444'

const ARGS = {
  supplier_id: SUPPLIER_ID,
  supplier_invoice_number: '7781',
  invoice_date: '2026-03-02',
  due_date: '2026-04-01',
  journal_entry_id: VOUCHER_ID,
  total: 10000,
  remaining_amount: 4000,
  balance_as_of: '2026-03-31',
}

const PURCHASE_LINES = [
  { account_number: '6110', debit_amount: 8000, credit_amount: 0, currency: 'SEK', line_description: null, dimensions: {} },
  { account_number: '2641', debit_amount: 2000, credit_amount: 0, currency: 'SEK', line_description: null, dimensions: {} },
  { account_number: '2440', debit_amount: 0, credit_amount: 10000, currency: 'SEK', line_description: null, dimensions: {} },
]

function books(lines = PURCHASE_LINES) {
  return createTableMockSupabase({
    suppliers: { data: { id: SUPPLIER_ID, name: 'Leverantören AB', archived_at: null } },
    company_settings: { data: { accounting_method: 'accrual', next_arrival_number: 501 } },
    journal_entries: {
      data: { id: VOUCHER_ID, voucher_series: 'D', voucher_number: 45, entry_date: '2026-03-02', description: 'Leverantörsfaktura 7781', status: 'posted', source_type: 'import' },
    },
    journal_entry_lines: { data: lines },
    // The number lookup, the same invoice stored under a reused number, then
    // the verifikat's holder lookup: all empty.
    supplier_invoices: [{ data: [] }, { data: [] }, { data: [] }],
    pending_operations: { data: { id: 'op-1' } },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_register_booked_supplier_invoice: registration', () => {
  it('is a search-only staged write the stage bridge carries, under suppliers:write', () => {
    expect(tool).toBeDefined()
    expect(tool.description.length).toBeLessThanOrEqual(280)
    expect(tool.description).toMatch(/stag(e|ing)/i)
    expect(tool.catalogVisibility).toBe('search')
    expect((tool.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false)
    expect(STAGE_BRIDGE_TARGETS).toContain(tool)
    expect(TOOL_SCOPE_MAP.gnubok_register_booked_supplier_invoice).toBe('suppliers:write')
  })

  it('tells the agent the limits before it calls: SEK, faktureringsmetoden, no reverse charge, no opening balance, no undo', () => {
    const properties = (tool.inputSchema as { properties: Record<string, { description?: string }> }).properties
    expect(tool.description).toMatch(/SEK, faktureringsmetoden, no reverse charge; cannot be undone/)
    expect(properties.journal_entry_id.description).toMatch(/credits 244x by the total/)
    expect(properties.journal_entry_id.description).toMatch(/Never the opening balance/)
    expect(properties.arrival_number.description).toMatch(/next_arrival_number/)
    expect(properties.balance_as_of.description).toMatch(/Required when remaining_amount is below the total/)
    expect(properties.currency.description).toMatch(/Only SEK registers/)
  })
})

describe('gnubok_register_booked_supplier_invoice: staging', () => {
  it('stages a create_supplier_invoice_from_inbox in register mode with what the approver must see, and writes nothing else', async () => {
    const { supabase, calls, findCall } = books()
    const result = (await tool.execute(ARGS, COMPANY_ID, USER_ID, supabase as never, ACTOR)) as {
      staged: boolean
      preview: Record<string, unknown>
      next?: { tool?: string; args?: Record<string, unknown>; description?: string }
    }

    expect(result.staged).toBe(true)
    const staged = findCall('pending_operations', 'insert')?.[0] as {
      operation_type: string
      title: string
      params: Record<string, unknown>
      preview_data: Record<string, unknown>
    }
    expect(staged.operation_type).toBe('create_supplier_invoice_from_inbox')
    expect(isRegisterBookedInvoiceParams(staged.params)).toBe(true)
    // Exactly what the commit re-validates: a staged row the executor would refuse is a broken approval.
    expect(RegisterBookedSupplierInvoiceParamsSchema.parse(staged.params)).toEqual({ mode: 'register_booked', ...ARGS })
    expect(staged.title).toBe('Registrera bokförd leverantörsfaktura 7781: Leverantören AB 10000 SEK, kvar 4000 per 2026-03-31 (verifikat D45)')
    expect(staged.preview_data).toMatchObject({
      supplier_name: 'Leverantören AB',
      supplier_invoice_number: '7781',
      subtotal: 8000,
      vat_amount: 2000,
      total: 10000,
      vat_treatment: 'standard_25',
      invoice_remaining: 4000,
      balance_as_of: '2026-03-31',
      journal_entry_id: VOUCHER_ID,
      voucher_label: 'D45',
      voucher_lines: [
        { account_number: '6110', debit_amount: 8000, credit_amount: 0 },
        { account_number: '2641', debit_amount: 2000, credit_amount: 0 },
        { account_number: '2440', debit_amount: 0, credit_amount: 10000 },
      ],
      writes_verifikat: false,
      period_lock_applies: false,
    })
    // The approval card picks its own preview from the marker, as for create_invoice.
    expect(staged.preview_data).toHaveProperty('mode', 'register_booked')
    expect(staged.preview_data).not.toHaveProperty('arrival_number')
    expect(staged.preview_data).not.toHaveProperty('payment_reference')
    expect(result.next).toMatchObject({ tool: 'gnubok_get_reconciliation_status', args: { account_key: 'manual:2440' } })
    expect(result.next?.description).toMatch(/do not also link their verifikat/)
    // A kreditfaktura needs the supplier's credit note: never offered as the way to take a registration back.
    expect(result.next?.description).toMatch(/cannot be undone and a wrong one cannot be corrected in Accounted today/)
    expect(result.next?.description).toMatch(/A kreditfaktura is only for a credit note the supplier actually issued/)

    const writes = calls.filter((call) => ['insert', 'update', 'upsert', 'delete'].includes(call.method))
    expect(writes.map((call) => `${call.method} ${call.table}`)).toEqual(['insert pending_operations'])
    expect(calls.some((call) => call.table.startsWith('rpc:get_next_arrival_number'))).toBe(false)
  })

  it('stages nothing on a dry run', async () => {
    const { supabase, findCall } = books()
    const result = (await tool.execute({ ...ARGS, dry_run: true }, COMPANY_ID, USER_ID, supabase as never, ACTOR)) as {
      dry_run?: boolean
      preview: Record<string, unknown>
    }
    expect(result.dry_run).toBe(true)
    expect(result.preview.invoice_remaining).toBe(4000)
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('refuses a verifikat whose skuld is not the invoice total, with a code the agent can act on', async () => {
    const lines = PURCHASE_LINES.map((line) => (line.account_number === '2440' ? { ...line, credit_amount: 12500 } : line))
    const { supabase, findCall } = books(lines)
    const error = await tool.execute(ARGS, COMPANY_ID, USER_ID, supabase as never, ACTOR).catch((err: unknown) => err)

    const envelope = toToolError(error).error
    expect(envelope.code).toBe('SI_REGISTER_AMOUNT_MISMATCH')
    expect(envelope.retryable).toBe(false)
    expect(envelope.message_en).toMatch(/D45 credits 244x by 12500 but the invoice total is 10000 SEK/)
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('refuses a reverse-charge purchase before staging anything', async () => {
    const { supabase, findCall } = books([
      { account_number: '6540', debit_amount: 10000, credit_amount: 0, currency: 'SEK', line_description: null, dimensions: {} },
      { account_number: '2645', debit_amount: 2500, credit_amount: 0, currency: 'SEK', line_description: null, dimensions: {} },
      { account_number: '2614', debit_amount: 0, credit_amount: 2500, currency: 'SEK', line_description: null, dimensions: {} },
      { account_number: '2440', debit_amount: 0, credit_amount: 10000, currency: 'SEK', line_description: null, dimensions: {} },
    ])
    const error = await tool.execute(ARGS, COMPANY_ID, USER_ID, supabase as never, ACTOR).catch((err: unknown) => err)

    const envelope = toToolError(error).error
    expect(envelope.code).toBe('SI_REGISTER_REVERSE_CHARGE')
    expect(envelope.retryable).toBe(false)
    expect(envelope.message_sv).toMatch(/omvänd betalningsskyldighet/)
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('refuses a company on kontantmetoden before staging anything', async () => {
    const { supabase, setTable, findCall } = books()
    setTable('company_settings', { data: { accounting_method: 'cash', next_arrival_number: 501 } })
    const error = await tool.execute(ARGS, COMPANY_ID, USER_ID, supabase as never, ACTOR).catch((err: unknown) => err)

    const envelope = toToolError(error).error
    expect(envelope.code).toBe('SI_REGISTER_CASH_METHOD')
    expect(envelope.retryable).toBe(false)
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('refuses a partly paid invoice without the reskontra date as a field error', async () => {
    const { supabase, calls } = books()
    const { balance_as_of: _balanceAsOf, ...withoutDate } = ARGS
    const error = await tool.execute(withoutDate, COMPANY_ID, USER_ID, supabase as never, ACTOR).catch((err: unknown) => err)

    expect(toToolError(error).error.code).toBe('VALIDATION_ERROR')
    expect(String((error as Error).message)).toMatch(/balance_as_of/)
    expect(calls).toEqual([])
  })
})
