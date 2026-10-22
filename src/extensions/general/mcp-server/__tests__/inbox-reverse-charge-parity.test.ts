/**
 * accounted#58: gnubok_create_supplier_invoice_from_inbox and its commit
 * executor resolve a supplier invoice's VAT treatment through the function the
 * dashboard and v1 doors use (resolveSupplierInvoiceReverseCharge). The MCP
 * door used to default every invoice to standard_25 whatever the supplier, so
 * an EU or non-EU supplier's invoice was registered and posted without
 * omvänd skattskyldighet.
 *
 * Omvänd skattskyldighet (swedish-vat skill 2.1-2.3; ML 16 kap 6 §): a
 * purchase from an EU or non-EU business is self-assessed by the buyer:
 * fiktiv moms 2645 (ruta 48) against 2614 (ruta 30), and the basis on 4535
 * (EU services, ruta 21) or 4531 (non-EU services, ruta 22) against 4598.
 * Both sides are reported; the leverantörsskuld on 2440 is the net.
 *
 * One inbox item and one supplier card, four doors: the dashboard and v1
 * convert (convertInboxItemToSupplierInvoice), the v1 create
 * (createSupplierInvoice), the MCP staging and the MCP approval
 * (commitPendingOperation on the staged params).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { eventBus } from '@/lib/events/bus'
import { createLogger } from '@/lib/logger'
import {
  createTableMockSupabase,
  makeCompanySettings,
  makeInvoiceInboxItem,
  makeJournalEntry,
  makeSupplier,
} from '@/tests/helpers'
import type { PendingOperation, SupplierInvoiceItem } from '@/types'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(), createServiceClient: vi.fn() }))
vi.mock('@/lib/bookkeeping/supplier-invoice-entries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/supplier-invoice-entries')>()),
  createSupplierInvoiceRegistrationEntry: vi.fn(),
}))
vi.mock('@/lib/suggestion-log/inbox', () => ({
  snapshotInboxExtraction: vi.fn().mockResolvedValue(null),
  recordInboxDecision: vi.fn().mockResolvedValue(undefined),
  loadEntryLines: vi.fn().mockResolvedValue([]),
}))

import { tools } from '../server'
import { toToolError } from '../tool-result'
import { inferVatTreatment } from '@/lib/supplier-invoices/form-payload'
import { CreateSupplierInvoiceSchema } from '@/lib/api/schemas'
import { createSupplierInvoiceRegistrationEntry } from '@/lib/bookkeeping/supplier-invoice-entries'
import {
  supplierInvoiceRegistrationLines,
  type SupplierInvoiceBookingItem,
  type SupplierInvoiceRegistrationHeader,
} from '@/lib/bookkeeping/supplier-invoice-registration-lines'
import { convertInboxItemToSupplierInvoice } from '@/lib/operations/inbox-convert'
import { createSupplierInvoice, type CreateSupplierInvoiceInput } from '@/lib/supplier-invoices/create'
import { commitPendingOperation } from '@/lib/pending-operations/commit'

const SUPPLIER_ID = '00000000-0000-4000-8000-000000000001'
const ITEM_ID = '00000000-0000-4000-8000-000000000002'

type SupplierType = 'swedish_business' | 'eu_business' | 'non_eu_business'

/** A foreign SaaS invoice as the extraction reads it: 1 000 kr net, no VAT printed. */
const NO_VAT_EXTRACTION = {
  supplier: { name: 'Hosting Ltd', orgNumber: null, vatNumber: null },
  invoice: { invoiceNumber: 'H-2026-10', invoiceDate: '2026-10-01', dueDate: '2026-10-31', currency: 'SEK' },
  totals: { subtotal: 1000, vatAmount: 0, total: 1000 },
  lineItems: [{ description: 'Hosting oktober', quantity: 1, unitPrice: 1000, lineTotal: 1000, vatRate: 0, accountSuggestion: null }],
}

/** A Swedish supplier's invoice: 1 000 kr plus 25 % moms. */
const SWEDISH_EXTRACTION = {
  supplier: { name: 'Leverantör AB', orgNumber: '5599887766', vatNumber: null },
  invoice: { invoiceNumber: 'L-2026-10', invoiceDate: '2026-10-01', dueDate: '2026-10-31', currency: 'SEK' },
  totals: { subtotal: 1000, vatAmount: 250, total: 1250 },
  lineItems: [{ description: 'Konsulttimmar', quantity: 1, unitPrice: 1000, lineTotal: 1000, vatRate: 25, accountSuggestion: null }],
}

