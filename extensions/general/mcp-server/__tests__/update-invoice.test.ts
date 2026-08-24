import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'
import { OPERATION_RISK_TIERS } from '@/lib/pending-operations/risk-tiers'
import { tools } from '../server'

const INVOICE_ID = '22222222-2222-4222-8222-222222222222'
const tool = () => tools.find((candidate) => candidate.name === 'gnubok_update_invoice')!

function draftInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: INVOICE_ID,
    invoice_number: null,
    status: 'draft',
    document_type: 'invoice',
    journal_entry_id: null,
    is_self_billed: false,
    credited_invoice_id: null,
    customer_id: 'cust-1',
    total: 12500,
    currency: 'SEK',
    customer: { name: 'Acme AB' },
    ...overrides,
  }
}

const CUSTOMER = {
  id: 'cust-1',
  name: 'Acme AB',
  customer_type: 'swedish_business',
  vat_number_validated: false,
  default_payment_terms: 30,
}

describe('gnubok_update_invoice: registration', () => {
  it('is a strict, staged invoices:write tool at medium risk', () => {
    expect(tool()).toBeDefined()
    expect(tool().inputSchema.additionalProperties).toBe(false)
    expect(tool().annotations.readOnlyHint).toBe(false)
    expect(tool().annotations.destructiveHint).toBe(false)
    expect(tool().annotations.idempotentHint).toBe(true)
    expect(tool().catalogVisibility).toBe('search')
    expect(TOOL_SCOPE_MAP.gnubok_update_invoice).toBe('invoices:write')
    expect(OPERATION_RISK_TIERS.update_invoice).toBe('medium')
  })

  it('returns the staged-operation envelope (staged completion signal)', () => {
    const schema = tool().outputSchema as { properties?: Record<string, unknown>; required?: string[] }
    expect(schema?.properties?.staged).toBeDefined()
    expect(schema?.required).toContain('staged')
  })

  it('keeps its description within the 280-char budget and declares staging', () => {
    expect(tool().description.length).toBeLessThanOrEqual(280)
    expect(tool().description).toMatch(/stag(e|ing)/i)
  })

  it('does not accept structural or server-controlled fields', () => {
    const properties = tool().inputSchema.properties as Record<string, unknown>
    for (const forbidden of ['customer_id', 'currency', 'document_type', 'invoice_number', 'status']) {
      expect(properties, `must not expose ${forbidden}`).not.toHaveProperty(forbidden)
    }
  })
})

