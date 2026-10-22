/**
 * gnubok_register_booked_invoice (crm#1094): an invoice that is already in
 * the books (its verifikat came in by SIE) goes into the kundreskontra under
 * its own number, linked to that verifikat, with nothing posted. The rules
 * live in lib/invoices/register-booked-invoice.ts (tested there); this pins
 * the agent door: wiring, the staged shape the commit dispatcher reads, and
 * the refusals an agent acts on.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'
import { isRegisterBookedInvoiceParams } from '@/lib/invoices/register-booked-invoice-mode'
import { RegisterBookedInvoiceParamsSchema } from '@/lib/invoices/register-booked-invoice'
import { tools, STAGE_BRIDGE_TARGETS } from '../server'
import { toToolError } from '../tool-result'

const tool = tools.find((t) => t.name === 'gnubok_register_booked_invoice')!

const COMPANY_ID = 'company-1'
const USER_ID = 'user-1'
const ACTOR = { type: 'api_key' as const }
const CUSTOMER_ID = '33333333-3333-4333-8333-333333333333'
const VOUCHER_ID = '44444444-4444-4444-8444-444444444444'

const ARGS = {
  customer_id: CUSTOMER_ID,
  invoice_number: '1023',
  invoice_date: '2026-03-02',
  due_date: '2026-04-01',
  journal_entry_id: VOUCHER_ID,
  total: 12500,
  remaining_amount: 5000,
  balance_as_of: '2026-03-31',
}

const SALE_LINES = [
  { account_number: '1510', debit_amount: 12500, credit_amount: 0, currency: 'SEK', line_description: null },
  { account_number: '3001', debit_amount: 0, credit_amount: 10000, currency: 'SEK', line_description: null },
  { account_number: '2611', debit_amount: 0, credit_amount: 2500, currency: 'SEK', line_description: null },
]

function books(lines = SALE_LINES) {
  return createTableMockSupabase({
    customers: { data: { id: CUSTOMER_ID, name: 'Testkund AB', email: null } },
    company_settings: { data: { invoice_prefix: null, next_invoice_number: 2001, send_invoice_reminders: true, accounting_method: 'accrual' } },
    journal_entries: {
      data: { id: VOUCHER_ID, voucher_series: 'B', voucher_number: 45, entry_date: '2026-03-02', description: 'Kundfaktura 1023', status: 'posted', source_type: 'import' },
    },
    journal_entry_lines: { data: lines },
    // The number lookup, then the verifikat's holder lookup: both empty.
    invoices: [{ data: [] }, { data: [] }],
    pending_operations: { data: { id: 'op-1' } },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_register_booked_invoice: registration', () => {
  it('is a search-only staged write the stage bridge carries, under invoices:write', () => {
    expect(tool).toBeDefined()
    expect(tool.description.length).toBeLessThanOrEqual(280)
    expect(tool.description).toMatch(/stag(e|ing)/i)
    expect(tool.catalogVisibility).toBe('search')
    expect((tool.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false)
    expect(STAGE_BRIDGE_TARGETS).toContain(tool)
    expect(TOOL_SCOPE_MAP.gnubok_register_booked_invoice).toBe('invoices:write')
  })

  it('tells the agent the limits before it calls: faktureringsmetoden, the currency rule, no opening balance, no undo', () => {
    const properties = (tool.inputSchema as { properties: Record<string, { description?: string }> }).properties
    expect(tool.description).toMatch(/Faktureringsmetoden only; cannot be undone/)
    // The #2298 rule counts a verifikat an invoice is linked to as backed:
    // nothing asks for the PDF after the approval.
    expect(tool.description).toMatch(/Approval counts the verifikat as backed: attach the invoice PDF in the same session/)
    expect(properties.journal_entry_id.description).toMatch(/Never the opening balance/)
    expect(properties.invoice_number.description).toMatch(/next_invoice_number/)
    expect(properties.balance_as_of.description).toMatch(/Required when remaining_amount is below the total/)
    // #90: another currency registers when the verifikat books it; the rate is never the caller's.
    expect(properties.currency.description).toMatch(/151x line must carry it and its amount; the rate is read from the verifikat/)
    expect(properties.total.description).toMatch(/in currency/)
    expect(properties).not.toHaveProperty('exchange_rate')
  })
})

describe('gnubok_register_booked_invoice: staging', () => {
  it('stages a create_invoice in register mode with what the approver must see, and writes nothing else', async () => {
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
    expect(staged.operation_type).toBe('create_invoice')
    expect(isRegisterBookedInvoiceParams(staged.params)).toBe(true)
    // Exactly what the commit re-validates: a staged row the executor would refuse is a broken approval.
    expect(RegisterBookedInvoiceParamsSchema.parse(staged.params)).toEqual({ mode: 'register_booked', ...ARGS })
    expect(staged.title).toBe('Registrera bokförd faktura 1023: Testkund AB 12500 SEK, kvar 5000 per 2026-03-31 (verifikat B45)')
    expect(staged.preview_data).toMatchObject({
      mode: 'register_booked',
      invoice_number: '1023',
      status: 'partially_paid',
      subtotal: 10000,
      vat_amount: 2500,
      total: 12500,
      paid_amount: 7500,
      remaining_amount: 5000,
      balance_as_of: '2026-03-31',
      journal_entry_id: VOUCHER_ID,
      voucher_label: 'B45',
      writes_verifikat: false,
    })
    expect(result.next).toMatchObject({ tool: 'gnubok_link_document_to_voucher', args: { journal_entry_id: VOUCHER_ID } })
    expect(result.next?.description).toMatch(/count as backed by the invoice/)
    expect(result.next?.description).toMatch(/in this same session, because nothing will flag it later/)

    const writes = calls.filter((call) => ['insert', 'update', 'upsert', 'delete'].includes(call.method))
    expect(writes.map((call) => `${call.method} ${call.table}`)).toEqual(['insert pending_operations'])
  })

  it('stages a euro invoice with its euro amounts, the rate its verifikat books and those kronor (#90)', async () => {
    const lines = [
      { account_number: '1510', debit_amount: 11482.5, credit_amount: 0, currency: 'EUR', amount_in_currency: 1000, exchange_rate: 11.4825, line_description: null },
      { account_number: '3308', debit_amount: 0, credit_amount: 11482.5, currency: 'EUR', amount_in_currency: 1000, exchange_rate: 11.4825, line_description: null },
    ]
    const { supabase, findCall } = books(lines)
    const args = { ...ARGS, currency: 'eur', total: 1000, remaining_amount: 1000 }
    const { balance_as_of: _balanceAsOf, ...unpaid } = args
    await tool.execute(unpaid, COMPANY_ID, USER_ID, supabase as never, ACTOR)

    const staged = findCall('pending_operations', 'insert')?.[0] as { title: string; params: Record<string, unknown>; preview_data: Record<string, unknown> }
    // The staged params carry no rate: the commit reads it from the verifikat again.
    expect(RegisterBookedInvoiceParamsSchema.parse(staged.params)).toMatchObject({ currency: 'EUR', total: 1000 })
    expect(staged.params).not.toHaveProperty('exchange_rate')
    expect(staged.title).toBe('Registrera bokförd faktura 1023: Testkund AB 1000 EUR (verifikat B45)')
    expect(staged.preview_data).toMatchObject({
      currency: 'EUR',
      exchange_rate: 11.4825,
      total_sek: 11482.5,
      vat_amount_sek: 0,
      total: 1000,
      subtotal: 1000,
      vat_amount: 0,
      vat_treatment: 'reverse_charge',
      remaining_amount: 1000,
    })
  })

  it('keeps a kronor registration\'s preview free of a rate', async () => {
    const { supabase, findCall } = books()
    await tool.execute(ARGS, COMPANY_ID, USER_ID, supabase as never, ACTOR)
    const staged = findCall('pending_operations', 'insert')?.[0] as { preview_data: Record<string, unknown> }
    expect(staged.preview_data.currency).toBe('SEK')
    expect(staged.preview_data).not.toHaveProperty('exchange_rate')
    expect(staged.preview_data).not.toHaveProperty('total_sek')
  })

  it('stages nothing on a dry run', async () => {
    const { supabase, findCall } = books()
    const result = (await tool.execute({ ...ARGS, dry_run: true }, COMPANY_ID, USER_ID, supabase as never, ACTOR)) as {
      dry_run?: boolean
      preview: Record<string, unknown>
    }
    expect(result.dry_run).toBe(true)
    expect(result.preview.status).toBe('partially_paid')
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('refuses a verifikat whose receivable is not the invoice total, with a code the agent can act on', async () => {
    const lines = SALE_LINES.map((line) =>
      line.account_number === '1510' ? { ...line, debit_amount: 13125 } : line,
    )
    const { supabase, findCall } = books(lines)
    const error = await tool.execute(ARGS, COMPANY_ID, USER_ID, supabase as never, ACTOR).catch((err: unknown) => err)

    const envelope = toToolError(error).error
    expect(envelope.code).toBe('INVOICE_REGISTER_AMOUNT_MISMATCH')
    expect(envelope.retryable).toBe(false)
    expect(envelope.message_en).toMatch(/B45 debits 151x by 13125 but the invoice total is 12500 SEK/)
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('refuses a company on kontantmetoden before staging anything', async () => {
    const { supabase, setTable, findCall } = books()
    setTable('company_settings', { data: { invoice_prefix: null, next_invoice_number: 2001, send_invoice_reminders: true, accounting_method: 'cash' } })
    const error = await tool.execute(ARGS, COMPANY_ID, USER_ID, supabase as never, ACTOR).catch((err: unknown) => err)

    const envelope = toToolError(error).error
    expect(envelope.code).toBe('INVOICE_REGISTER_CASH_METHOD')
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

  it('refuses a missing total as a field error before reading anything', async () => {
    const { supabase, calls } = books()
    const { total: _total, ...withoutTotal } = ARGS
    const error = await tool.execute(withoutTotal, COMPANY_ID, USER_ID, supabase as never, ACTOR).catch((err: unknown) => err)

    expect(toToolError(error).error.code).toBe('VALIDATION_ERROR')
    expect(String((error as Error).message)).toMatch(/total/)
    expect(calls).toEqual([])
  })
})