let db: ReturnType<typeof createTableMockSupabase>

function setUp(supplierType: SupplierType, extracted: object = NO_VAT_EXTRACTION, vatRegistered = true) {
  db = createTableMockSupabase({
    pending_operations: { data: { id: 'op-1' } },
    invoice_inbox_items: {
      data: makeInvoiceInboxItem({
        id: ITEM_ID,
        matched_supplier_id: SUPPLIER_ID,
        created_supplier_invoice_id: null,
        extracted_data: extracted as never,
      }),
    },
    suppliers: {
      data: makeSupplier({
        id: SUPPLIER_ID,
        supplier_type: supplierType,
        default_expense_account: '6540',
        bankgiro: null,
        plusgiro: null,
        iban: null,
        bic: null,
      }),
    },
    // Faktureringsmetoden, booked on issue: the approval posts the registration verifikat.
    company_settings: {
      data: makeCompanySettings({ accounting_method: 'accrual', defer_invoice_booking: false, vat_registered: vatRegistered }),
    },
    companies: { data: { entity_type: 'aktiebolag' } },
    'rpc:get_next_arrival_number': { data: 42 },
    supplier_invoices: { data: { id: 'invoice-1', status: 'registered', arrival_number: 42, registration_journal_entry_id: null } },
    supplier_invoice_items: { data: [{ id: 'line-1', sort_order: 0 }] },
  })
}

const ctx = () => ({
  supabase: db.supabase as unknown as SupabaseClient,
  companyId: 'company-1',
  userId: 'user-1',
  log: createLogger('inbox-reverse-charge-parity-test'),
})

const inboxTool = () => tools.find((t) => t.name === 'gnubok_create_supplier_invoice_from_inbox')!

/** Stage through the MCP tool; the params and the result the agent reads. */
async function mcpStage(args: Record<string, unknown> = {}) {
  const result = (await inboxTool().execute(
    { inbox_item_id: ITEM_ID, ...args },
    'company-1',
    'user-1',
    db.supabase as never,
  )) as { staged: boolean; preview: Record<string, unknown> }
  expect(result.staged).toBe(true)
  const params = (db.payloads('pending_operations', 'insert')[0] as { params: Record<string, unknown> }).params
  return { result, params }
}

/** Approve an operation with these params; returns the supplier_invoices row the executor wrote. */
async function mcpCommit(params: Record<string, unknown>) {
  const op = {
    id: 'op-1',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'create_supplier_invoice_from_inbox',
    status: 'pending',
    title: 'test',
    params,
    preview_data: {},
    result_data: null,
    actor_type: 'user',
    actor_id: null,
    actor_label: null,
    risk_level: 'medium',
    created_at: '2026-10-01T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-10-01T00:00:00Z',
  } as unknown as PendingOperation
  const result = await commitPendingOperation(db.supabase as never, 'user-1', 'company-1', op)
  expect(result.status).toBe('committed')
  return db.payloads('supplier_invoices', 'insert')[0] as Record<string, unknown>
}

/**
 * The registration verifikat the real line builder makes from what the
 * executor handed createSupplierInvoiceRegistrationEntry: the header it
 * inserted, its item rows and the supplier type it passed. No account in the
 * (empty) kontoplan carries a momskod, so the basis pair is booked.
 */
function registrationLines(insertedHeader: Record<string, unknown>) {
  const [, , , , items, supplierType] = vi.mocked(createSupplierInvoiceRegistrationEntry).mock.calls[0]
  return supplierInvoiceRegistrationLines(
    insertedHeader as unknown as SupplierInvoiceRegistrationHeader,
    items as unknown as SupplierInvoiceBookingItem[],
    supplierType,
    'Leverantörsfaktura',
    new Map(),
  ).map((line) => ({ account: line.account_number, debit: line.debit_amount, credit: line.credit_amount }))
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  vi.mocked(createSupplierInvoiceRegistrationEntry).mockResolvedValue(makeJournalEntry({ id: 'je-1' }))
})