describe('gnubok_update_invoice: validation and staging', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('requires invoice_id', async () => {
    const { supabase } = createQueuedMockSupabase()

    await expect(
      tool().execute({ notes: 'x' }, 'company-1', 'user-1', supabase as never),
    ).rejects.toThrow(/invoice_id/i)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('requires at least one changed field', async () => {
    const { supabase } = createQueuedMockSupabase()

    await expect(
      tool().execute(
        { invoice_id: INVOICE_ID, dry_run: true },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/at least one/i)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('rejects an empty items array (full-replace needs at least one line)', async () => {
    const { supabase } = createQueuedMockSupabase()

    await expect(
      tool().execute(
        { invoice_id: INVOICE_ID, items: [] },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/non-empty/i)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('rejects an item without a positive quantity before querying', async () => {
    const { supabase } = createQueuedMockSupabase()

    await expect(
      tool().execute(
        {
          invoice_id: INVOICE_ID,
          items: [{ description: 'Konsultation', quantity: 0, unit: 'tim', unit_price: 1000 }],
        },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/quantity/i)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('fails when the invoice is outside the selected company', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })

    await expect(
      tool().execute(
        { invoice_id: INVOICE_ID, notes: 'Ny anteckning' },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/not found/i)
  })

  it.each([
    ['sent invoice', { status: 'sent' }],
    ['paid invoice', { status: 'paid' }],
    ['draft with a posted verifikat', { journal_entry_id: 'je-1' }],
    ['self-billed draft', { is_self_billed: true }],
    ['credit-note draft', { credited_invoice_id: '33333333-3333-4333-8333-333333333333' }],
  ])('refuses a %s at staging time', async (_label, overrides) => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: draftInvoice(overrides) })

    await expect(
      tool().execute(
        { invoice_id: INVOICE_ID, notes: 'Ny anteckning' },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/not an editable draft/i)
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })

  it('returns a dry-run preview without staging', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: draftInvoice() })

    const result = (await tool().execute(
      { invoice_id: INVOICE_ID, due_date: '2026-08-31', dry_run: true },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; dry_run?: boolean; preview: Record<string, unknown> }

    expect(result.staged).toBe(false)
    expect(result.dry_run).toBe(true)
    expect(result.preview).toMatchObject({
      invoice_id: INVOICE_ID,
      customer_name: 'Acme AB',
      changes: { due_date: '2026-08-31' },
    })
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })

  it('stages a header edit for approval', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: draftInvoice() })
    enqueue({ data: { id: 'op-invoice-1' } })

    const result = (await tool().execute(
      { invoice_id: INVOICE_ID, notes: 'Uppdaterad anteckning' },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; operation_id?: string; risk_level: string }

    expect(result).toMatchObject({
      staged: true,
      operation_id: 'op-invoice-1',
      risk_level: 'medium',
    })
    expect(supabase.from).toHaveBeenNthCalledWith(2, 'pending_operations')
  })

  it('stages a full item replace with the replace marker and a rebooking-readable preview', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: draftInvoice() })
    enqueue({ data: CUSTOMER })
    // The lines being replaced, for the old-vs-new approval preview.
    enqueue({
      data: [
        {
          line_type: 'product',
          description: 'Konsultation',
          quantity: 1,
          unit: 'tim',
          unit_price: 1000,
          line_total: 1000,
          vat_rate: 25,
          article_id: null,
          revenue_account: '3041',
        },
      ],
    })
    enqueue({ data: { id: 'op-invoice-2' } })

    const result = (await tool().execute(
      {
        invoice_id: INVOICE_ID,
        items: [
          { description: 'Konsultation', quantity: 2, unit: 'tim', unit_price: 1000, vat_rate: 25 },
        ],
      },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    expect(result.preview).toMatchObject({
      invoice_id: INVOICE_ID,
      items_replace: true,
      item_count: 1,
      subtotal: 2000,
      vat_amount: 500,
      total: 2500,
      currency: 'SEK',
    })
    // Per-line revenue_account and vat_rate are in the preview (issue #1642):
    // the approver must be able to see a rebooking before approving.
    const items = (result.preview as { items: Array<Record<string, unknown>> }).items
    expect(items[0]).toMatchObject({
      description: 'Konsultation',
      quantity: 2,
      line_total: 2000,
      vat_rate: 25,
      revenue_account: null,
    })
    const currentItems = (result.preview as { current_items: Array<Record<string, unknown>> }).current_items
    expect(currentItems[0]).toMatchObject({
      description: 'Konsultation',
      quantity: 1,
      vat_rate: 25,
      revenue_account: '3041',
    })
  })

  it('keeps an explicit revenue_account on a full-replace line (round trip, no silent drop)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: draftInvoice() })
    enqueue({ data: CUSTOMER })
    enqueue({ data: [] }) // current invoice_items
    enqueue({ data: { id: 'op-invoice-3' } })

    const result = (await tool().execute(
      {
        invoice_id: INVOICE_ID,
        items: [
          {
            description: 'Deposition',
            quantity: 1,
            unit: 'st',
            unit_price: 5000,
            vat_rate: 0,
            revenue_account: '2421',
          },
        ],
      },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; preview: { changes: { items: Array<Record<string, unknown>> } } }

    expect(result.staged).toBe(true)
    expect(result.preview.changes.items[0]).toMatchObject({ revenue_account: '2421', vat_rate: 0 })
  })

  it('normalizes a free-text row to the zero shape instead of rejecting it', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: draftInvoice() })
    enqueue({ data: CUSTOMER })
    enqueue({ data: [] }) // current invoice_items
    enqueue({ data: { id: 'op-invoice-4' } })

    const result = (await tool().execute(
      {
        invoice_id: INVOICE_ID,
        items: [
          { line_type: 'text', description: 'Avser projekt Almgren', quantity: 0 },
          { description: 'Konsultation', quantity: 1, unit: 'tim', unit_price: 1000, vat_rate: 25 },
        ],
      },
      'company-1',
      'user-1',
      supabase as never,
    )) as {
      staged: boolean
      preview: { subtotal: number; total: number; changes: { items: Array<Record<string, unknown>> } }
    }

    expect(result.staged).toBe(true)
    expect(result.preview.changes.items[0]).toMatchObject({
      line_type: 'text',
      description: 'Avser projekt Almgren',
      quantity: 0,
      unit: '',
      unit_price: 0,
    })
    // Text rows are excluded from totals.
    expect(result.preview.subtotal).toBe(1000)
    expect(result.preview.total).toBe(1250)
  })

  it('refuses at staging a VAT rate outside the customer permitted set', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: draftInvoice() })
    enqueue({ data: CUSTOMER })

    await expect(
      tool().execute(
        {
          invoice_id: INVOICE_ID,
          items: [{ description: 'Konsultation', quantity: 1, unit: 'tim', unit_price: 1000, vat_rate: 13 }],
        },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/not allowed/i)
  })
})
