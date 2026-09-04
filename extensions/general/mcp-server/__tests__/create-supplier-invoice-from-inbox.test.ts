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

const mockResolveRate = vi.fn()
vi.mock('@/lib/currency/supplier-invoice-rate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/currency/supplier-invoice-rate')>()
  return { ...actual, resolveSupplierInvoiceExchangeRate: (...args: unknown[]) => mockResolveRate(...args) }
})

describe('gnubok_create_supplier_invoice_from_inbox: registration', () => {
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
  /** When set, company_settings/dimensions/dimension_values serve this registry. */
  dimensions?: {
    enabled: boolean
    registry?: Array<Record<string, unknown>>
    values?: Array<Record<string, unknown>>
  }
  /** When provided, every pending_operations .insert(payload) is recorded here. */
  inserts?: Array<Record<string, unknown>>
  /** Served by the awaited (non-maybeSingle) suppliers list query: candidate search. */
  supplierList?: Array<Record<string, unknown>>
  /** Served by the .single() defaults/tenancy fetch. Pass explicit null to simulate a supplier missing from the company. */
  supplierRecord?: Record<string, unknown> | null
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
          if (prop === 'single') {
            return () =>
              Promise.resolve(
                'supplierRecord' in opts
                  ? { data: opts.supplierRecord, error: opts.supplierRecord ? null : { message: 'not found' } }
                  : { data: { id: 'resolved-supplier', default_expense_account: null }, error: null },
              )
          }
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) =>
              resolve(opts.supplierList ? { data: opts.supplierList, error: null } : supplierByOrgResult)
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
          if (prop === 'insert') {
            return (payload: Record<string, unknown>) => {
              opts.inserts?.push(payload)
              return pendingChain()
            }
          }
          if (prop === 'single') return () => Promise.resolve(insertResult)
          if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(insertResult)
          return () => pendingChain()
        },
      },
    )

  // Static chains for the dims registry (resolveDimensionBags reads these).
  const staticChain = (result: { data: unknown; error: unknown }): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'single' || prop === 'maybeSingle') return () => Promise.resolve(result)
          if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(result)
          return () => staticChain(result)
        },
      },
    )

  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'invoice_inbox_items') return inboxChain()
      if (table === 'suppliers') return supplierChain()
      if (table === 'pending_operations') return pendingChain()
      if (table === 'company_settings' && opts.dimensions) {
        return staticChain({ data: { dimensions_enabled: opts.dimensions.enabled }, error: null })
      }
      if (table === 'dimensions' && opts.dimensions) {
        return staticChain({ data: opts.dimensions.registry ?? [], error: null })
      }
      if (table === 'dimension_values' && opts.dimensions) {
        return staticChain({ data: opts.dimensions.values ?? [], error: null })
      }
      return inboxChain()
    }),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
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