describe('MCP inbox supplier invoice: a foreign supplier is omvänd skattskyldighet (accounted#58)', () => {
  it.each([
    ['eu_business', '4535'],
    ['non_eu_business', '4531'],
  ] as const)('%s without an override: staged and committed as reverse charge, with fiktiv moms and its basis', async (supplierType, basisAccount) => {
    setUp(supplierType)
    const { result, params } = await mcpStage()

    expect(params).toMatchObject({ vat_treatment: 'reverse_charge', subtotal: 1000, vat_amount: 0, total: 1000 })
    // Only the treatment is staged: the grant door refuses a param it does not know.
    expect(params).not.toHaveProperty('reverse_charge')
    expect(result.preview.vat_treatment).toBe('reverse_charge')
    expect(result.preview.compliance_warning).toBeUndefined()

    const row = await mcpCommit(params)
    expect(row).toMatchObject({ vat_treatment: 'reverse_charge', reverse_charge: true, total: 1000, remaining_amount: 1000 })
    expect(vi.mocked(createSupplierInvoiceRegistrationEntry).mock.calls[0][5]).toBe(supplierType)

    const lines = registrationLines(row)
    expect(lines).toEqual(expect.arrayContaining([
      { account: '6540', debit: 1000, credit: 0 },
      { account: '2645', debit: 250, credit: 0 },
      { account: '2614', debit: 0, credit: 250 },
      { account: basisAccount, debit: 1000, credit: 0 },
      { account: '4598', debit: 0, credit: 1000 },
      { account: '2440', debit: 0, credit: 1000 },
    ]))
    expect(lines.some((line) => line.account === '2641')).toBe(false)
  })

  it('a Swedish supplier is unchanged: standard_25, 2641 deducted, the gross on 2440, no fiktiv moms', async () => {
    setUp('swedish_business', SWEDISH_EXTRACTION)
    const { result, params } = await mcpStage()

    expect(params).toMatchObject({ vat_treatment: 'standard_25', subtotal: 1000, vat_amount: 250, total: 1250 })
    expect(result.preview.compliance_warning).toBeUndefined()

    const row = await mcpCommit(params)
    expect(row).toMatchObject({ vat_treatment: 'standard_25', reverse_charge: false, total: 1250 })
    const lines = registrationLines(row)
    expect(lines).toEqual([
      { account: '6540', debit: 1000, credit: 0 },
      { account: '2641', debit: 250, credit: 0 },
      { account: '2440', debit: 0, credit: 1250 },
    ])
  })

  it('an explicit override is the caller\'s word, and turning reverse charge off for a foreign supplier is named to the approver', async () => {
    setUp('eu_business')
    const { result, params } = await mcpStage({ vat_treatment_override: 'exempt' })

    expect(params).toMatchObject({ vat_treatment: 'exempt', vat_amount: 0, total: 1000 })
    expect(result.preview.compliance_warning).toEqual(expect.stringContaining('omvänd skattskyldighet'))
    expect(result.preview.compliance_warning).toEqual(expect.stringContaining('exempt'))

    const row = await mcpCommit(params)
    expect(row).toMatchObject({ vat_treatment: 'exempt', reverse_charge: false })
  })

  it('the same override on a Swedish supplier carries no such note', async () => {
    setUp('swedish_business')
    const { result, params } = await mcpStage({ vat_treatment_override: 'exempt' })

    expect(params).toMatchObject({ vat_treatment: 'exempt' })
    expect(result.preview.compliance_warning).toBeUndefined()
  })

  it('the executor commits the treatment the approver saw, a staged reverse_charge with the flag on', async () => {
    setUp('swedish_business')
    const { params } = await mcpStage({ vat_treatment_override: 'reverse_charge' })

    const row = await mcpCommit(params)

    expect(row).toMatchObject({ vat_treatment: 'reverse_charge', reverse_charge: true })
  })

  it('an operation without a treatment takes the supplier\'s default at commit: reverse charge for an EU supplier', async () => {
    setUp('eu_business')
    const { params } = await mcpStage()
    const { vat_treatment: _dropped, ...withoutTreatment } = params

    const row = await mcpCommit(withoutTreatment)

    expect(row).toMatchObject({ vat_treatment: 'reverse_charge', reverse_charge: true })
    const lines = registrationLines(row)
    expect(lines).toEqual(expect.arrayContaining([
      { account: '2645', debit: 250, credit: 0 },
      { account: '2614', debit: 0, credit: 250 },
    ]))
  })

  it('a stray reverse_charge param cannot pair the flag with another treatment', async () => {
    setUp('swedish_business', SWEDISH_EXTRACTION)
    const { params } = await mcpStage()

    const row = await mcpCommit({ ...params, reverse_charge: true })

    expect(row).toMatchObject({ vat_treatment: 'standard_25', reverse_charge: false })
  })
})

