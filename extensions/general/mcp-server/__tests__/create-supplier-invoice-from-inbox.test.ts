/**
 * Unit tests for gnubok_create_supplier_invoice_from_inbox.
 *
 * Verifies registration, scope, supplier-resolution branches, dry_run preview,
 * already-converted guard, and the missing-extraction error.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tools } from '../server'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'
import { OPERATION_RISK_TIERS } from '@/lib/pending-operations/risk-tiers'

vi.mock('@/lib/currency/riksbanken', () => ({
  fetchExchangeRate: vi.fn().mockResolvedValue(11.5),
  convertToSEK: vi.fn(),
}))

describe('gnubok_create_supplier_invoice_from_inbox — registration', () => {
  it('is registered with idempotent + non-read-only annotations', () => {
    const tool = tools.find((t) => t.name === 'gnubok_create_supplier_invoice_from_inbox')
    expect(tool).toBeDefined()
    expect(tool?.annotations.readOnlyHint).toBe(false)
    expect(tool?.annotations.idempotentHint).toBe(true)
    expect(tool?.annotations.destructiveHint).toBe(false)
  })

  it('requires inbox_item_id', () => {
    const tool = tools.find((t) => t.name === 'gnubok_create_supplier_invoice_from_inbox')!
    const schema = tool.inputSchema as { required?: string[] }
    expect(schema.required).toContain('inbox_item_id')
  })

  it('is mapped to suppliers:write scope', () => {
    expect(TOOL_SCOPE_MAP.gnubok_create_supplier_invoice_from_inbox).toBe('suppliers:write')
  })

  it('is classified as medium risk', () => {
    expect(OPERATION_RISK_TIERS.create_supplier_invoice_from_inbox).toBe('medium')
  })
})

/**
 * Build a supabase mock that:
 *  - returns the given inbox row from .from('invoice_inbox_items').select(...).eq(...).eq(...).single()
 *  - returns the given supplier row from .from('suppliers') lookups
 *  - resolves the pending_operations insert
 */
function makeMock(opts: {
  inbox?: Record<string, unknown> | null
  supplierByOrg?: Record<string, unknown> | null
  supplierByName?: Record<string, unknown> | null
  pendingInsert?: Record<string, unknown>
}) {
  const inboxResult = { data: opts.inbox ?? null, error: opts.inbox ? null : { message: 'not found' } }
  const supplierByOrgResult = { data: opts.supplierByOrg ?? null, error: null }
  const supplierByNameResult = { data: opts.supplierByName ?? null, error: null }
  const insertResult = { data: opts.pendingInsert ?? { id: 'op-1' }, error: null }

  // suppliers lookups distinguish by query method: org_number → .eq() chain ending in maybeSingle()
  // name → .ilike() chain ending in maybeSingle().
  // We stub by tracking the most recent .eq vs .ilike call. Simpler: return
  // org-result first, name-result second (the tool falls through).
  let supplierLookupCall = 0
  const supplierChain = (): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'maybeSingle') {
            return () => {
              supplierLookupCall++
              return Promise.resolve(supplierLookupCall === 1 ? supplierByOrgResult : supplierByNameResult)
            }
          }
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) => resolve(supplierByOrgResult)
          }
          return () => supplierChain()
        },
      },
    )

  const inboxChain = (): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'single') return () => Promise.resolve(inboxResult)
          if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(inboxResult)
          return () => inboxChain()
        },
      },
    )

  const pendingChain = (): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'single') return () => Promise.resolve(insertResult)
          if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(insertResult)
          return () => pendingChain()
        },
      },
    )

  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'invoice_inbox_items') return inboxChain()
      if (table === 'suppliers') return supplierChain()
      if (table === 'pending_operations') return pendingChain()
      return inboxChain()
    }),
  } as never
}

const baseExtracted = {
  supplier: { name: 'Acme AB', organizationNumber: '5566778899' },
  invoice: { invoiceNumber: 'INV-100', invoiceDate: '2026-03-15', dueDate: '2026-04-14', currency: 'SEK' },
  totals: { subtotal: 1000, vat: 250, total: 1250 },
  lineItems: [
    { description: 'Konsulttimmar', quantity: 10, unit_price: 100, line_total: 1000, vat_rate: 25, vat_amount: 250 },
  ],
}