describe('gnubok_create_supplier_invoice_from_inbox: execute', () => {
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

  it('derives vat_amount from summed line items, not the OCR totals block (regression: per-line VAT customization silently dropped VAT)', async () => {
    // Reported bug: totals.vat is an independent OCR-extracted field that was
    // never reconciled with lineItems. A stale/mis-extracted document total
    // (or a per-line VAT customization that didn't also fix up totals.vat)
    // used to flow straight through as the staged vat_amount, which becomes
    // the invoice header field that gates the WHOLE 2641 posting downstream
    // in createSupplierInvoiceRegistrationEntry. Deriving it from the items
    // instead keeps the header honest regardless of what the header block said.
    const staleTotals = {
      ...baseExtracted,
      totals: { subtotal: 1000, vat: 0, total: 1000 }, // stale: doesn't match the line below
      lineItems: [
        { description: 'Konsulttimmar', quantity: 10, unit_price: 100, line_total: 1000, vat_rate: 25, vat_amount: 250 },
      ],
    }
    const supabase = makeMock({
      inbox: {
        id: 'inbox-10',
        status: 'received',
        extracted_data: staleTotals,
        matched_supplier_id: 'supplier-1',
        created_supplier_invoice_id: null,
        document_id: 'doc-10',
      },
    })
    const tool = tools.find((t) => t.name === 'gnubok_create_supplier_invoice_from_inbox')!
    const result = (await tool.execute(
      { inbox_item_id: 'inbox-10', dry_run: true },
      'company-1', 'user-1', supabase,
    )) as { preview: { vat_amount: number } }

    // Must reflect the item's real VAT (250), not the stale header total (0).
    expect(result.preview.vat_amount).toBe(250)
  })

  it('resolves a foreign supplier by VAT number when the document carries no org number', async () => {
    // The extractor leaves orgNumber null for non-Swedish entities by design,
    // so momsregistreringsnumret is the only exact key an EU supplier has.
    const supabase = makeMock({
      inbox: {
        id: 'inbox-vat',
        status: 'received',
        extracted_data: {
          ...baseExtracted,
          supplier: {
            name: 'Adobe Systems Software Ireland Ltd',
            orgNumber: null,
            vatNumber: 'IE6364992H',
          },
        },
        matched_supplier_id: null,
        created_supplier_invoice_id: null,
        document_id: 'doc-vat',
      },
      supplierByOrg: null,
      supplierByName: null,
      supplierList: [
        { id: 'other-supplier', name: 'Some GmbH', org_number: null, vat_number: 'DE123456789' },
        {
          id: 'adobe-supplier',
          name: 'ADOBE SYSTEMS SOFTWARE IRELAND LTD',
          org_number: null,
          vat_number: 'IE6364992H',
        },
      ],
      supplierRecord: { id: 'adobe-supplier', default_expense_account: null },
    })
    const tool = tools.find((t) => t.name === 'gnubok_create_supplier_invoice_from_inbox')!
    const result = (await tool.execute(
      { inbox_item_id: 'inbox-vat', dry_run: true },
      'company-1', 'user-1', supabase,
    )) as { preview: { supplier_id: string; supplier_resolution: string; extracted_vat_number: string | null } }

    expect(result.preview.supplier_id).toBe('adobe-supplier')
    expect(result.preview.supplier_resolution).toBe('lookup_vat_number')
    expect(result.preview.extracted_vat_number).toBe('IE6364992H')
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

  it('unresolved supplier with no similar suppliers returns staged:false + create-supplier next hint', async () => {
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
    const result = (await tool.execute(
      { inbox_item_id: 'inbox-4' },
      'company-1', 'user-1', supabase,
    )) as {
      staged: boolean
      risk_level: string
      preview: { supplier_resolution: string; candidates: unknown[]; unresolved_supplier: Record<string, unknown> }
      next: { tool: string; args: Record<string, unknown> }
    }

    expect(result.staged).toBe(false)
    expect(result.risk_level).toBe('medium')
    expect(result.preview.supplier_resolution).toBe('unresolved')
    expect(result.preview.candidates).toEqual([])
    expect(result.preview.unresolved_supplier).toEqual({
      extracted_name: 'Acme AB',
      extracted_org_number: '5566778899',
      extracted_vat_number: null,
    })
    // Next hint prefills gnubok_create_supplier from the extraction.
    expect(result.next.tool).toBe('gnubok_create_supplier')
    expect(result.next.args).toEqual({ name: 'Acme AB', org_number: '5566778899' })
  })

  it('unresolved supplier with a near-miss candidate returns it with a retry-with-override next hint', async () => {
    const supabase = makeMock({
      inbox: {
        id: 'inbox-8',
        status: 'received',
        extracted_data: {
          ...baseExtracted,
          supplier: { name: 'Polarn o Pyret' }, // OCR variant: no punctuation, no AB, no org number
        },
        matched_supplier_id: null,
        created_supplier_invoice_id: null,
        document_id: 'doc-8',
      },
      supplierByOrg: null,
      supplierByName: null, // exact ilike on the full name misses the punctuation/suffix variant
      supplierList: [
        { id: 'sup-dnb', name: 'DNB Bank AB', org_number: '5169077454' },
        { id: 'sup-polarn', name: 'Polarn O. Pyret AB', org_number: '556235-8797' },
      ],
    })
    const tool = tools.find((t) => t.name === 'gnubok_create_supplier_invoice_from_inbox')!
    const result = (await tool.execute(
      { inbox_item_id: 'inbox-8' },
      'company-1', 'user-1', supabase,
    )) as {
      staged: boolean
      preview: { candidates: Array<{ supplier_id: string; score: number; matched_on: string }> }
      next: { tool: string; args: Record<string, unknown> }
    }

    expect(result.staged).toBe(false)
    expect(result.preview.candidates[0]).toMatchObject({
      supplier_id: 'sup-polarn',
      score: 1,
      matched_on: 'name',
    })
    // Next hint is the retry with the best candidate as override: the agent
    // confirms against the underlag; fuzzy never auto-resolves.
    expect(result.next.tool).toBe('gnubok_create_supplier_invoice_from_inbox')
    expect(result.next.args).toEqual({ inbox_item_id: 'inbox-8', supplier_id_override: 'sup-polarn' })
  })

  it('rejects a supplier_id_override that does not exist in the company', async () => {
    const supabase = makeMock({
      inbox: {
        id: 'inbox-9',
        status: 'received',
        extracted_data: baseExtracted,
        matched_supplier_id: null,
        created_supplier_invoice_id: null,
        document_id: 'doc-9',
      },
      supplierRecord: null, // tenancy fetch finds nothing for the override id
    })
    const tool = tools.find((t) => t.name === 'gnubok_create_supplier_invoice_from_inbox')!
    await expect(
      tool.execute(
        { inbox_item_id: 'inbox-9', supplier_id_override: 'sup-foreign' },
        'company-1', 'user-1', supabase,
      ),
    ).rejects.toThrow(/supplier_id_override sup-foreign does not match any supplier in this company/)
  })

  it('applies line_overrides: overridden account wins over extracted accountSuggestion', async () => {
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
    expect(items[0].account_number).toBe('6550')  // untouched, extracted suggestion wins
    expect(items[1].account_number).toBe('6420')  // override wins over extracted suggestion
  })

  it('stages resolved default_dimensions top-level and per-line bags via line_overrides', async () => {
    const extractedTwoLines = {
      ...baseExtracted,
      lineItems: [
        { description: 'Line A', quantity: 1, unit_price: 400, line_total: 400, vat_rate: 25, vat_amount: 100 },
        { description: 'Line B', quantity: 1, unit_price: 600, line_total: 600, vat_rate: 25, vat_amount: 150 },
      ],
    }
    const inserts: Array<Record<string, unknown>> = []
    const supabase = makeMock({
      inbox: {
        id: 'inbox-8',
        status: 'received',
        extracted_data: extractedTwoLines,
        matched_supplier_id: 'supplier-1',
        created_supplier_invoice_id: null,
        document_id: 'doc-8',
      },
      dimensions: {
        enabled: true,
        registry: [
          { id: 'dim-1', sie_dim_no: 1, name: 'Kostnadsställe', resets_annually: true, is_system: true, is_active: true, sort_order: 10 },
          { id: 'dim-6', sie_dim_no: 6, name: 'Projekt', resets_annually: false, is_system: true, is_active: true, sort_order: 20 },
        ],
        values: [
          { id: 'v1', dimension_id: 'dim-1', code: 'KS01', name: 'Stockholm', is_active: true, start_date: null, end_date: null },
          { id: 'v2', dimension_id: 'dim-6', code: 'P001', name: 'Villa Almgren takrenovering', is_active: true, start_date: null, end_date: null },
        ],
      },
      inserts,
    })
    const tool = tools.find((t) => t.name === 'gnubok_create_supplier_invoice_from_inbox')!
    const result = (await tool.execute(
      {
        inbox_item_id: 'inbox-8',
        default_dimensions: { '6': 'villa almgren tak' },
        line_overrides: [{ line_number: 2, dimensions: { '1': 'KS01' } }],
      },
      'company-1', 'user-1', supabase,
    )) as {
      staged: boolean
      preview: { dimension_resolutions?: Array<Record<string, unknown>> }
    }

    expect(result.staged).toBe(true)

    // Contract: staged params carry `default_dimensions` top-level (resolved to
    // codes) and each item its OWN resolved bag: the executor merges.
    expect(inserts).toHaveLength(1)
    const params = inserts[0].params as {
      default_dimensions?: Record<string, string>
      items: Array<{ dimensions?: Record<string, string> }>
    }
    expect(params.default_dimensions).toEqual({ '6': 'P001' })
    expect(params.items[0].dimensions).toBeUndefined()
    expect(params.items[1].dimensions).toEqual({ '1': 'KS01' })

    // Non-exact name resolution is echoed in the preview.
    expect(result.preview.dimension_resolutions).toHaveLength(1)
    expect(result.preview.dimension_resolutions![0]).toMatchObject({
      dimension: 6,
      input: 'villa almgren tak',
      resolved_code: 'P001',
      resolved_name: 'Villa Almgren takrenovering',
    })
  })

  it('stages no dims keys when nothing is tagged (backward compatible)', async () => {
    const inserts: Array<Record<string, unknown>> = []
    const supabase = makeMock({
      inbox: {
        id: 'inbox-9',
        status: 'received',
        extracted_data: baseExtracted,
        matched_supplier_id: 'supplier-1',
        created_supplier_invoice_id: null,
        document_id: 'doc-9',
      },
      inserts,
    })
    const tool = tools.find((t) => t.name === 'gnubok_create_supplier_invoice_from_inbox')!
    const result = (await tool.execute(
      { inbox_item_id: 'inbox-9' },
      'company-1', 'user-1', supabase,
    )) as { staged: boolean; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    expect(result.preview.dimension_resolutions).toBeUndefined()
    const params = inserts[0].params as { default_dimensions?: unknown; items: Array<Record<string, unknown>> }
    expect('default_dimensions' in params).toBe(false)
    expect('dimensions' in params.items[0]).toBe(false)
  })

  it('normalizes percent vatRate from the real AI extraction shape and derives per-line vat_amount (issue #310)', async () => {
    // Real ExtractionSchema output: camelCase keys, vatRate as a percent
    // integer, and NO per-line VAT amount field. Staging must convert to the
    // decimal convention of supplier_invoice_items (0.25) and derive the
    // line's vat_amount, or the committed invoice books 2500 % VAT with a
    // dishonest header vat_amount of 0.
    const realExtractionShape = {
      ...baseExtracted,
      totals: { subtotal: 1000, vatAmount: 250, total: 1250 },
      lineItems: [
        { description: 'Konsulttimmar', quantity: 10, unitPrice: 100, lineTotal: 1000, vatRate: 25, accountSuggestion: null },
      ],
    }
    const inserts: Array<Record<string, unknown>> = []
    const supabase = makeMock({
      inbox: {
        id: 'inbox-vat-1',
        status: 'received',
        extracted_data: realExtractionShape,
        matched_supplier_id: 'supplier-1',
        created_supplier_invoice_id: null,
        document_id: 'doc-vat-1',
      },
      inserts,
    })
    const tool = tools.find((t) => t.name === 'gnubok_create_supplier_invoice_from_inbox')!
    const result = (await tool.execute(
      { inbox_item_id: 'inbox-vat-1' },
      'company-1', 'user-1', supabase,
    )) as { staged: boolean }

    expect(result.staged).toBe(true)
    const params = inserts[0].params as {
      vat_amount: number
      items: Array<{ vat_rate: number; vat_amount: number; line_total: number }>
    }
    expect(params.items[0].vat_rate).toBe(0.25)
    expect(params.items[0].vat_amount).toBe(250)
    expect(params.items[0].line_total).toBe(1000)
    // Header vat_amount is summed from the derived per-line amounts.
    expect(params.vat_amount).toBe(250)
  })

  it('passes already-decimal vat_rate through unchanged and zeroes foreign percent rates', async () => {
    const mixedRates = {
      ...baseExtracted,
      lineItems: [
        // Already decimal (staged by an agent following the storage convention).
        { description: 'Svensk tjänst', quantity: 1, unit_price: 1000, line_total: 1000, vat_rate: 0.12, vat_amount: 120 },
        // Foreign rate (DE 19 %): outside the Swedish statutory set, maps to 0
        // per the extraction contract.
        { description: 'Utländsk tjänst', quantity: 1, unitPrice: 500, lineTotal: 500, vatRate: 19 },
      ],
    }
    const inserts: Array<Record<string, unknown>> = []
    const supabase = makeMock({
      inbox: {
        id: 'inbox-vat-2',
        status: 'received',
        extracted_data: mixedRates,
        matched_supplier_id: 'supplier-1',
        created_supplier_invoice_id: null,
        document_id: 'doc-vat-2',
      },
      inserts,
    })
    const tool = tools.find((t) => t.name === 'gnubok_create_supplier_invoice_from_inbox')!
    const result = (await tool.execute(
      { inbox_item_id: 'inbox-vat-2' },
      'company-1', 'user-1', supabase,
    )) as { staged: boolean }

    expect(result.staged).toBe(true)
    const params = inserts[0].params as {
      vat_amount: number
      items: Array<{ vat_rate: number; vat_amount: number }>
    }
    expect(params.items[0].vat_rate).toBe(0.12)
    expect(params.items[0].vat_amount).toBe(120)
    expect(params.items[1].vat_rate).toBe(0)
    expect(params.items[1].vat_amount).toBe(0)
    expect(params.vat_amount).toBe(120)
  })

  it('rejects apply_slp when the line resolves to a non-741x account (staging-time guard)', async () => {
    // The executor (commitCreateSupplierInvoiceFromInbox) refuses the same
    // combination at commit time; rejecting at staging means the agent learns
    // immediately instead of a human approving a doomed operation.
    const supabase = makeMock({
      inbox: {
        id: 'inbox-slp-1',
        status: 'received',
        extracted_data: baseExtracted, // line resolves to supplier default / 4000
        matched_supplier_id: 'supplier-1',
        created_supplier_invoice_id: null,
        document_id: 'doc-slp-1',
      },
    })
    const tool = tools.find((t) => t.name === 'gnubok_create_supplier_invoice_from_inbox')!
    await expect(
      tool.execute(
        {
          inbox_item_id: 'inbox-slp-1',
          line_overrides: [{ line_number: 1, apply_slp: true }],
        },
        'company-1', 'user-1', supabase,
      ),
    ).rejects.toThrow(/7410-7419/)
  })

  it('stages apply_slp into the operation items when the line resolves to a 741x account', async () => {
    const inserts: Array<Record<string, unknown>> = []
    const supabase = makeMock({
      inbox: {
        id: 'inbox-slp-2',
        status: 'received',
        extracted_data: {
          ...baseExtracted,
          lineItems: [
            { description: 'Tjänstepension', quantity: 1, unit_price: 10000, line_total: 10000, vat_rate: 0, vat_amount: 0 },
          ],
        },
        matched_supplier_id: 'supplier-1',
        created_supplier_invoice_id: null,
        document_id: 'doc-slp-2',
      },
      inserts,
    })
    const tool = tools.find((t) => t.name === 'gnubok_create_supplier_invoice_from_inbox')!
    const result = (await tool.execute(
      {
        inbox_item_id: 'inbox-slp-2',
        line_overrides: [{ line_number: 1, account_number: '7412', apply_slp: true }],
      },
      'company-1', 'user-1', supabase,
    )) as { staged: boolean }

    expect(result.staged).toBe(true)
    const params = inserts[0].params as {
      items: Array<{ account_number: string; apply_slp?: boolean }>
    }
    // The executor reads item.apply_slp === true to book the 7533/2514 pair:
    // without this plumbing the flag was unreachable from MCP.
    expect(params.items[0].account_number).toBe('7412')
    expect(params.items[0].apply_slp).toBe(true)
  })

  it('invoice_date_override rescues an inbox item with no extracted invoiceDate', async () => {
    const extractedNoDate = {
      ...baseExtracted,
      invoice: { ...baseExtracted.invoice, invoiceDate: null },
    }
    const supabase = makeMock({
      inbox: {
        id: 'inbox-10',
        status: 'received',
        extracted_data: extractedNoDate,
        matched_supplier_id: 'supplier-1',
        created_supplier_invoice_id: null,
        document_id: 'doc-10',
      },
    })
    const tool = tools.find((t) => t.name === 'gnubok_create_supplier_invoice_from_inbox')!
    const result = (await tool.execute(
      { inbox_item_id: 'inbox-10', dry_run: true, invoice_date_override: '2025-07-15' },
      'company-1', 'user-1', supabase,
    )) as { dry_run: boolean; preview: { invoice_date: string } }

    expect(result.dry_run).toBe(true)
    expect(result.preview.invoice_date).toBe('2025-07-15')
  })

  it('rejects a non-ISO invoice_date_override before staging', async () => {
    const supabase = makeMock({
      inbox: {
        id: 'inbox-11',
        status: 'received',
        extracted_data: baseExtracted,
        matched_supplier_id: 'supplier-1',
        created_supplier_invoice_id: null,
        document_id: 'doc-11',
      },
    })
    const tool = tools.find((t) => t.name === 'gnubok_create_supplier_invoice_from_inbox')!
    await expect(
      tool.execute(
        { inbox_item_id: 'inbox-11', dry_run: true, invoice_date_override: '15/07/2025' },
        'company-1', 'user-1', supabase,
      ),
    ).rejects.toThrow(/invoice_date_override must be an ISO date/)
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

/**
 * FX resolution at staging time (feedback seq 299742): the tool used to call
 * fetchExchangeRate WITHOUT the supabase client, so neither the shared
 * exchange_rates cache nor the last-cached-observation fallback was reachable
 * and a Riksbanken 429 surfaced as exchange_rate: null / lookup_failed for a
 * date that resolved fine a minute later. The staged op was then unapprovable
 * (SI_FX_RATE_MISSING at commit) with no way to supply the rate.
 */
describe('gnubok_create_supplier_invoice_from_inbox: exchange rate resolution', () => {
  const usdExtracted = {
    ...baseExtracted,
    invoice: { ...baseExtracted.invoice, currency: 'USD', invoiceDate: '2026-04-24' },
  }
  const usdInbox = {
    id: 'inbox-usd',
    status: 'received',
    extracted_data: usdExtracted,
    matched_supplier_id: 'supplier-1',
    created_supplier_invoice_id: null,
    document_id: 'doc-usd',
  }
  const tool = () => tools.find((t) => t.name === 'gnubok_create_supplier_invoice_from_inbox')!

  beforeEach(() => {
    vi.clearAllMocks()
    mockResolveRate.mockReset()
  })

  it('resolves through the shared resolver WITH the supabase client (cache + last-cached fallback reachable)', async () => {
    mockResolveRate.mockResolvedValue({
      ok: true,
      rate: { currency: 'USD', rate: 9.51731, exchangeRate: 9.51731, exchangeRateDate: '2026-04-24', source: 'fetched' },
    })
    const supabase = makeMock({ inbox: usdInbox })
    const result = (await tool().execute(
      { inbox_item_id: 'inbox-usd', dry_run: true },
      'company-1',
      'user-1',
      supabase,
    )) as { preview: Record<string, unknown> }

    expect(mockResolveRate).toHaveBeenCalledWith(supabase, {
      currency: 'USD',
      invoiceDate: '2026-04-24',
      suppliedRate: null,
    })
    expect(result.preview.exchange_rate).toBe(9.51731)
    expect(result.preview.exchange_rate_source).toBe('riksbanken')
    expect(result.preview.exchange_rate_hint).toBeUndefined()
  })

  it('exchange_rate_override is passed as the supplied rate and echoed as source "supplied"', async () => {
    mockResolveRate.mockResolvedValue({
      ok: true,
      rate: { currency: 'USD', rate: 9.6, exchangeRate: 9.6, exchangeRateDate: null, source: 'supplied' },
    })
    const inserts: Array<Record<string, unknown>> = []
    const supabase = makeMock({ inbox: usdInbox, inserts })
    const result = (await tool().execute(
      { inbox_item_id: 'inbox-usd', exchange_rate_override: 9.6 },
      'company-1',
      'user-1',
      supabase,
    )) as { preview: Record<string, unknown> }

    expect(mockResolveRate).toHaveBeenCalledWith(supabase, {
      currency: 'USD',
      invoiceDate: '2026-04-24',
      suppliedRate: 9.6,
    })
    expect(result.preview.exchange_rate).toBe(9.6)
    expect(result.preview.exchange_rate_source).toBe('supplied')
    // The staged params carry the rate the reviewer saw, so the executor's
    // resolver trusts it verbatim instead of re-fetching.
    const staged = inserts[0]?.params as Record<string, unknown> | undefined
    expect(staged?.exchange_rate).toBe(9.6)
  })

  it('lookup failure stays visible as lookup_failed and tells the agent what unblocks approval', async () => {
    mockResolveRate.mockResolvedValue({ ok: false, currency: 'USD', invoiceDate: '2026-04-24' })
    const supabase = makeMock({ inbox: usdInbox })
    const result = (await tool().execute(
      { inbox_item_id: 'inbox-usd', dry_run: true },
      'company-1',
      'user-1',
      supabase,
    )) as { preview: Record<string, unknown> }

    expect(result.preview.exchange_rate).toBeNull()
    expect(result.preview.exchange_rate_source).toBe('lookup_failed')
    expect(result.preview.exchange_rate_hint).toMatch(/exchange_rate_override \(SEK per 1 USD\)/)
  })

  it('rejects a non-positive or non-numeric exchange_rate_override before touching the resolver', async () => {
    const supabase = makeMock({ inbox: usdInbox })
    await expect(
      tool().execute({ inbox_item_id: 'inbox-usd', exchange_rate_override: '9,6' }, 'company-1', 'user-1', supabase),
    ).rejects.toThrow(/exchange_rate_override must be a positive number \(SEK per 1 USD\); got "9,6"/)
    await expect(
      tool().execute({ inbox_item_id: 'inbox-usd', exchange_rate_override: 0 }, 'company-1', 'user-1', supabase),
    ).rejects.toThrow(/must be a positive number/)
    expect(mockResolveRate).not.toHaveBeenCalled()
  })

  it('an implausible override is refused with a pointer at the invoice, never silently replaced', async () => {
    mockResolveRate.mockResolvedValue({ ok: false, currency: 'USD', invoiceDate: '2026-04-24' })
    const supabase = makeMock({ inbox: usdInbox })
    await expect(
      tool().execute({ inbox_item_id: 'inbox-usd', exchange_rate_override: 250000 }, 'company-1', 'user-1', supabase),
    ).rejects.toThrow(/exchange_rate_override 250000 was refused as implausible/)
  })

  it('a SEK invoice does not consult the resolver and reports not_applicable', async () => {
    const supabase = makeMock({
      inbox: { ...usdInbox, id: 'inbox-sek', extracted_data: baseExtracted },
    })
    const result = (await tool().execute(
      { inbox_item_id: 'inbox-sek', dry_run: true },
      'company-1',
      'user-1',
      supabase,
    )) as { preview: Record<string, unknown> }
    expect(mockResolveRate).not.toHaveBeenCalled()
    expect(result.preview.exchange_rate_source).toBe('not_applicable')
  })
})