/** A Swedish hotel's invoice: 1 000 kr plus 12 % moms. */
const REDUCED_EXTRACTION = {
  supplier: { name: 'Hotell AB', orgNumber: '5599887755', vatNumber: null },
  invoice: { invoiceNumber: 'R-2026-10', invoiceDate: '2026-10-01', dueDate: '2026-10-31', currency: 'SEK' },
  totals: { subtotal: 1000, vatAmount: 120, total: 1120 },
  lineItems: [{ description: 'Logi, 2 nätter', quantity: 1, unitPrice: 1000, lineTotal: 1000, vatRate: 12, accountSuggestion: null }],
}

// accounted#58 P1.2, a Swedish supplier: the treatment was standard_25
// whatever the document said. The line rates give it by the dashboard form's
// rule (inferVatTreatment). A document with no VAT at all reads the same for
// an exempt purchase and for omvänd betalningsskyldighet (byggtjänster,
// ML 16 kap 13 §; fiktiv moms 2647/2614, swedish-vat skill 2.1), so it waits
// for the caller's word instead of a guess.
describe('MCP inbox supplier invoice: a Swedish supplier\'s treatment comes from the document or the caller (accounted#58)', () => {
  it('refuses a document with no VAT and no stated treatment, names the retry, and stages nothing', async () => {
    setUp('swedish_business')

    const err = await inboxTool()
      .execute({ inbox_item_id: ITEM_ID }, 'company-1', 'user-1', db.supabase as never)
      .then(() => null, (e: unknown) => e as Error & { code?: string; remediation?: { tool?: string; args?: Record<string, unknown> } })

    expect(err?.code).toBe('SI_CREATE_INVALID_INPUT')
    expect(err?.message).toMatch(/vat_treatment_override/)
    expect(err?.message).toMatch(/exempt/)
    expect(err?.message).toMatch(/omvänd betalningsskyldighet/)
    // The retry is named, the treatment is not guessed for the caller.
    expect(err?.remediation).toEqual(expect.objectContaining({
      tool: 'gnubok_create_supplier_invoice_from_inbox',
      args: { inbox_item_id: ITEM_ID },
    }))
    expect(db.payloads('pending_operations', 'insert')).toHaveLength(0)
    expect(toToolError(err).error).toMatchObject({
      code: 'SI_CREATE_INVALID_INPUT',
      retryable: false,
      remediation: { tool: 'gnubok_create_supplier_invoice_from_inbox' },
    })
  })

  it('a dry run is refused the same way', async () => {
    setUp('swedish_business')

    await expect(inboxTool().execute(
      { inbox_item_id: ITEM_ID, dry_run: true },
      'company-1',
      'user-1',
      db.supabase as never,
    )).rejects.toMatchObject({ code: 'SI_CREATE_INVALID_INPUT' })
  })

  it('stated exempt, it stages and books the cost alone: no 2641, no fiktiv moms', async () => {
    setUp('swedish_business')
    const { params } = await mcpStage({ vat_treatment_override: 'exempt' })

    expect(params).toMatchObject({ vat_treatment: 'exempt', vat_amount: 0, total: 1000 })
    const row = await mcpCommit(params)
    expect(row).toMatchObject({ vat_treatment: 'exempt', reverse_charge: false })
    expect(registrationLines(row)).toEqual([
      { account: '6540', debit: 1000, credit: 0 },
      { account: '2440', debit: 0, credit: 1000 },
    ])
  })

  it('a company outside the VAT register is not asked: exempt, as the dashboard form says', async () => {
    setUp('swedish_business', NO_VAT_EXTRACTION, false)
    const { params } = await mcpStage()

    expect(params).toMatchObject({ vat_treatment: 'exempt', vat_amount: 0, total: 1000 })
  })

  it('a reduced rate on every line gives the reduced treatment, the dashboard form\'s rule', async () => {
    setUp('swedish_business', REDUCED_EXTRACTION)
    const { params } = await mcpStage()

    expect(params.vat_treatment).toBe(inferVatTreatment([{ vat_rate: 0.12 }], false))
    expect(params).toMatchObject({ vat_treatment: 'reduced_12', vat_amount: 120, total: 1120 })
    const row = await mcpCommit(params)
    expect(row).toMatchObject({ vat_treatment: 'reduced_12', reverse_charge: false })
    expect(registrationLines(row)).toEqual([
      { account: '6540', debit: 1000, credit: 0 },
      { account: '2641', debit: 120, credit: 0 },
      { account: '2440', debit: 0, credit: 1120 },
    ])
  })
})

