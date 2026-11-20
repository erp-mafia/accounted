/**
 * Unit tests for gnubok_create_supplier_invoice_from_inbox.
 *
 * Verifies registration, scope, supplier-resolution branches, dry_run preview,
 * already-converted guard, and the missing-extraction error.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { roundOre } from '@/lib/money'
import { tools } from '../server'
import { toToolError } from '../tool-result'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'
import { OPERATION_RISK_TIERS } from '@/lib/pending-operations/risk-tiers'
import { buildSupplierInvoiceRegistrationEntryInput } from '@/lib/bookkeeping/supplier-invoice-entries'
import { makeSupplierInvoice } from '@/tests/helpers'
import { bookLimitedDeduction, type LimitedDeductionRow } from '@/lib/supplier-invoices/limited-deduction'
import { stagedConversion } from '@/lib/operations/inbox-convert'
import { getStructuredError } from '@/lib/errors/get-structured-error'
import { SI_CREATE_INVALID_INPUT_REASONS } from '@/lib/errors/structured-errors'
import type { SupplierInvoice, SupplierInvoiceItem } from '@/types'

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
  /** When provided, every suppliers .update(payload) is recorded here. */
  supplierUpdates?: Array<Record<string, unknown>>
  /** Served by the awaited (non-maybeSingle) suppliers list query: candidate search. */
  supplierList?: Array<Record<string, unknown>>
  /** Served by the .single() defaults/tenancy fetch. Pass explicit null to simulate a supplier missing from the company. */
  supplierRecord?: Record<string, unknown> | null
  /** When set, company_settings serves this vat_registered flag. */
  vatRegistered?: boolean
  /** When set, company_settings also serves these columns (booking mode). */
  companySettings?: Record<string, unknown>
  /** When set, the company_settings read answers exactly this (a failed or empty read). */
  settingsRead?: { data: unknown; error: unknown }
}) {
  const inboxResult = { data: opts.inbox ?? null, error: opts.inbox ? null : { message: 'not found' } }
  const supplierByOrgResult = { data: opts.supplierByOrg ?? null, error: null }
  const supplierByNameResult = { data: opts.supplierByName ?? null, error: null }
  const insertResult = { data: opts.pendingInsert ?? { id: 'op-1' }, error: null }

  // suppliers lookups distinguish by query method: the org_number and
  // vat_number scans and the candidate search are awaited list queries
  // (served by supplierList); the exact org_number lookup for a non-Swedish
  // value is an .eq() chain ending in maybeSingle() and the name lookup an
  // .ilike() chain ending in maybeSingle(). The last filter method decides
  // which single-row result maybeSingle() serves.
  let lastFilter: 'eq' | 'ilike' = 'eq'
  const supplierChain = (): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'eq') {
            return (column: string) => {
              if (column !== 'company_id') lastFilter = 'eq'
              return supplierChain()
            }
          }
          if (prop === 'ilike') {
            return () => {
              lastFilter = 'ilike'
              return supplierChain()
            }
          }
          if (prop === 'update') {
            return (payload: Record<string, unknown>) => {
              opts.supplierUpdates?.push(payload)
              return supplierChain()
            }
          }
          if (prop === 'maybeSingle') {
            return () =>
              Promise.resolve(lastFilter === 'ilike' ? supplierByNameResult : supplierByOrgResult)
          }
          if (prop === 'single') {
            return () =>
              Promise.resolve(
                'supplierRecord' in opts
                  ? { data: opts.supplierRecord, error: opts.supplierRecord ? null : { message: 'not found' } }
                  : { data: { id: 'resolved-supplier', default_expense_account: '6540' }, error: null },
              )
          }
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) =>
              resolve({ data: opts.supplierList ?? [], error: null })
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
      // The settings row every company has (accounting_method is NOT NULL):
      // faktureringsmetoden, VAT-registered, unless the test says otherwise.
      if (table === 'company_settings') {
        return staticChain(opts.settingsRead ?? {
          data: {
            accounting_method: 'accrual',
            vat_registered: opts.vatRegistered ?? true,
            dimensions_enabled: opts.dimensions?.enabled ?? false,
            ...opts.companySettings,
          },
          error: null,
        })
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
    // The total still has to agree with the lines incl. VAT (feedback seq
    // 983757): only the VAT figure is stale here.
    const staleTotals = {
      ...baseExtracted,
      totals: { subtotal: 1000, vat: 0, total: 1250 }, // stale VAT: doesn't match the line below
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
      supplierRecord: { id: 'adobe-supplier', default_expense_account: '6540' },
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
      // The register holds the form's hyphenated spelling; the extracted
      // value is bare digits (#2391).
      supplierList: [{ id: 'supplier-org-lookup', name: 'Acme AB', org_number: '556677-8899' }],
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

  // accounted#144: the supplier's default is staged when the agent sends no
  // default_dimensions, so the approver sees the tags; {} stages none.
  it("stages the supplier's default_dimensions when the agent sends none, and none for {}", async () => {
    const stageWith = async (args: Record<string, unknown>) => {
      const inserts: Array<Record<string, unknown>> = []
      const supabase = makeMock({
        inbox: {
          id: 'inbox-10',
          status: 'received',
          extracted_data: baseExtracted,
          matched_supplier_id: 'supplier-1',
          created_supplier_invoice_id: null,
          document_id: 'doc-10',
        },
        // The supplier row the tool reads for its defaults.
        supplierRecord: { id: 'supplier-1', default_expense_account: '6540', default_dimensions: { '1': 'FAST01' } },
        inserts,
      })
      const tool = tools.find((t) => t.name === 'gnubok_create_supplier_invoice_from_inbox')!
      const result = (await tool.execute({ inbox_item_id: 'inbox-10', ...args }, 'company-1', 'user-1', supabase)) as { staged: boolean }
      expect(result.staged).toBe(true)
      return inserts[0].params as { default_dimensions?: Record<string, string> }
    }

    expect((await stageWith({})).default_dimensions).toEqual({ '1': 'FAST01' })
    expect((await stageWith({ default_dimensions: { '6': 'P001' } })).default_dimensions).toEqual({ '6': 'P001' })
    expect('default_dimensions' in (await stageWith({ default_dimensions: {} }))).toBe(false)
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

  it('passes already-decimal vat_rate through unchanged and books foreign VAT as cost, never on 2641', async () => {
    // The document bills 1 000 + 12 % and 500 + 19 % foreign VAT: 1 715.00.
    const mixedRates = {
      ...baseExtracted,
      totals: { subtotal: 1500, vat: 215, total: 1715 },
      lineItems: [
        // Already decimal (staged by an agent following the storage convention).
        { description: 'Svensk tjänst', quantity: 1, unit_price: 1000, line_total: 1000, vat_rate: 0.12, vat_amount: 120 },
        // Foreign rate (DE 19 %): outside the Swedish statutory set, so not
        // deductible ingående moms here; the 95.00 is part of the cost.
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
    const params = inserts[0].params as StagedParams
    expect(params.items[0].vat_rate).toBe(0.12)
    expect(params.items[0].vat_amount).toBe(120)
    expect(params.items[1].vat_rate).toBe(0)
    expect(params.items[1].vat_amount).toBe(0)
    expect(params.items[1].line_total).toBe(595)
    expect(params.items[1].unit_price).toBe(595)
    expect(params.vat_amount).toBe(120)
    expect(params.total).toBe(1715)
    expect((result as unknown as { preview: Record<string, unknown> }).preview.foreign_vat_in_cost).toMatchObject({ amount: 95 })

    // 2440 carries the billed total; the cost line includes the foreign VAT.
    const lines = await registrationLines(params)
    expect(lines.find((l) => l.account_number === '6540')?.debit_amount).toBe(1595)
    expect(lines.find((l) => l.account_number === '2641')?.debit_amount).toBe(120)
    expect(lines.find((l) => l.account_number === '2440')?.credit_amount).toBe(1715)
  })

  it('rejects apply_slp when the line resolves to a non-741x account (staging-time guard)', async () => {
    // The executor (commitCreateSupplierInvoiceFromInbox) refuses the same
    // combination at commit time; rejecting at staging means the agent learns
    // immediately instead of a human approving a doomed operation.
    const supabase = makeMock({
      inbox: {
        id: 'inbox-slp-1',
        status: 'received',
        extracted_data: baseExtracted, // line resolves to the supplier default 6540
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
          totals: { subtotal: 10000, vat: 0, total: 10000 },
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
        // A pension premium carries no VAT: the caller says exempt (accounted#58).
        vat_treatment_override: 'exempt',
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

  // 2026-10 session autopsy: "Extracted invoice has no invoice number"
  // answered UNKNOWN_ERROR ("Försök igen") in 24 sessions, for a call that
  // fails the same way until the number is supplied.
  it('refuses a reading without an invoice number with SI_CREATE_INVALID_INPUT and the tool that supplies it', async () => {
    const supabase = makeMock({
      inbox: {
        id: 'inbox-12',
        status: 'received',
        extracted_data: { ...baseExtracted, invoice: { ...baseExtracted.invoice, invoiceNumber: '  ' } },
        matched_supplier_id: 'supplier-1',
        created_supplier_invoice_id: null,
        document_id: 'doc-12',
      },
    })
    const tool = tools.find((t) => t.name === 'gnubok_create_supplier_invoice_from_inbox')!
    const err = await tool
      .execute({ inbox_item_id: 'inbox-12', dry_run: true }, 'company-1', 'user-1', supabase)
      .then(() => null, (e: unknown) => e)

    const { error } = toToolError(err)
    expect(error).toMatchObject({
      code: 'SI_CREATE_INVALID_INPUT',
      retryable: false,
      remediation: { tool: 'gnubok_set_inbox_extracted_data', args: { inbox_item_id: 'inbox-12' } },
    })
    expect(error.message_sv).toBe('Underlaget saknar fakturanummer. Ange leverantörens fakturanummer från underlaget och försök igen.')
    expect(error.message_en).toMatch(/^No invoice number was read from the underlag/)
  })

  it('refuses a reading without an invoice date and names invoice_date_override', async () => {
    const supabase = makeMock({
      inbox: {
        id: 'inbox-13',
        status: 'received',
        extracted_data: { ...baseExtracted, invoice: { ...baseExtracted.invoice, invoiceDate: null } },
        matched_supplier_id: 'supplier-1',
        created_supplier_invoice_id: null,
        document_id: 'doc-13',
      },
    })
    const tool = tools.find((t) => t.name === 'gnubok_create_supplier_invoice_from_inbox')!
    const err = await tool
      .execute({ inbox_item_id: 'inbox-13', dry_run: true }, 'company-1', 'user-1', supabase)
      .then(() => null, (e: unknown) => e)

    const { error } = toToolError(err)
    expect(error.code).toBe('SI_CREATE_INVALID_INPUT')
    expect(error.message_sv).toMatch(/saknar fakturadatum/)
    expect(error.message_en).toContain('invoice_date_override')
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
 * The scanned bankgiro, plusgiro, IBAN or BIC fills what the supplier lacks,
 * but only once the human approves: staging is a proposal and writes nothing
 * outside pending_operations. Staging shows what approval will do; the
 * executor reads the account from the item's extraction, as every door does
 * (lib/pending-operations commit tests), so nothing payee-shaped is staged.
 */
describe('gnubok_create_supplier_invoice_from_inbox: supplier payment details wait for approval', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const inboxWithBankgiro = {
    id: 'inbox-bg',
    status: 'received',
    extracted_data: { ...baseExtracted, supplier: { ...baseExtracted.supplier, bankgiro: '5050-1055' } },
    matched_supplier_id: 'supplier-1',
    created_supplier_invoice_id: null,
    document_id: 'doc-1',
  }

  it('shows the bankgiro the supplier lacks and writes nothing to the supplier', async () => {
    const supplierUpdates: Array<Record<string, unknown>> = []
    const inserts: Array<Record<string, unknown>> = []
    const supabase = makeMock({
      inbox: inboxWithBankgiro,
      supplierRecord: { id: 'supplier-1', default_expense_account: '6540', bankgiro: null, plusgiro: null, iban: null, bic: null },
      // The payee check's read of the card: empty.
      supplierByOrg: { bankgiro: null, plusgiro: null, bank_account: null, clearing_number: null, account_number: null, iban: null },
      supplierUpdates,
      inserts,
    })
    const tool = tools.find((t) => t.name === 'gnubok_create_supplier_invoice_from_inbox')!
    const result = (await tool.execute({ inbox_item_id: 'inbox-bg' }, 'company-1', 'user-1', supabase)) as {
      staged: boolean
      preview: Record<string, unknown>
    }

    expect(result.staged).toBe(true)
    expect(supplierUpdates).toEqual([])
    expect(inserts).toHaveLength(1)
    expect(inserts[0].params).not.toHaveProperty('supplier_payment_details')
    expect(result.preview.supplier_payment_details_fill).toEqual({ bankgiro: '5050-1055' })
    expect(result.preview).not.toHaveProperty('invoice_account')
    expect(inserts[0].preview_data).not.toHaveProperty('compliance_warning')
  })

  it('offers the footer IBAN beside the card\'s own bankgiro as a fill, never as new bank details (crm#1220)', async () => {
    const inserts: Array<Record<string, unknown>> = []
    const supabase = makeMock({
      inbox: {
        ...inboxWithBankgiro,
        extracted_data: {
          ...baseExtracted,
          supplier: { ...baseExtracted.supplier, bankgiro: '5050-1055', iban: 'SE45 5000 0000 0583 9825 7466', bic: 'ESSESESS' },
        },
      },
      supplierRecord: { id: 'supplier-1', default_expense_account: '6540', bankgiro: '5050-1055', plusgiro: null, iban: null, bic: null },
      supplierByOrg: { bankgiro: '5050-1055', plusgiro: null, bank_account: null, clearing_number: null, account_number: null, iban: null },
      inserts,
    })
    const tool = tools.find((t) => t.name === 'gnubok_create_supplier_invoice_from_inbox')!
    const result = (await tool.execute({ inbox_item_id: 'inbox-bg' }, 'company-1', 'user-1', supabase)) as {
      staged: boolean
      preview: Record<string, unknown>
    }

    expect(result.staged).toBe(true)
    expect(result.preview.supplier_payment_details_fill).toEqual({ iban: 'SE4550000000058398257466', bic: 'ESSESESS' })
    expect(result.preview).not.toHaveProperty('invoice_account')
    expect(inserts[0].preview_data).not.toHaveProperty('compliance_warning')
  })

  it('names both accounts when the bankgiro differs from the card, fills nothing and writes nothing (accounted#15)', async () => {
    const supplierUpdates: Array<Record<string, unknown>> = []
    const inserts: Array<Record<string, unknown>> = []
    const supabase = makeMock({
      inbox: inboxWithBankgiro,
      supplierRecord: { id: 'supplier-1', default_expense_account: '6540', bankgiro: '991-2346', plusgiro: null, iban: null, bic: null },
      supplierByOrg: { bankgiro: '991-2346', plusgiro: null, bank_account: null, clearing_number: null, account_number: null, iban: null },
      supplierUpdates,
      inserts,
    })
    const tool = tools.find((t) => t.name === 'gnubok_create_supplier_invoice_from_inbox')!
    const result = (await tool.execute({ inbox_item_id: 'inbox-bg' }, 'company-1', 'user-1', supabase)) as {
      staged: boolean
      preview: Record<string, unknown>
    }

    expect(result.staged).toBe(true)
    expect(supplierUpdates).toEqual([])
    // Staging never touches a supplier invoice: the stated account is stored at approval.
    const tables = (supabase as unknown as { from: { mock: { calls: unknown[][] } } }).from.mock.calls.map((call) => call[0])
    expect(tables).not.toContain('supplier_invoices')
    expect(inserts[0].params).not.toHaveProperty('supplier_payment_details')
    expect(result.preview).not.toHaveProperty('supplier_payment_details_fill')
    expect(result.preview).toMatchObject({ invoice_account: 'BG 5050-1055', current_supplier_account: 'BG 991-2346' })
    // The approval card's note: the payment waits for a person.
    expect(inserts[0].preview_data).toMatchObject({ compliance_warning: expect.stringContaining('andra bankuppgifter än leverantörskortet') })
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

describe('gnubok_create_supplier_invoice_from_inbox: due date default and total guard (feedback 395405)', () => {
  // A real case: an inbox item (a
  // bank fee, 130 SEK, invoice_date 2025-09-17, no due date on the document)
  // was staged with due_date: null, the executor's INSERT failed on the NOT
  // NULL column, and the agent saw a bare 500 twice. The first attempt had
  // also staged total: 0 from a null OCR total without complaint.
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // A bank fee is an exempt financial service with no VAT on it: the caller
  // states the treatment (EXEMPT), it cannot be read off the document (accounted#58).
  const EXEMPT = { vat_treatment_override: 'exempt' }
  const bankFee = {
    supplier: { name: 'SEB', organizationNumber: '5020326735' },
    invoice: { invoiceNumber: 'AVG-2025-09', invoiceDate: '2025-09-17', dueDate: null, currency: 'SEK' },
    totals: { subtotal: 130, vat: 0, total: 130 },
    lineItems: [
      { description: 'Bankavgift', quantity: 1, unit_price: 130, line_total: 130, vat_rate: 0, vat_amount: 0 },
    ],
  }

  function inboxFor(extracted: Record<string, unknown>) {
    return {
      id: 'inbox-seb',
      status: 'received',
      extracted_data: extracted,
      matched_supplier_id: 'supplier-seb',
      created_supplier_invoice_id: null,
      document_id: 'doc-seb',
    }
  }

  it('defaults a missing due date to invoice_date + 30 days and labels it defaulted', async () => {
    const inserts: Array<Record<string, unknown>> = []
    const supabase = makeMock({
      inbox: inboxFor(bankFee),
      // No default_payment_terms on the row: the 30-day fallback applies.
      supplierRecord: { id: 'supplier-seb', default_expense_account: '6570' },
      inserts,
    })
    const tool = tools.find((t) => t.name === 'gnubok_create_supplier_invoice_from_inbox')!
    const result = (await tool.execute(
      { inbox_item_id: 'inbox-seb', ...EXEMPT },
      'company-1', 'user-1', supabase,
    )) as { staged: boolean; preview: { due_date: string; due_date_source: string; total: number } }

    expect(result.staged).toBe(true)
    expect(result.preview.due_date).toBe('2025-10-17')
    expect(result.preview.due_date_source).toBe('defaulted')
    expect(result.preview.total).toBe(130)
    // The executor reads params.due_date: it must never again be null.
    const params = inserts[0].params as { due_date: string | null }
    expect(params.due_date).toBe('2025-10-17')
  })

  it('uses the supplier payment terms when the supplier has them', async () => {
    const supabase = makeMock({
      inbox: inboxFor(bankFee),
      supplierRecord: { id: 'supplier-seb', default_expense_account: '6570', default_payment_terms: 14 },
    })
    const tool = tools.find((t) => t.name === 'gnubok_create_supplier_invoice_from_inbox')!
    const result = (await tool.execute(
      { inbox_item_id: 'inbox-seb', dry_run: true, ...EXEMPT },
      'company-1', 'user-1', supabase,
    )) as { preview: { due_date: string; due_date_source: string } }

    expect(result.preview.due_date).toBe('2025-10-01')
    expect(result.preview.due_date_source).toBe('defaulted')
  })

  it('reports an extracted due date as extracted and an agent override as override', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_create_supplier_invoice_from_inbox')!

    const extracted = (await tool.execute(
      { inbox_item_id: 'inbox-1', dry_run: true },
      'company-1', 'user-1',
      makeMock({ inbox: { ...inboxFor(baseExtracted), id: 'inbox-1' } }),
    )) as { preview: { due_date: string; due_date_source: string } }
    expect(extracted.preview.due_date).toBe('2026-04-14')
    expect(extracted.preview.due_date_source).toBe('extracted')

    const overridden = (await tool.execute(
      { inbox_item_id: 'inbox-seb', dry_run: true, due_date_override: '2025-09-30', ...EXEMPT },
      'company-1', 'user-1',
      makeMock({ inbox: inboxFor(bankFee) }),
    )) as { preview: { due_date: string; due_date_source: string } }
    expect(overridden.preview.due_date).toBe('2025-09-30')
    expect(overridden.preview.due_date_source).toBe('override')
  })

  it('rejects a null OCR total at staging with SI_CREATE_INVALID_INPUT and a set_inbox_extracted_data remediation', async () => {
    const inserts: Array<Record<string, unknown>> = []
    const supabase = makeMock({
      inbox: inboxFor({ ...bankFee, totals: { subtotal: null, vat: null, total: null } }),
      inserts,
    })
    const tool = tools.find((t) => t.name === 'gnubok_create_supplier_invoice_from_inbox')!
    const err = await tool
      .execute({ inbox_item_id: 'inbox-seb' }, 'company-1', 'user-1', supabase)
      .then(() => null, (e: unknown) => e as Error & { code?: string; remediation?: { tool?: string; args?: Record<string, unknown> } })

    expect(err).not.toBeNull()
    expect(err?.code).toBe('SI_CREATE_INVALID_INPUT')
    expect(err?.message).toMatch(/no usable total/)
    // The line sum is offered as a hint, never written as the header total.
    expect(err?.message).toMatch(/sum to 130/)
    expect(err?.remediation?.tool).toBe('gnubok_set_inbox_extracted_data')
    expect(err?.remediation?.args).toEqual({ inbox_item_id: 'inbox-seb' })
    expect(inserts).toHaveLength(0)

    // The MCP envelope carries the throw-site remediation, not just the code.
    const structured = toToolError(err)
    expect(structured.error.code).toBe('SI_CREATE_INVALID_INPUT')
    expect(structured.error.remediation?.tool).toBe('gnubok_set_inbox_extracted_data')
    expect(structured.error.retryable).toBe(false)
    // The Swedish names the gap for the person the agent relays to, not
    // "Ogiltig kombination av fakturafält" (#96); the English stays the throw's.
    expect(structured.error.message_sv).toMatch(/saknar ett totalbelopp/)
    expect(structured.error.message_en).toMatch(/no usable total/)
  })

  it('rejects a zero total the same way instead of staging a zero-value invoice', async () => {
    const supabase = makeMock({
      inbox: inboxFor({ ...bankFee, totals: { subtotal: 0, vat: 0, total: 0 } }),
    })
    const tool = tools.find((t) => t.name === 'gnubok_create_supplier_invoice_from_inbox')!
    await expect(
      tool.execute({ inbox_item_id: 'inbox-seb', dry_run: true }, 'company-1', 'user-1', supabase),
    ).rejects.toMatchObject({ code: 'SI_CREATE_INVALID_INPUT' })
  })
})


describe('gnubok_create_supplier_invoice_from_inbox: reverse charge registers the net as payable (feedback 366701)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // Anthropic invoice ZC8NEUGS-0001 as extracted: the seller charged Swedish
  // VAT on a supply the buyer self-assesses. The registration entry credits
  // 2440 with the line nets, so a staged gross put 1149 in the reskontra
  // against 919.20 in the GL and the payment match could never settle.
  const grossWithVat = {
    supplier: { name: 'Anthropic, PBC' },
    invoice: { invoiceNumber: 'ZC8NEUGS-0001', invoiceDate: '2026-08-01', dueDate: '2026-08-31', currency: 'SEK' },
    totals: { subtotal: 919.2, vat: 229.8, total: 1149 },
    lineItems: [
      { description: 'Claude API usage', quantity: 1, unitPrice: 919.2, lineTotal: 919.2, vatRate: 25, accountSuggestion: '6540' },
    ],
  }

  it('vat_treatment_override reverse_charge on a gross-with-VAT extraction stages total = net, vat 0, and says the seller charged VAT', async () => {
    const inserts: Array<Record<string, unknown>> = []
    const supabase = makeMock({
      inbox: {
        id: 'inbox-rc-1',
        status: 'received',
        extracted_data: grossWithVat,
        matched_supplier_id: 'supplier-1',
        created_supplier_invoice_id: null,
        document_id: 'doc-rc-1',
      },
      inserts,
    })
    const tool = tools.find((t) => t.name === 'gnubok_create_supplier_invoice_from_inbox')!
    const result = (await tool.execute(
      { inbox_item_id: 'inbox-rc-1', vat_treatment_override: 'reverse_charge' },
      'company-1', 'user-1', supabase,
    )) as { staged: boolean; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    const params = inserts[0].params as {
      vat_treatment: string
      subtotal: number
      vat_amount: number
      total: number
      items: Array<{ vat_rate: number; vat_amount: number; line_total: number }>
    }
    expect(params.vat_treatment).toBe('reverse_charge')
    // The payable the executor writes and the GL will carry on 2440: the net.
    expect(params.subtotal).toBe(919.2)
    expect(params.vat_amount).toBe(0)
    expect(params.total).toBe(919.2)
    expect(params.items[0].line_total).toBe(919.2)
    expect(params.items[0].vat_rate).toBe(0)
    expect(params.items[0].vat_amount).toBe(0)

    // The approver sees the gross next to what is registered, and why.
    expect(result.preview.total).toBe(919.2)
    expect(result.preview.vat_amount).toBe(0)
    expect(result.preview.payable_recomputed).toEqual({
      reason: 'reverse_charge',
      extracted_subtotal: 919.2,
      extracted_vat: 229.8,
      extracted_total: 1149,
      payable_total: 919.2,
    })
    const warning = String(result.preview.warning)
    expect(warning).toContain('229.8')
    expect(warning).toContain('1149')
    expect(warning).toContain('919.2')
    expect(warning).toMatch(/not deductible/i)
  })

  it('dry_run shows the same recomputation before anything is staged', async () => {
    const inserts: Array<Record<string, unknown>> = []
    const supabase = makeMock({
      inbox: {
        id: 'inbox-rc-2',
        status: 'received',
        extracted_data: grossWithVat,
        matched_supplier_id: 'supplier-1',
        created_supplier_invoice_id: null,
        document_id: 'doc-rc-2',
      },
      inserts,
    })
    const tool = tools.find((t) => t.name === 'gnubok_create_supplier_invoice_from_inbox')!
    const result = (await tool.execute(
      { inbox_item_id: 'inbox-rc-2', vat_treatment_override: 'reverse_charge', dry_run: true },
      'company-1', 'user-1', supabase,
    )) as { staged: boolean; dry_run?: boolean; preview: Record<string, unknown> }

    expect(result.dry_run).toBe(true)
    expect(inserts).toHaveLength(0)
    expect(result.preview.total).toBe(919.2)
    expect((result.preview.payable_recomputed as { payable_total: number }).payable_total).toBe(919.2)
    expect(typeof result.preview.warning).toBe('string')
  })

  it('an extraction already marked reverse_charge with no seller VAT stages unchanged and carries no warning', async () => {
    const cleanReverseCharge = {
      ...grossWithVat,
      invoice: { ...grossWithVat.invoice, vatTreatment: 'reverse_charge' },
      totals: { subtotal: 919.2, vat: 0, total: 919.2 },
      lineItems: [
        { description: 'Claude API usage', quantity: 1, unitPrice: 919.2, lineTotal: 919.2, vatRate: 0, accountSuggestion: '6540' },
      ],
    }
    const inserts: Array<Record<string, unknown>> = []
    const supabase = makeMock({
      inbox: {
        id: 'inbox-rc-3',
        status: 'received',
        extracted_data: cleanReverseCharge,
        matched_supplier_id: 'supplier-1',
        created_supplier_invoice_id: null,
        document_id: 'doc-rc-3',
      },
      inserts,
    })
    const tool = tools.find((t) => t.name === 'gnubok_create_supplier_invoice_from_inbox')!
    const result = (await tool.execute(
      { inbox_item_id: 'inbox-rc-3' },
      'company-1', 'user-1', supabase,
    )) as { staged: boolean; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    const params = inserts[0].params as {
      vat_treatment: string
      subtotal: number
      vat_amount: number
      total: number
      items: Array<{ vat_rate: number; vat_amount: number }>
    }
    expect(params.vat_treatment).toBe('reverse_charge')
    expect(params.subtotal).toBe(919.2)
    expect(params.vat_amount).toBe(0)
    expect(params.total).toBe(919.2)
    expect(params.items[0].vat_rate).toBe(0)
    expect(params.items[0].vat_amount).toBe(0)
    expect(result.preview.payable_recomputed).toBeUndefined()
    expect(result.preview.warning).toBeUndefined()
  })

  // Issue #2553: exempt and export carry no Swedish moms either, so the
  // staged op must show what the executor will write: no line VAT, the net as
  // payable, and nothing headed for 2641.
  for (const treatment of ['exempt', 'export'] as const) {
    it(`vat_treatment_override ${treatment} stages vat 0 on every line and the net as payable`, async () => {
      const inserts: Array<Record<string, unknown>> = []
      const supabase = makeMock({
        inbox: {
          id: `inbox-${treatment}`,
          status: 'received',
          extracted_data: grossWithVat,
          matched_supplier_id: 'supplier-1',
          created_supplier_invoice_id: null,
          document_id: `doc-${treatment}`,
        },
        inserts,
      })
      const tool = tools.find((t) => t.name === 'gnubok_create_supplier_invoice_from_inbox')!
      const result = (await tool.execute(
        { inbox_item_id: `inbox-${treatment}`, vat_treatment_override: treatment },
        'company-1', 'user-1', supabase,
      )) as { staged: boolean; preview: Record<string, unknown> }

      expect(result.staged).toBe(true)
      const params = inserts[0].params as {
        vat_treatment: string
        subtotal: number
        vat_amount: number
        total: number
        items: Array<{ vat_rate: number; vat_amount: number }>
      }
      expect(params.vat_treatment).toBe(treatment)
      expect(params.subtotal).toBe(919.2)
      expect(params.vat_amount).toBe(0)
      expect(params.total).toBe(919.2)
      expect(params.items[0].vat_rate).toBe(0)
      expect(params.items[0].vat_amount).toBe(0)
      // The approver is told the underlag carried VAT that is not deductible.
      expect((result.preview.payable_recomputed as { reason: string }).reason).toBe(treatment)
      expect(String(result.preview.warning)).toMatch(/no Swedish moms/i)
    })
  }

  it('a domestic invoice keeps the gross as payable and no reverse-charge warning', async () => {
    const inserts: Array<Record<string, unknown>> = []
    const supabase = makeMock({
      inbox: {
        id: 'inbox-rc-4',
        status: 'received',
        extracted_data: grossWithVat,
        matched_supplier_id: 'supplier-1',
        created_supplier_invoice_id: null,
        document_id: 'doc-rc-4',
      },
      inserts,
    })
    const tool = tools.find((t) => t.name === 'gnubok_create_supplier_invoice_from_inbox')!
    const result = (await tool.execute(
      { inbox_item_id: 'inbox-rc-4' },
      'company-1', 'user-1', supabase,
    )) as { staged: boolean; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    const params = inserts[0].params as { vat_treatment: string; vat_amount: number; total: number; items: Array<{ vat_rate: number }> }
    expect(params.vat_treatment).toBe('standard_25')
    expect(params.total).toBe(1149)
    expect(params.vat_amount).toBe(229.8)
    expect(params.items[0].vat_rate).toBe(0.25)
    expect(result.preview.payable_recomputed).toBeUndefined()
    expect(result.preview.warning).toBeUndefined()
  })
})

interface StagedParams {
  invoice_date: string
  currency: string
  exchange_rate: number | null
  vat_treatment: string
  subtotal: number
  vat_amount: number
  total: number
  items: Array<{
    line_number: number
    account_number: string
    quantity: number
    unit_price: number
    line_total: number
    vat_rate: number
    vat_amount: number
  }>
}

/**
 * The registration verifikat the commit would post for a staged op, built by
 * the real generator (only the fiscal-period lookup is stubbed): 2440 is the
 * balancing sum of what the items debit.
 */
async function registrationLines(params: StagedParams) {
  const periodChain: unknown = new Proxy(
    {},
    {
      get: (_t, prop) =>
        prop === 'then'
          ? (resolve: (v: unknown) => void) => resolve({ data: [{ id: 'period-1' }], error: null })
          : () => periodChain,
    },
  )
  const invoice = makeSupplierInvoice({
    invoice_date: params.invoice_date,
    currency: params.currency,
    exchange_rate: params.exchange_rate,
    vat_treatment: params.vat_treatment as SupplierInvoice['vat_treatment'],
    subtotal: params.subtotal,
    vat_amount: params.vat_amount,
    total: params.total,
  })
  const items = params.items.map((item, i) => ({
    ...item,
    id: `item-${i}`,
    supplier_invoice_id: invoice.id,
    sort_order: i,
    reverse_charge_rate: null,
  })) as unknown as SupplierInvoiceItem[]
  const input = await buildSupplierInvoiceRegistrationEntryInput(
    { from: () => periodChain } as never,
    'company-1',
    invoice,
    items,
    'swedish_business',
    'Leverantör AB',
  )
  return input!.lines
}

describe('gnubok_create_supplier_invoice_from_inbox: a non-VAT-registered company books the seller VAT as cost (feedback 708521)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // A supplier invoice for an ideell förening (vat_registered false) as
  // extracted: 2000 + 25 % = 2500. The tool staged 500 on 2641, which the
  // förening can never reclaim.
  const ringo = {
    supplier: { name: 'Bryggleverantören AB' },
    invoice: { invoiceNumber: '5571', invoiceDate: '2026-01-16', dueDate: '2026-02-15', currency: 'SEK' },
    totals: { subtotal: 2000, vat: 500, total: 2500 },
    lineItems: [
      { description: 'Båtplats', quantity: 1, unitPrice: 2000, lineTotal: 2000, vatRate: 25, accountSuggestion: '5010' },
    ],
  }

  async function stage(opts: { vatRegistered: boolean; args?: Record<string, unknown>; extracted?: unknown }) {
    const inserts: Array<Record<string, unknown>> = []
    const supabase = makeMock({
      inbox: {
        id: 'inbox-nr',
        status: 'received',
        extracted_data: opts.extracted ?? ringo,
        matched_supplier_id: 'supplier-1',
        created_supplier_invoice_id: null,
        document_id: 'doc-nr',
      },
      inserts,
      vatRegistered: opts.vatRegistered,
    })
    const tool = tools.find((t) => t.name === 'gnubok_create_supplier_invoice_from_inbox')!
    const result = (await tool.execute(
      { inbox_item_id: 'inbox-nr', ...opts.args },
      'company-1', 'user-1', supabase,
    )) as { staged: boolean; preview: Record<string, unknown> }
    return { result, params: inserts[0]?.params as StagedParams }
  }

  it('stages one cost line of 2500 at 0 %, payable 2500, and the preview says why', async () => {
    const { result, params } = await stage({ vatRegistered: false })

    expect(result.staged).toBe(true)
    expect(params.vat_treatment).toBe('standard_25')
    expect(params.items).toHaveLength(1)
    expect(params.items[0]).toMatchObject({ account_number: '5010', quantity: 1, unit_price: 2500, line_total: 2500, vat_rate: 0, vat_amount: 0 })
    expect(params.subtotal).toBe(2500)
    expect(params.vat_amount).toBe(0)
    expect(params.total).toBe(2500)

    expect(result.preview.vat_registration).toMatchObject({ vat_registered: false, seller_vat_added_to_cost: 500 })
    const note = String((result.preview.vat_registration as { note: string }).note)
    expect(note).toMatch(/not VAT-registered/)
    expect(note).toContain("the seller's VAT 500 is added to the cost lines")
    expect(note).toContain('2440 is credited with 2500')
    expect(note).not.toMatch(/differs from the document total/)
    expect(result.preview.warning).toBeUndefined()
    expect(result.preview.payable_recomputed).toBeUndefined()

    const lines = await registrationLines(params)
    expect(lines.find((l) => l.account_number === '2641')).toBeUndefined()
    expect(lines.find((l) => l.account_number === '5010')?.debit_amount).toBe(2500)
    expect(lines.find((l) => l.account_number === '2440')?.credit_amount).toBe(2500)
  })

  it('keeps the seller VAT in the payable when the treatment is overridden to exempt (the reported workaround)', async () => {
    // The net path of an exempt label would have registered 2000 and
    // dropped the 500 the förening still owes the seller.
    const { result, params } = await stage({ vatRegistered: false, args: { vat_treatment_override: 'exempt' } })

    expect(params.vat_treatment).toBe('exempt')
    expect(params.items[0]).toMatchObject({ line_total: 2500, vat_rate: 0, vat_amount: 0 })
    expect(params.total).toBe(2500)
    expect(result.preview.payable_recomputed).toBeUndefined()
    expect(result.preview.vat_registration).toMatchObject({ seller_vat_added_to_cost: 500 })
  })

  it('names a document total the lines do not reach instead of registering it', async () => {
    const { result, params } = await stage({
      vatRegistered: false,
      extracted: { ...ringo, totals: { subtotal: 2000, vat: 500, total: 2600 } },
    })

    // The payable is what 2440 is credited with; the gap is not rounding.
    expect(params.total).toBe(2500)
    expect(params.items.some((i) => i.account_number === '3740')).toBe(false)
    expect(String((result.preview.vat_registration as { note: string }).note)).toContain(
      'That differs from the document total 2600',
    )
  })

  it('leaves a VAT-registered company unchanged: 2000 on the cost line, 500 on 2641, 2500 payable', async () => {
    const { result, params } = await stage({ vatRegistered: true })

    expect(params.items[0]).toMatchObject({ unit_price: 2000, line_total: 2000, vat_rate: 0.25, vat_amount: 500 })
    expect(params.subtotal).toBe(2000)
    expect(params.vat_amount).toBe(500)
    expect(params.total).toBe(2500)
    expect(result.preview.vat_registration).toBeUndefined()

    const lines = await registrationLines(params)
    expect(lines.find((l) => l.account_number === '2641')?.debit_amount).toBe(500)
    expect(lines.find((l) => l.account_number === '2440')?.credit_amount).toBe(2500)
  })

  it('leaves reverse charge on its own path for a non-registered company', async () => {
    const { result, params } = await stage({ vatRegistered: false, args: { vat_treatment_override: 'reverse_charge' } })

    expect(params.vat_treatment).toBe('reverse_charge')
    expect(params.items[0]).toMatchObject({ line_total: 2000, vat_rate: 0, vat_amount: 0 })
    expect(params.total).toBe(2000)
    expect(result.preview.vat_registration).toBeUndefined()
    expect((result.preview.payable_recomputed as { reason: string }).reason).toBe('reverse_charge')
  })
})

describe('gnubok_create_supplier_invoice_from_inbox: öresavrundning (feedback 753539)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockResolveRate.mockReset()
  })

  // The invoice from feedback seq 753539 as registered on 2026-09-26: the lines
  // come to 355 894.12 + 88 297.79 = 444 191.91 against a billed 444 192.00,
  // and 2440 was credited with 444 191.91.
  const manyLineItems = [
    { account: '5800', net: 24659.23, rate: 25 },
    { account: '6550', net: 20000, rate: 25 },
    { account: '4010', net: 30903, rate: 25 },
    { account: '4010', net: 30175.83, rate: 25 },
    { account: '4010', net: 21900.46, rate: 25 },
    { account: '4010', net: 13536.61, rate: 25 },
    { account: '4010', net: 201375.99, rate: 25 },
    { account: '4010', net: 10640, rate: 25 },
    { account: '4010', net: 2360, rate: 0 },
    { account: '5710', net: 343, rate: 0 },
  ]
  const manyLineInvoice = {
    supplier: { name: 'Grossisten AB' },
    invoice: { invoiceNumber: '2026006', invoiceDate: '2026-09-25', dueDate: '2026-10-25', currency: 'SEK' },
    totals: { subtotal: 355894.12, vat: 88297.79, total: 444192, roundingAmount: 0.09 },
    lineItems: manyLineItems.map((l, i) => ({
      description: `Rad ${i + 1}`,
      quantity: 1,
      unitPrice: l.net,
      lineTotal: l.net,
      vatRate: l.rate,
      accountSuggestion: l.account,
    })),
  }

  async function stage(extracted: unknown, opts: { vatRegistered?: boolean; args?: Record<string, unknown> } = {}) {
    const inserts: Array<Record<string, unknown>> = []
    const supabase = makeMock({
      inbox: {
        id: 'inbox-ore',
        status: 'received',
        extracted_data: extracted,
        matched_supplier_id: 'supplier-1',
        created_supplier_invoice_id: null,
        document_id: 'doc-ore',
      },
      inserts,
      ...(opts.vatRegistered !== undefined ? { vatRegistered: opts.vatRegistered } : {}),
    })
    const tool = tools.find((t) => t.name === 'gnubok_create_supplier_invoice_from_inbox')!
    const result = (await tool.execute(
      { inbox_item_id: 'inbox-ore', ...opts.args },
      'company-1', 'user-1', supabase,
    )) as { staged: boolean; preview: Record<string, unknown> }
    return { result, params: inserts[0]?.params as StagedParams }
  }

  it('stages a 0.09 zero-VAT 3740 line, so 2440 is credited with the billed 444 192.00', async () => {
    const { result, params } = await stage(manyLineInvoice)

    expect(result.staged).toBe(true)
    expect(params.items).toHaveLength(11)
    expect(params.items[10]).toEqual({
      line_number: 11,
      description: 'Öresavrundning',
      quantity: 1,
      unit: 'st',
      unit_price: 0.09,
      line_total: 0.09,
      account_number: '3740',
      vat_rate: 0,
      vat_amount: 0,
    })
    expect(params.vat_amount).toBe(88297.79)
    expect(params.subtotal).toBe(355894.21)
    expect(params.total).toBe(444192)
    expect(result.preview.ore_rounding).toMatchObject({ account_number: '3740', amount: 0.09 })

    const lines = await registrationLines(params)
    expect(lines.find((l) => l.account_number === '3740')?.debit_amount).toBe(0.09)
    expect(lines.find((l) => l.account_number === '2641')?.debit_amount).toBe(88297.79)
    expect(lines.find((l) => l.account_number === '2440')?.credit_amount).toBe(444192)
  })

  it('credits 3740 when the supplier rounded down', async () => {
    const { params } = await stage({ ...manyLineInvoice, totals: { ...manyLineInvoice.totals, total: 444191.5 } })

    expect(params.items[10]).toMatchObject({ account_number: '3740', line_total: -0.41, vat_rate: 0 })
    expect(params.total).toBe(444191.5)
    const lines = await registrationLines(params)
    expect(lines.find((l) => l.account_number === '3740')?.credit_amount).toBe(0.41)
    expect(lines.find((l) => l.account_number === '2440')?.credit_amount).toBe(444191.5)
  })

  it('does not carry a gap over 0.50 as öresavrundning, though per-line VAT rounding on ten lines still explains it', async () => {
    const { result, params } = await stage({ ...manyLineInvoice, totals: { ...manyLineInvoice.totals, total: 444192.42 } })

    expect(result.staged).toBe(true)
    expect(params.items).toHaveLength(10)
    expect(params.items.some((i) => i.account_number === '3740')).toBe(false)
    expect(result.preview.ore_rounding).toBeUndefined()
  })

  it('stages nothing past the per-line rounding tolerance (feedback seq 983757)', async () => {
    // Ten lines tolerate 0.50 + 10 x 0.005 = 0.55.
    const { result, params } = await stage({ ...manyLineInvoice, totals: { ...manyLineInvoice.totals, total: 444192.47 } })

    expect(result.staged).toBe(false)
    expect(params).toBeUndefined()
    expect(result.preview.error_code).toBe('SI_CREATE_TOTALS_MISMATCH')
    expect(result.preview.gap).toBe(0.56)
  })

  it('stages a long invoice whose lines round their VAT one by one: 120 lines of 9.98 at 25 %', async () => {
    // Line by line 120 x 2.50 = 300.00; the document's VAT on the sum is 299.40.
    const many = {
      ...manyLineInvoice,
      totals: { subtotal: 1197.6, vat: 299.4, total: 1497 },
      lineItems: Array.from({ length: 120 }, (_, i) => ({
        description: `Artikel ${i + 1}`, quantity: 1, unitPrice: 9.98, lineTotal: 9.98, vatRate: 25, accountSuggestion: '4010',
      })),
    }
    const { result, params } = await stage(many)

    expect(result.staged).toBe(true)
    expect(params.items).toHaveLength(120)
    expect(params.total).toBe(1497)
  })

  it('never touches a foreign-currency invoice', async () => {
    mockResolveRate.mockResolvedValue({
      ok: true,
      rate: { currency: 'EUR', rate: 11.5, exchangeRate: 11.5, exchangeRateDate: '2026-09-25', source: 'fetched' },
    })
    const { result, params } = await stage({ ...manyLineInvoice, invoice: { ...manyLineInvoice.invoice, currency: 'EUR' } })

    expect(params.currency).toBe('EUR')
    expect(params.items).toHaveLength(10)
    expect(params.items.some((i) => i.account_number === '3740')).toBe(false)
    expect(params.total).toBe(444192)
    expect(result.preview.ore_rounding).toBeUndefined()
  })

  it('carries the rounding on top of the folded lines for a non-registered company', async () => {
    const { params } = await stage(manyLineInvoice, { vatRegistered: false })

    expect(params.items[10]).toMatchObject({ account_number: '3740', line_total: 0.09, vat_rate: 0 })
    expect(params.items.every((i) => i.vat_rate === 0 && i.vat_amount === 0)).toBe(true)
    expect(params.vat_amount).toBe(0)
    expect(params.total).toBe(444192)
    const lines = await registrationLines(params)
    expect(lines.find((l) => l.account_number === '2641')).toBeUndefined()
    expect(lines.find((l) => l.account_number === '2440')?.credit_amount).toBe(444192)
  })

  // A document without moms (exempt seller, export, reverse charge) whose Att
  // betala is its line nets rounded to whole kronor: the net path registered
  // the nets, the öre short of what the supplier asks.
  const noVat = (total: number) => ({
    supplier: { name: 'Föreningen' },
    invoice: { invoiceNumber: 'NV-7', invoiceDate: '2026-10-20', dueDate: '2026-11-19', currency: 'SEK' },
    totals: { subtotal: 2441.89, vat: 0, total, roundingAmount: roundOre(total - 2441.89) },
    lineItems: [
      { description: 'Avgift', quantity: 1, unitPrice: 2000, lineTotal: 2000, vatRate: 0, accountSuggestion: '6990' },
      { description: 'Material', quantity: 1, unitPrice: 441.89, lineTotal: 441.89, vatRate: 0, accountSuggestion: '5460' },
    ],
  })

  it('carries an exempt invoice\'s öresavrundning on 3740, so the payable is its Att betala', async () => {
    const { result, params } = await stage(noVat(2442), { args: { vat_treatment_override: 'exempt' } })

    expect(result.staged).toBe(true)
    expect(params.vat_treatment).toBe('exempt')
    expect(params.items[2]).toMatchObject({ account_number: '3740', line_total: 0.11, vat_rate: 0, vat_amount: 0 })
    expect(params.subtotal).toBe(2442)
    expect(params.vat_amount).toBe(0)
    expect(params.total).toBe(2442)
    expect(result.preview.payable_recomputed).toBeUndefined()
    const lines = await registrationLines(params)
    expect(lines.find((l) => l.account_number === '3740')?.debit_amount).toBe(0.11)
    expect(lines.find((l) => l.account_number === '2641')).toBeUndefined()
    expect(lines.find((l) => l.account_number === '2440')?.credit_amount).toBe(2442)
  })

  it('carries a reverse-charge invoice\'s öresavrundning the same way', async () => {
    const { params } = await stage(noVat(2442), { args: { vat_treatment_override: 'reverse_charge' } })

    expect(params.vat_treatment).toBe('reverse_charge')
    expect(params.items[2]).toMatchObject({ account_number: '3740', line_total: 0.11, vat_rate: 0 })
    expect(params.total).toBe(2442)
  })

  it('keeps registering the nets when a no-VAT total is not their whole-krona rounding', async () => {
    const { result, params } = await stage(noVat(2441.95), { args: { vat_treatment_override: 'exempt' } })

    expect(params.items.some((i) => i.account_number === '3740')).toBe(false)
    expect(params.total).toBe(2441.89)
    expect(result.preview.payable_recomputed).toMatchObject({ extracted_total: 2441.95, payable_total: 2441.89 })
  })
})

describe('gnubok_create_supplier_invoice_from_inbox: a line is never given a guessed account', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // The real AI extraction and Peppol always carry accountSuggestion null, so
  // a supplier without default_expense_account and a call without
  // line_overrides used to stage every line on 4000.
  const aiExtracted = {
    ...baseExtracted,
    lineItems: [
      { description: 'Konsulttimmar', quantity: 10, unitPrice: 100, lineTotal: 1000, vatRate: 25, accountSuggestion: null },
    ],
  }
  const inbox = (extracted: Record<string, unknown>) => ({
    id: 'inbox-noacc',
    status: 'received',
    extracted_data: extracted,
    matched_supplier_id: 'supplier-nodefault',
    created_supplier_invoice_id: null,
    document_id: 'doc-noacc',
  })
  const tool = () => tools.find((t) => t.name === 'gnubok_create_supplier_invoice_from_inbox')!

  it('stages nothing when a line resolves to no account, and says which line and how to fix it', async () => {
    const inserts: Array<Record<string, unknown>> = []
    const supabase = makeMock({
      inbox: inbox(aiExtracted),
      supplierRecord: { id: 'supplier-nodefault', default_expense_account: null },
      inserts,
    })

    const result = (await tool().execute({ inbox_item_id: 'inbox-noacc' }, 'company-1', 'user-1', supabase)) as {
      staged: boolean
      message: string
      preview: { supplier_id: string; unaccounted_lines: Array<Record<string, unknown>> }
      next: { tool: string; args: Record<string, unknown> }
    }

    expect(result.staged).toBe(false)
    expect(inserts).toHaveLength(0)
    expect(result.message).toContain('saknar konto')
    expect(result.message).toContain('default_expense_account')
    expect(result.preview.supplier_id).toBe('supplier-nodefault')
    expect(result.preview.unaccounted_lines).toEqual([
      { line_number: 1, description: 'Konsulttimmar', line_total: 1000 },
    ])
    expect(result.next.tool).toBe('gnubok_create_supplier_invoice_from_inbox')
    expect(result.next.args).toEqual({ inbox_item_id: 'inbox-noacc', line_overrides: [{ line_number: 1 }] })
    expect(JSON.stringify(result)).not.toContain('4000')
  })

  it('refuses on a dry run too, so the preview never shows a guessed account', async () => {
    const supabase = makeMock({
      inbox: inbox(aiExtracted),
      supplierRecord: { id: 'supplier-nodefault', default_expense_account: null },
    })
    const result = (await tool().execute({ inbox_item_id: 'inbox-noacc', dry_run: true }, 'company-1', 'user-1', supabase)) as {
      staged: boolean
      preview: { unaccounted_lines?: unknown[]; items_preview?: unknown[] }
    }
    expect(result.staged).toBe(false)
    expect(result.preview.unaccounted_lines).toHaveLength(1)
    expect(result.preview.items_preview).toBeUndefined()
  })

  it('names only the lines that lack an account', async () => {
    const supabase = makeMock({
      inbox: inbox({
        ...aiExtracted,
        lineItems: [
          { description: 'Licens', quantity: 1, unitPrice: 400, lineTotal: 400, vatRate: 25, accountSuggestion: '6540' },
          { description: 'Frakt', quantity: 1, unitPrice: 600, lineTotal: 600, vatRate: 25, accountSuggestion: null },
        ],
      }),
      supplierRecord: { id: 'supplier-nodefault', default_expense_account: null },
    })
    const result = (await tool().execute({ inbox_item_id: 'inbox-noacc' }, 'company-1', 'user-1', supabase)) as {
      staged: boolean
      preview: { unaccounted_lines: Array<{ line_number: number }> }
    }
    expect(result.staged).toBe(false)
    expect(result.preview.unaccounted_lines.map((l) => l.line_number)).toEqual([2])
  })

  it('refuses an override that is not a four-digit account instead of staging it', async () => {
    const supabase = makeMock({
      inbox: inbox(aiExtracted),
      supplierRecord: { id: 'supplier-nodefault', default_expense_account: null },
    })
    const result = (await tool().execute(
      { inbox_item_id: 'inbox-noacc', line_overrides: [{ line_number: 1, account_number: '65400' }] },
      'company-1', 'user-1', supabase,
    )) as { staged: boolean; preview: { unaccounted_lines: Array<Record<string, unknown>> } }
    expect(result.staged).toBe(false)
    expect(result.preview.unaccounted_lines[0]).toMatchObject({ line_number: 1, invalid_account: '65400' })
  })

  it('stages once line_overrides supplies the account', async () => {
    const inserts: Array<Record<string, unknown>> = []
    const supabase = makeMock({
      inbox: inbox(aiExtracted),
      supplierRecord: { id: 'supplier-nodefault', default_expense_account: null },
      inserts,
    })
    const result = (await tool().execute(
      { inbox_item_id: 'inbox-noacc', line_overrides: [{ line_number: 1, account_number: '6550' }] },
      'company-1', 'user-1', supabase,
    )) as { staged: boolean }
    expect(result.staged).toBe(true)
    const params = inserts[0].params as { items: Array<{ account_number: string }> }
    expect(params.items[0].account_number).toBe('6550')
  })

  it('takes the supplier default when the line has no account of its own', async () => {
    const inserts: Array<Record<string, unknown>> = []
    const supabase = makeMock({
      inbox: inbox(aiExtracted),
      supplierRecord: { id: 'supplier-nodefault', default_expense_account: '5410' },
      inserts,
    })
    const result = (await tool().execute({ inbox_item_id: 'inbox-noacc' }, 'company-1', 'user-1', supabase)) as { staged: boolean }
    expect(result.staged).toBe(true)
    const params = inserts[0].params as { items: Array<{ account_number: string }> }
    expect(params.items[0].account_number).toBe('5410')
  })
})

describe('gnubok_create_supplier_invoice_from_inbox: line amounts that include VAT (feedback seq 983757)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockResolveRate.mockReset()
  })

  // A utility bill that prints its consumption line only incl. VAT: 1 412.62
  // (1 130.10 + 282.52 VAT) plus a 75.00 fee at 0 %, 1 487.62 rounded to a
  // billed 1 488.00. The extraction's totals are right, but lineTotal holds
  // the gross, and staging used to add 25 % on top: 2440 credited 1 840.78.
  const grossBill = {
    supplier: { name: 'Nätbolaget AB' },
    invoice: { invoiceNumber: 'EL-2001', invoiceDate: '2026-09-20', dueDate: '2026-10-20', currency: 'SEK', paymentReference: null },
    totals: { subtotal: 1205.1, vatAmount: 282.52, total: 1488 },
    lineItems: [
      { description: 'Förbrukning', quantity: 1, unitPrice: 1412.62, lineTotal: 1412.62, vatRate: 25, accountSuggestion: '5020' },
      { description: 'Avgift', quantity: 1, unitPrice: 75, lineTotal: 75, vatRate: 0, accountSuggestion: '6570' },
    ],
  }

  async function stage(
    extracted: unknown,
    opts: { args?: Record<string, unknown>; vatRegistered?: boolean } = {},
  ) {
    const inserts: Array<Record<string, unknown>> = []
    const supabase = makeMock({
      inbox: {
        id: 'inbox-gross',
        status: 'received',
        extracted_data: extracted,
        matched_supplier_id: 'supplier-1',
        created_supplier_invoice_id: null,
        document_id: 'doc-gross',
      },
      inserts,
      ...(opts.vatRegistered !== undefined ? { vatRegistered: opts.vatRegistered } : {}),
    })
    const tool = tools.find((t) => t.name === 'gnubok_create_supplier_invoice_from_inbox')!
    const result = (await tool.execute(
      { inbox_item_id: 'inbox-gross', ...opts.args },
      'company-1', 'user-1', supabase,
    )) as {
      staged: boolean
      dry_run?: boolean
      message: string
      preview: Record<string, unknown>
      next?: { tool: string; args: Record<string, unknown>; description: string }
    }
    return { result, inserts, params: inserts[0]?.params as StagedParams | undefined }
  }

  it('reads the lines as gross: 1 130.10 + 282.52 VAT, 75.00, 0.38 öresavrundning, and 2440 is credited with the billed 1 488.00', async () => {
    const { result, params } = await stage(grossBill)

    expect(result.staged).toBe(true)
    expect(params!.items).toHaveLength(3)
    expect(params!.items[0]).toMatchObject({ account_number: '5020', unit_price: 1130.1, line_total: 1130.1, vat_rate: 0.25, vat_amount: 282.52 })
    expect(params!.items[1]).toMatchObject({ account_number: '6570', line_total: 75, vat_rate: 0, vat_amount: 0 })
    expect(params!.items[2]).toMatchObject({ account_number: '3740', line_total: 0.38, vat_rate: 0, vat_amount: 0 })
    // The header agrees with its own items: subtotal + vat_amount = total.
    expect(params!.subtotal).toBe(1205.48)
    expect(params!.vat_amount).toBe(282.52)
    expect(params!.total).toBe(1488)

    expect(result.preview.line_amounts_interpreted_as).toBe('gross')
    expect(String(result.preview.warning)).toMatch(/include VAT/)
    expect(result.preview.subtotal).toBe(1205.48)
    expect(result.preview.vat_amount).toBe(282.52)
    expect(result.preview.total).toBe(1488)

    const lines = await registrationLines(params!)
    expect(lines.find((l) => l.account_number === '5020')?.debit_amount).toBe(1130.1)
    expect(lines.find((l) => l.account_number === '6570')?.debit_amount).toBe(75)
    expect(lines.find((l) => l.account_number === '3740')?.debit_amount).toBe(0.38)
    expect(lines.find((l) => l.account_number === '2641')?.debit_amount).toBe(282.52)
    expect(lines.find((l) => l.account_number === '2440')?.credit_amount).toBe(1488)
  })

  it('shows the same reading on a dry run without staging', async () => {
    const { result, inserts } = await stage(grossBill, { args: { dry_run: true } })

    expect(result.dry_run).toBe(true)
    expect(inserts).toHaveLength(0)
    expect(result.preview.line_amounts_interpreted_as).toBe('gross')
    expect(result.preview.total).toBe(1488)
  })

  it('stages nothing when neither reading reconciles, and points at set_inbox_extracted_data', async () => {
    const { result, inserts } = await stage({ ...grossBill, totals: { ...grossBill.totals, total: 1600 } })

    expect(result.staged).toBe(false)
    expect(inserts).toHaveLength(0)
    expect(result.message).toMatch(/stämmer inte med fakturans totalbelopp/)
    expect(result.preview).toMatchObject({
      error_code: 'SI_CREATE_TOTALS_MISMATCH',
      extracted_total: 1600,
      lines_net: 1487.62,
      lines_vat: 353.16,
      lines_incl_vat: 1840.78,
      gap: -240.78,
    })
    expect(result.next?.tool).toBe('gnubok_set_inbox_extracted_data')
    expect(result.next?.args).toEqual({ inbox_item_id: 'inbox-gross' })
    // The fix is in the lines, never a lower total: foreign VAT is cost.
    expect(result.next?.description).toMatch(/excluding Swedish VAT/)
    expect(result.next?.description).toMatch(/foreign VAT with vatRate 0/)
    expect(result.next?.description).toMatch(/Never lower totals.total/)
    expect(result.next?.description).not.toMatch(/or fix totals.total/)
  })

  it('refuses on a dry run too', async () => {
    const { result } = await stage({ ...grossBill, totals: { ...grossBill.totals, total: 1600 } }, { args: { dry_run: true } })
    expect(result.staged).toBe(false)
    expect(result.preview.error_code).toBe('SI_CREATE_TOTALS_MISMATCH')
  })

  it('does not read the lines as gross when the document VAT does not match the VAT inside them', async () => {
    const { result } = await stage({ ...grossBill, totals: { subtotal: null, vatAmount: null, total: 1488 } })
    expect(result.staged).toBe(false)
    expect(result.preview.error_code).toBe('SI_CREATE_TOTALS_MISMATCH')
  })

  it('keeps net lines that already reconcile exactly as before, with no gross reading', async () => {
    const netBill = {
      ...grossBill,
      lineItems: [
        { ...grossBill.lineItems[0], unitPrice: 1130.1, lineTotal: 1130.1 },
        grossBill.lineItems[1],
      ],
    }
    const { result, params } = await stage(netBill)

    expect(result.staged).toBe(true)
    // The document's own VAT for the rate (282.52), within the öre of the
    // net line's 1 130.10 x 25 % = 282.525 (crm#1367); the öre the document
    // rounded to the krona carried on 3740.
    expect(params!.items[0]).toMatchObject({ line_total: 1130.1, vat_amount: 282.52 })
    expect(params!.items[2]).toMatchObject({ account_number: '3740', line_total: 0.38 })
    expect(params!.total).toBe(1488)
    expect(result.preview.vat_by_rate).toEqual([
      { rate: 0.25, base: 1130.1, vat: 282.52, source: 'stated' },
      { rate: 0, base: 75, vat: 0, source: 'computed' },
    ])
    expect(result.preview.line_amounts_interpreted_as).toBeUndefined()
    expect(result.preview.warning).toBeUndefined()
  })

  // crm#1367: SF-CE-202608 rounded line by line came to 3 864,12; the
  // document computes on the summed base and says 3 864,11.
  const selfBill = {
    supplier: { name: 'Exempel Energi AB' },
    invoice: { invoiceNumber: 'SF-CE-202608', invoiceDate: '2026-09-30', dueDate: '2026-10-30', currency: 'SEK', paymentReference: null },
    totals: { subtotal: 15456.45, vatAmount: 3864.11, total: 19320.56 },
    lineItems: [
      { description: 'Flexintäkt', quantity: 1, unitPrice: 17564.15, lineTotal: 17564.15, vatRate: 25, accountSuggestion: '4010' },
      { description: 'Handelsavgift', quantity: 1, unitPrice: -2107.7, lineTotal: -2107.7, vatRate: 25, accountSuggestion: '4010' },
    ],
  }

  it('books the VAT the document states for the rate, spread over the lines (crm#1367)', async () => {
    const { result, params } = await stage(selfBill)

    expect(result.staged).toBe(true)
    expect(roundOre(params!.items.reduce((sum, i) => sum + i.vat_amount, 0))).toBe(3864.11)
    expect(params!.vat_amount).toBe(3864.11)
    expect(params!.total).toBe(19320.56)
    expect(params!.items.some((i) => i.account_number === '3740')).toBe(false)
    expect(result.preview.vat_by_rate).toEqual([{ rate: 0.25, base: 15456.45, vat: 3864.11, source: 'stated' }])
  })

  it('falls back to the VAT on the summed base when the OCR\'d VAT does not fit the lines', async () => {
    const { result, params } = await stage({ ...selfBill, totals: { ...selfBill.totals, vatAmount: 3900 } })

    expect(result.staged).toBe(true)
    expect(params!.vat_amount).toBe(3864.11)
    expect(result.preview.vat_by_rate).toEqual([{ rate: 0.25, base: 15456.45, vat: 3864.11, source: 'computed' }])
  })

  it('leaves reverse charge on its own path: the line nets are the payable, nothing is refused', async () => {
    const { result, params } = await stage(grossBill, { args: { vat_treatment_override: 'reverse_charge' } })

    expect(result.staged).toBe(true)
    expect(params!.items.map((i) => [i.line_total, i.vat_amount])).toEqual([[1412.62, 0], [75, 0]])
    expect(params!.total).toBe(1487.62)
    expect(result.preview.line_amounts_interpreted_as).toBeUndefined()
    expect((result.preview.payable_recomputed as { reason: string }).reason).toBe('reverse_charge')
  })

  it('leaves exempt on its own path too', async () => {
    const { result, params } = await stage(grossBill, { args: { vat_treatment_override: 'exempt' } })

    expect(result.staged).toBe(true)
    expect(params!.total).toBe(1487.62)
    expect(params!.vat_amount).toBe(0)
    expect(result.preview.line_amounts_interpreted_as).toBeUndefined()
  })

  it('reads the lines as gross for a non-registered company too: the fold keeps the printed amounts as cost', async () => {
    const { result, params } = await stage(grossBill, { vatRegistered: false })

    expect(result.staged).toBe(true)
    expect(result.preview.line_amounts_interpreted_as).toBe('gross')
    expect(params!.items.map((i) => [i.account_number, i.line_total, i.vat_amount])).toEqual([
      ['5020', 1412.62, 0],
      ['6570', 75, 0],
      ['3740', 0.38, 0],
    ])
    expect(params!.vat_amount).toBe(0)
    expect(params!.total).toBe(1488)
    expect(result.preview.vat_registration).toMatchObject({ vat_registered: false, seller_vat_added_to_cost: 282.52 })
    const lines = await registrationLines(params!)
    expect(lines.find((l) => l.account_number === '2641')).toBeUndefined()
    expect(lines.find((l) => l.account_number === '2440')?.credit_amount).toBe(1488)
  })

  it('never adds the VAT a second time for a non-registered company: billed 1 250.00 incl. 25 %, payable 1 250.00', async () => {
    const single = {
      ...grossBill,
      totals: { subtotal: 1000, vatAmount: 250, total: 1250 },
      lineItems: [{ description: 'Hyra', quantity: 1, unitPrice: 1250, lineTotal: 1250, vatRate: 25, accountSuggestion: '5010' }],
    }
    const { result, params } = await stage(single, { vatRegistered: false })

    expect(result.staged).toBe(true)
    expect(params!.items).toHaveLength(1)
    expect(params!.items[0]).toMatchObject({ line_total: 1250, vat_rate: 0, vat_amount: 0 })
    expect(params!.total).toBe(1250)
    const lines = await registrationLines(params!)
    expect(lines.find((l) => l.account_number === '5010')?.debit_amount).toBe(1250)
    expect(lines.find((l) => l.account_number === '2440')?.credit_amount).toBe(1250)
  })

  it('keeps a non-registered company\'s net lines folded as before when they reconcile as net', async () => {
    const net = {
      ...grossBill,
      totals: { subtotal: 1000, vatAmount: 250, total: 1250 },
      lineItems: [{ description: 'Hyra', quantity: 1, unitPrice: 1000, lineTotal: 1000, vatRate: 25, accountSuggestion: '5010' }],
    }
    const { result, params } = await stage(net, { vatRegistered: false })

    expect(result.staged).toBe(true)
    expect(result.preview.line_amounts_interpreted_as).toBeUndefined()
    expect(params!.items[0]).toMatchObject({ line_total: 1250, vat_rate: 0, vat_amount: 0 })
    expect(params!.total).toBe(1250)
  })

  it('books foreign VAT as cost when the lines are printed incl. it, without a second 19 %', async () => {
    const foreignGross = {
      ...grossBill,
      invoice: { ...grossBill.invoice, currency: 'EUR' },
      totals: { subtotal: 100, vatAmount: 19, total: 119 },
      lineItems: [{ description: 'Software', quantity: 1, unitPrice: 119, lineTotal: 119, vatRate: 19, accountSuggestion: '6540' }],
    }
    mockResolveRate.mockResolvedValue({
      ok: true,
      rate: { currency: 'EUR', rate: 11.5, exchangeRate: 11.5, exchangeRateDate: '2026-09-20', source: 'fetched' },
    })
    const { result, params } = await stage(foreignGross)

    expect(result.staged).toBe(true)
    expect(result.preview.line_amounts_interpreted_as).toBe('gross')
    expect(params!.items[0]).toMatchObject({ line_total: 119, vat_rate: 0, vat_amount: 0 })
    expect(params!.total).toBe(119)
    expect(result.preview.foreign_vat_in_cost).toMatchObject({ amount: 19 })
  })

  it('stages nothing and says so when no line items were extracted', async () => {
    const inserts: Array<Record<string, unknown>> = []
    const supabase = makeMock({
      inbox: {
        id: 'inbox-gross',
        status: 'received',
        extracted_data: { ...grossBill, lineItems: [] },
        matched_supplier_id: 'supplier-1',
        created_supplier_invoice_id: null,
        document_id: 'doc-gross',
      },
      inserts,
    })
    const tool = tools.find((t) => t.name === 'gnubok_create_supplier_invoice_from_inbox')!
    const err = await tool
      .execute({ inbox_item_id: 'inbox-gross' }, 'company-1', 'user-1', supabase)
      .then(() => null, (e: unknown) => e as Error & { code?: string; remediation?: { tool?: string } })

    expect(err?.code).toBe('SI_CREATE_INVALID_INPUT')
    expect(err?.message).toMatch(/No line items were extracted/)
    expect(err?.remediation?.tool).toBe('gnubok_set_inbox_extracted_data')
    expect(inserts).toHaveLength(0)
  })
})

describe('gnubok_create_supplier_invoice_from_inbox: carries the OCR onto the invoice (feedback seq 869949)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  async function stage(paymentReference: unknown) {
    const inserts: Array<Record<string, unknown>> = []
    const supabase = makeMock({
      inbox: {
        id: 'inbox-ocr',
        status: 'received',
        extracted_data: { ...baseExtracted, invoice: { ...baseExtracted.invoice, paymentReference } },
        matched_supplier_id: 'supplier-1',
        created_supplier_invoice_id: null,
        document_id: 'doc-ocr',
      },
      inserts,
    })
    const tool = tools.find((t) => t.name === 'gnubok_create_supplier_invoice_from_inbox')!
    const result = (await tool.execute({ inbox_item_id: 'inbox-ocr' }, 'company-1', 'user-1', supabase)) as {
      staged: boolean
      preview: Record<string, unknown>
    }
    return { result, params: inserts[0]?.params as Record<string, unknown> }
  }

  it('stages the extracted paymentReference, trimmed, and shows it in the preview', async () => {
    const { result, params } = await stage(' 4711000012345 ')
    expect(result.staged).toBe(true)
    expect(params.payment_reference).toBe('4711000012345')
    expect(result.preview.payment_reference).toBe('4711000012345')
  })

  it('stages null when the extraction has none', async () => {
    for (const value of [null, '', '   ', undefined, 12345]) {
      const { params } = await stage(value)
      expect(params.payment_reference).toBeNull()
    }
  })
})

describe('gnubok_create_supplier_invoice_from_inbox: the preview says whether a verifikat is posted (feedback seq 930807)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  async function stageDry(companySettings?: Record<string, unknown>) {
    const supabase = makeMock({
      inbox: {
        id: 'inbox-will',
        status: 'received',
        extracted_data: baseExtracted,
        matched_supplier_id: 'supplier-1',
        created_supplier_invoice_id: null,
        document_id: 'doc-will',
      },
      ...(companySettings ? { companySettings } : {}),
    })
    const tool = tools.find((t) => t.name === 'gnubok_create_supplier_invoice_from_inbox')!
    return (await tool.execute(
      { inbox_item_id: 'inbox-will', dry_run: true },
      'company-1', 'user-1', supabase,
    )) as { preview: { will: string; will_post_journal_entry: boolean }; next?: { description: string } }
  }

  async function preview(companySettings?: Record<string, unknown>) {
    return (await stageDry(companySettings)).preview
  }

  it('promises the registration verifikat under faktureringsmetoden', async () => {
    const p = await preview({ accounting_method: 'accrual', defer_invoice_booking: false })
    expect(p.will_post_journal_entry).toBe(true)
    expect(p.will).toMatch(/post a registration journal entry on confirm/)
  })

  it('promises no verifikat when the company defers invoice booking, and names the Bokför tool', async () => {
    const p = await preview({ accounting_method: 'accrual', defer_invoice_booking: true })
    expect(p.will_post_journal_entry).toBe(false)
    expect(p.will).not.toMatch(/post a registration journal entry/)
    expect(p.will).toMatch(/defer_invoice_booking/)
    expect(p.will).toMatch(/gnubok_book_supplier_invoice/)
  })

  it('promises no verifikat under kontantmetoden', async () => {
    const p = await preview({ accounting_method: 'cash' })
    expect(p.will_post_journal_entry).toBe(false)
    expect(p.will).toMatch(/kontantmetoden/)
  })

  it('sends a kontantmetoden agent to payment, never to an attest step the company does not have (crm#1156)', async () => {
    const cash = await stageDry({ accounting_method: 'cash' })
    expect(cash.next?.description).toMatch(/kontantmetoden has no attest step/)
    expect(cash.next?.description).not.toMatch(/gnubok_approve_supplier_invoice/)
    const accrual = await stageDry({ accounting_method: 'accrual', defer_invoice_booking: false })
    expect(accrual.next?.description).toMatch(/attest via gnubok_approve_supplier_invoice/)
  })

  // #96: the preview read the method fail-open. A failed read staged from a
  // null row, which the booking-moment rule reads as faktureringsmetoden, so a
  // kontantmetod company was promised a registration verifikat.
  it.each([
    ['a failed read', { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }, 'SETTINGS_ACCOUNTING_METHOD_UNREADABLE'],
    ['no settings row', { data: null, error: null }, 'SETTINGS_ACCOUNTING_METHOD_MISSING'],
  ] as const)('refuses on %s instead of previewing faktureringsmetoden, and stages nothing', async (_label, settingsRead, code) => {
    const inserts: Array<Record<string, unknown>> = []
    const supabase = makeMock({
      inbox: {
        id: 'inbox-will',
        status: 'received',
        extracted_data: baseExtracted,
        matched_supplier_id: 'supplier-1',
        created_supplier_invoice_id: null,
        document_id: 'doc-will',
      },
      settingsRead,
      inserts,
    })
    const tool = tools.find((t) => t.name === 'gnubok_create_supplier_invoice_from_inbox')!
    for (const dryRun of [true, false]) {
      const err = await tool
        .execute({ inbox_item_id: 'inbox-will', dry_run: dryRun }, 'company-1', 'user-1', supabase)
        .then(() => null, (e: unknown) => e as Error & { code?: string })
      expect(err?.code).toBe(code)
      expect(toToolError(err).error.code).toBe(code)
    }
    expect(inserts).toHaveLength(0)
  })
})

describe('gnubok_create_supplier_invoice_from_inbox: begränsat momsavdrag per line (crm#1617)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // A leasing invoice as the report had it: the personbil leasing deducts
  // half its moms, the uppläggningsavgift all of it, the insurance has none.
  const leasingExtracted = {
    ...baseExtracted,
    totals: { subtotal: 15350, vat: 3637.5, total: 18987.5 },
    lineItems: [
      { description: 'Leasingavgift personbil', quantity: 1, unit_price: 14055, line_total: 14055, vat_rate: 25 },
      { description: 'Uppläggningsavgift', quantity: 1, unit_price: 495, line_total: 495, vat_rate: 25 },
      { description: 'Försäkringspremie', quantity: 1, unit_price: 800, line_total: 800, vat_rate: 0 },
    ],
  }
  const accounts = [
    { line_number: 1, account_number: '5615' },
    { line_number: 2, account_number: '5690' },
    { line_number: 3, account_number: '5612' },
  ]

  async function stage(lineOverrides: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
    const inserts: Array<Record<string, unknown>> = []
    const supabase = makeMock({
      inbox: {
        id: 'inbox-lease',
        status: 'received',
        extracted_data: leasingExtracted,
        matched_supplier_id: 'supplier-1',
        created_supplier_invoice_id: null,
        document_id: 'doc-lease',
      },
      inserts,
    })
    const tool = tools.find((t) => t.name === 'gnubok_create_supplier_invoice_from_inbox')!
    const result = (await tool.execute(
      { inbox_item_id: 'inbox-lease', line_overrides: lineOverrides, ...extra },
      'company-1', 'user-1', supabase,
    )) as { staged: boolean; preview: Record<string, unknown> }
    return { result, params: inserts[0]?.params as StagedParams & { items: Array<{ vat_deduction_share?: number }> } }
  }

  it('deducts half the leasing line\'s moms and books the rest on its cost account, as the web editor does', async () => {
    const { result, params } = await stage([
      { ...accounts[0], vat_deduction_share: 0.5 },
      accounts[1],
      accounts[2],
    ])

    expect(result.staged).toBe(true)
    // The web editor books the same row the same way (bookLimitedDeduction).
    const web = bookLimitedDeduction<LimitedDeductionRow>([{ amount: 14055, vat_rate: 0.25, vat_deduction_share: 0.5 }], true).items[0]
    expect(params.items[0]).toMatchObject({ line_total: web.amount, vat_rate: 0.25, vat_amount: web.vat_amount, vat_deduction_share: 0.5 })
    expect(params.items[0]).toMatchObject({ line_total: 15811.87, vat_amount: 1756.88 })
    expect(params.items[1]).toMatchObject({ line_total: 495, vat_amount: 123.75 })
    expect(params.items[1].vat_deduction_share).toBeUndefined()
    expect(params.items[2]).toMatchObject({ line_total: 800, vat_amount: 0 })
    expect(params.vat_amount).toBe(1880.63)
    expect(params.total).toBe(18987.5)
    expect(result.preview.limited_vat_deduction).toMatchObject({
      lines: [{ line_number: 1, invoiced_vat: 3513.75, deductible_vat: 1756.88, vat_as_cost: 1756.87 }],
    })
    // The document's VAT per rate is not what is booked here: one figure only.
    expect(result.preview.vat_by_rate).toBeUndefined()
    expect(result.preview.vat_amount).toBe(1880.63)

    // The registration verifikat: half the leasing moms on 2641, the other
    // half on 5615, and 2440 credited with the invoice total.
    const lines = await registrationLines(params)
    expect(lines.find((l) => l.account_number === '5615')?.debit_amount).toBe(15811.87)
    expect(lines.find((l) => l.account_number === '5690')?.debit_amount).toBe(495)
    expect(lines.find((l) => l.account_number === '5612')?.debit_amount).toBe(800)
    expect(lines.find((l) => l.account_number === '2641')?.debit_amount).toBe(1880.63)
    expect(lines.find((l) => l.account_number === '2440')?.credit_amount).toBe(18987.5)

    // What the approval commits: the staged lines go in as they are.
    const conversion = stagedConversion(params as unknown as Record<string, unknown>)
    expect(conversion.ok).toBe(true)
    if (conversion.ok) {
      expect(conversion.body.items[0]).toMatchObject({ amount: 15811.87, vat_rate: 0.25, vat_amount: 1756.88 })
    }
  })

  it('a share of 0 books the line at 0 % with all its moms as cost', async () => {
    const { params } = await stage([{ ...accounts[0], vat_deduction_share: 0 }, accounts[1], accounts[2]])
    expect(params.items[0]).toMatchObject({ line_total: 17568.75, vat_rate: 0, vat_amount: 0 })
    expect(params.vat_amount).toBe(123.75)
    expect(params.total).toBe(18987.5)
  })

  it('refuses a share on a line without moms', async () => {
    await expect(stage([accounts[0], accounts[1], { ...accounts[2], vat_deduction_share: 0.5 }]))
      .rejects.toThrow(/line 3: .*no Swedish moms/)
  })

  it('refuses a share on a line the invoice does not have', async () => {
    await expect(stage([...accounts, { line_number: 4, vat_deduction_share: 0.5 }]))
      .rejects.toThrow(/line 4: the invoice has no such line/)
  })

  it('refuses a share outside 0 to 1', async () => {
    await expect(stage([{ ...accounts[0], vat_deduction_share: 50 }, accounts[1], accounts[2]]))
      .rejects.toThrow(/from 0 to 1/)
  })

  it('refuses a share under reverse charge, where the seller charges no deductible moms', async () => {
    const err = await stage(
      [{ ...accounts[0], vat_deduction_share: 0.5 }, accounts[1], accounts[2]],
      { vat_treatment_override: 'reverse_charge' },
    ).catch((e: unknown) => e)
    expect((err as Error).message).toMatch(/omvänd skattskyldighet/)
    // The person the agent relays to reads why, not the generic sentence.
    expect(getStructuredError(err).message_sv).toBe(SI_CREATE_INVALID_INPUT_REASONS.limited_deduction_without_seller_vat.message_sv)
  })
})