describe('gnubok_create_supplier_invoice_from_inbox — execute', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('dry_run returns preview without inserting pending_operations', async () => {
    const supabase = makeMock({
      inbox: {
        id: 'inbox-1',
        status: 'received',
        extracted_data: baseExtracted,
        matched_supplier_id: 'supplier-1',
        created_supplier_invoice_id: null,
        document_id: 'doc-1',
      },
    })
    const tool = tools.find((t) => t.name === 'gnubok_create_supplier_invoice_from_inbox')!
    const result = (await tool.execute(
      { inbox_item_id: 'inbox-1', dry_run: true },
      'company-1',
      'user-1',
      supabase,
    )) as { dry_run?: boolean; staged: boolean; preview: Record<string, unknown> }

    expect(result.dry_run).toBe(true)
    expect(result.staged).toBe(false)
    expect(result.preview.supplier_id).toBe('supplier-1')
    expect(result.preview.supplier_resolution).toBe('matched')
    expect(result.preview.total).toBe(1250)
  })

  it('falls through to org_number lookup when no matched supplier', async () => {
    const supabase = makeMock({
      inbox: {
        id: 'inbox-2',
        status: 'received',
        extracted_data: baseExtracted,
        matched_supplier_id: null,
        created_supplier_invoice_id: null,
        document_id: 'doc-2',
      },
      supplierByOrg: { id: 'supplier-org-lookup' },
    })
    const tool = tools.find((t) => t.name === 'gnubok_create_supplier_invoice_from_inbox')!
    const result = (await tool.execute(
      { inbox_item_id: 'inbox-2', dry_run: true },
      'company-1', 'user-1', supabase,
    )) as { preview: { supplier_resolution: string; supplier_id: string } }

    expect(result.preview.supplier_id).toBe('supplier-org-lookup')
    expect(result.preview.supplier_resolution).toBe('lookup_org_number')
  })

  it('falls through to name lookup when org_number returns null', async () => {
    const supabase = makeMock({
      inbox: {
        id: 'inbox-7',
        status: 'received',
        extracted_data: baseExtracted,
        matched_supplier_id: null,
        created_supplier_invoice_id: null,
        document_id: 'doc-7',
      },
      supplierByOrg: null,
      supplierByName: { id: 'supplier-name-lookup' },
    })
    const tool = tools.find((t) => t.name === 'gnubok_create_supplier_invoice_from_inbox')!
    const result = (await tool.execute(
      { inbox_item_id: 'inbox-7', dry_run: true },
      'company-1', 'user-1', supabase,
    )) as { preview: { supplier_resolution: string; supplier_id: string } }

    expect(result.preview.supplier_id).toBe('supplier-name-lookup')
    expect(result.preview.supplier_resolution).toBe('lookup_name')
  })

  it('throws when inbox item already converted', async () => {
    const supabase = makeMock({
      inbox: {
        id: 'inbox-3',
        status: 'received',
        extracted_data: baseExtracted,
        matched_supplier_id: 'supplier-1',
        created_supplier_invoice_id: 'si-existing',
        document_id: 'doc-3',
      },
    })
    const tool = tools.find((t) => t.name === 'gnubok_create_supplier_invoice_from_inbox')!
    await expect(
      tool.execute({ inbox_item_id: 'inbox-3' }, 'company-1', 'user-1', supabase),
    ).rejects.toThrow(/already converted/)
  })

  it('throws when supplier cannot be resolved', async () => {
    const supabase = makeMock({
      inbox: {
        id: 'inbox-4',
        status: 'received',
        extracted_data: baseExtracted,
        matched_supplier_id: null,
        created_supplier_invoice_id: null,
        document_id: 'doc-4',
      },
      supplierByOrg: null,
      supplierByName: null,
    })
    const tool = tools.find((t) => t.name === 'gnubok_create_supplier_invoice_from_inbox')!
    await expect(
      tool.execute({ inbox_item_id: 'inbox-4', dry_run: true }, 'company-1', 'user-1', supabase),
    ).rejects.toThrow(/Cannot resolve supplier/)
  })

  it('applies line_overrides — overridden account wins over extracted accountSuggestion', async () => {
    const extractedWithSuggestion = {
      ...baseExtracted,
      lineItems: [
        { description: 'Line A', quantity: 1, unit_price: 400, line_total: 400, vat_rate: 25, vat_amount: 100, accountSuggestion: '6550' },
        { description: 'Line B', quantity: 1, unit_price: 600, line_total: 600, vat_rate: 25, vat_amount: 150, accountSuggestion: '6550' },
      ],
    }
    const supabase = makeMock({
      inbox: {
        id: 'inbox-6',
        status: 'received',
        extracted_data: extractedWithSuggestion,
        matched_supplier_id: 'supplier-1',
        created_supplier_invoice_id: null,
        document_id: 'doc-6',
      },
    })
    const tool = tools.find((t) => t.name === 'gnubok_create_supplier_invoice_from_inbox')!
    const result = (await tool.execute(
      {
        inbox_item_id: 'inbox-6',
        dry_run: true,
        line_overrides: [{ line_number: 2, account_number: '6420' }],
      },
      'company-1', 'user-1', supabase,
    )) as { preview: { items_preview: Array<{ line_number: number; account_number: string }> } }

    const items = result.preview.items_preview
    expect(items[0].account_number).toBe('6550')  // untouched — extracted suggestion wins
    expect(items[1].account_number).toBe('6420')  // override wins over extracted suggestion
  })

  it('throws when extracted_data is missing', async () => {
    const supabase = makeMock({
      inbox: {
        id: 'inbox-5',
        status: 'received',
        extracted_data: null,
        matched_supplier_id: 'supplier-1',
        created_supplier_invoice_id: null,
        document_id: null,
      },
    })
    const tool = tools.find((t) => t.name === 'gnubok_create_supplier_invoice_from_inbox')!
    await expect(
      tool.execute({ inbox_item_id: 'inbox-5' }, 'company-1', 'user-1', supabase),
    ).rejects.toThrow(/no extracted_data/)
  })
})