// crm#1323: an EU supplier's goods are a gemenskapsinternt förvärv, reported
// in ruta 20 on 4515 (swedish-vat skill 2.3), not ruta 21 on 4535.
// #73: ML 2023:200 7 kap. 26 § puts an EU goods acquisition's moms in the
// invoice's period whatever the method; EU services follow 7 kap. 16 §.
describe('MCP inbox supplier invoice: kontantmetoden registers EU goods, not EU services (#73)', () => {
  it.each([
    ['eu_goods', true],
    ['eu_services', false],
  ] as const)('%s: the preview and the approval agree on the registration verifikat (%s)', async (kind, books) => {
    setUp('eu_business')
    db.setTable('company_settings', {
      data: makeCompanySettings({ accounting_method: 'cash', defer_invoice_booking: false, vat_registered: true }),
    })
    const { result, params } = await mcpStage({ reverse_charge_kind: kind })
    expect(result.preview.will_post_journal_entry).toBe(books)

    await mcpCommit(params)
    expect(createSupplierInvoiceRegistrationEntry).toHaveBeenCalledTimes(books ? 1 : 0)
  })
})

describe('MCP inbox supplier invoice: EU goods or services (crm#1323)', () => {
  it('stages eu_goods, shows it to the approver, and commits the goods basis 4515/4598', async () => {
    setUp('eu_business')
    const { result, params } = await mcpStage({ reverse_charge_kind: 'eu_goods' })

    expect(params).toMatchObject({ vat_treatment: 'reverse_charge', reverse_charge_kind: 'eu_goods' })
    expect(result.preview.reverse_charge_kind).toBe('eu_goods')

    const row = await mcpCommit(params)
    expect(row).toMatchObject({ reverse_charge: true, reverse_charge_kind: 'eu_goods' })
    const lines = registrationLines(row)
    expect(lines).toEqual(expect.arrayContaining([
      { account: '4515', debit: 1000, credit: 0 },
      { account: '4598', debit: 0, credit: 1000 },
    ]))
    expect(lines.some((line) => line.account === '4535')).toBe(false)
  })

  it('stages nothing extra without a kind, so a company grant still knows every param', async () => {
    setUp('eu_business')
    const { params } = await mcpStage()

    expect(params).not.toHaveProperty('reverse_charge_kind')
    const row = await mcpCommit(params)
    expect(row.reverse_charge_kind).toBeNull()
  })

  it('refuses a kind for a supplier outside the EU at staging', async () => {
    setUp('non_eu_business')

    await expect(inboxTool().execute(
      { inbox_item_id: ITEM_ID, reverse_charge_kind: 'eu_goods' },
      'company-1',
      'user-1',
      db.supabase as never,
    )).rejects.toThrow(/eu_business/)
    expect(db.payloads('pending_operations', 'insert')).toHaveLength(0)
  })

  it('refuses at commit a kind the supplier cannot have, before an ankomstnummer is drawn', async () => {
    setUp('swedish_business', SWEDISH_EXTRACTION)
    const { params } = await mcpStage()
    const op = { ...params, reverse_charge_kind: 'eu_goods' }

    const result = await commitPendingOperation(db.supabase as never, 'user-1', 'company-1', {
      id: 'op-1', user_id: 'user-1', company_id: 'company-1', operation_type: 'create_supplier_invoice_from_inbox',
      status: 'pending', title: 'test', params: op, preview_data: {}, result_data: null, actor_type: 'user',
      actor_id: null, actor_label: null, risk_level: 'medium', created_at: '2026-10-01T00:00:00Z',
      resolved_at: null, updated_at: '2026-10-01T00:00:00Z',
    } as unknown as PendingOperation)

    expect(result.status).not.toBe('committed')
    expect(db.payloads('supplier_invoices', 'insert')).toHaveLength(0)
  })
})

/** What each door resolves, for one stated intent. */
type Stated = 'nothing' | 'reverse charge' | 'exempt'

async function dashboardAndV1Convert(stated: Stated) {
  const body = CreateSupplierInvoiceSchema.parse({
    supplier_id: SUPPLIER_ID,
    supplier_invoice_number: 'H-2026-10',
    invoice_date: '2026-10-01',
    due_date: '2026-10-31',
    items: [{ description: 'Hosting oktober', amount: 1000, account_number: '6540' }],
    ...(stated === 'reverse charge' ? { reverse_charge: true } : {}),
    ...(stated === 'exempt' ? { reverse_charge: false, vat_treatment: 'exempt' } : {}),
  })
  const outcome = await convertInboxItemToSupplierInvoice(ctx(), ITEM_ID, body, { dryRun: true, emit: vi.fn() })
  if (!outcome.ok || !outcome.dryRun) throw new Error(`convert refused: ${JSON.stringify(outcome)}`)
  return { vat_treatment: outcome.preview.vat_treatment, reverse_charge: outcome.preview.reverse_charge }
}

async function v1Create(stated: Stated) {
  const result = await createSupplierInvoice(
    ctx(),
    {
      supplier_id: SUPPLIER_ID,
      supplier_invoice_number: 'H-2026-10',
      invoice_date: '2026-10-01',
      due_date: '2026-10-31',
      items: [{ description: 'Hosting oktober', amount: 1000, account_number: '6540' }],
      ...(stated === 'reverse charge' ? { reverse_charge: true } : {}),
      ...(stated === 'exempt' ? { reverse_charge: false, vat_treatment: 'exempt' } : {}),
    } as CreateSupplierInvoiceInput,
    { dryRun: true },
  )
  if (!result.ok || !('dryRun' in result) || !result.dryRun) throw new Error(`create refused: ${JSON.stringify(result)}`)
  return { vat_treatment: result.preview.vat_treatment, reverse_charge: result.preview.reverse_charge }
}

function mcpArgs(stated: Stated) {
  if (stated === 'reverse charge') return { vat_treatment_override: 'reverse_charge' }
  if (stated === 'exempt') return { vat_treatment_override: 'exempt' }
  return {}
}

async function mcpStaging(stated: Stated) {
  const { params } = await mcpStage(mcpArgs(stated))
  // The flag is not staged: the executor derives it from the treatment.
  return { vat_treatment: params.vat_treatment, reverse_charge: params.vat_treatment === 'reverse_charge' }
}

async function mcpApproval(stated: Stated) {
  const { params } = await mcpStage(mcpArgs(stated))
  const row = await mcpCommit(params)
  return { vat_treatment: row.vat_treatment, reverse_charge: row.reverse_charge }
}

const DOORS = [
  ['dashboard and v1 convert', dashboardAndV1Convert],
  ['v1 create', v1Create],
  ['MCP staging', mcpStaging],
  ['MCP approval', mcpApproval],
] as const

const EXPECTED: Array<[SupplierType, Stated, { vat_treatment: string; reverse_charge: boolean }]> = [
  ['swedish_business', 'nothing', { vat_treatment: 'standard_25', reverse_charge: false }],
  ['eu_business', 'nothing', { vat_treatment: 'reverse_charge', reverse_charge: true }],
  ['non_eu_business', 'nothing', { vat_treatment: 'reverse_charge', reverse_charge: true }],
  ['swedish_business', 'reverse charge', { vat_treatment: 'reverse_charge', reverse_charge: true }],
  ['eu_business', 'exempt', { vat_treatment: 'exempt', reverse_charge: false }],
  ['non_eu_business', 'exempt', { vat_treatment: 'exempt', reverse_charge: false }],
]

describe('every door resolves the same treatment for the same supplier and the same stated intent', () => {
  describe.each(DOORS)('%s', (_door, run) => {
    it.each(EXPECTED)('%s, %s stated', async (supplierType, stated, expected) => {
      // A Swedish supplier with nothing stated: its 25 % invoice. A document
      // with no VAT waits for the caller's word at the MCP door (see above).
      setUp(supplierType, supplierType === 'swedish_business' && stated === 'nothing' ? SWEDISH_EXTRACTION : NO_VAT_EXTRACTION)
      expect(await run(stated)).toEqual(expected)
    })
  })
})
