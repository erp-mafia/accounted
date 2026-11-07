import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/core/bookkeeping/kontantmetod-cutoff', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/core/bookkeeping/kontantmetod-cutoff')
  >('@/lib/core/bookkeeping/kontantmetod-cutoff')
  return {
    ...actual,
    assessKontantmetodCutoff: vi.fn(),
    previewPaidBeforePostingCorrections: vi.fn(),
  }
})

// The pre-flight runs for real over these two reads (test plan section 8).
vi.mock('@/lib/api/v1/check-period-lock', () => ({ checkPeriodLock: vi.fn() }))
vi.mock('@/lib/vat/filing-record-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/vat/filing-record-store')>()),
  listVatFilings: vi.fn(),
}))

import { tools, deriveToolMeta } from '../server'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'
import {
  assessKontantmetodCutoff,
  buildCutoffLines,
  previewPaidBeforePostingCorrections,
  type CutoffCollection,
  type KontantmetodCarryPlan,
  type KontantmetodCutoffAssessment,
  type PaidBeforePosting,
  type PaidBeforePostingCorrectionPreview,
} from '@/lib/core/bookkeeping/kontantmetod-cutoff'
import { checkPeriodLock } from '@/lib/api/v1/check-period-lock'
import { listVatFilings } from '@/lib/vat/filing-record-store'
import type { VatFilingRecord } from '@/lib/vat/filing-record'

const tool = tools.find((candidate) => candidate.name === 'gnubok_post_kontantmetod_cutoff')!
const searchTool = tools.find((candidate) => candidate.name === 'gnubok_search_tools')!

function makeSupabase(settings: Record<string, unknown> = {
  accounting_method: 'cash', entity_type: 'aktiebolag',
}) {
  const inserts: Array<Record<string, unknown>> = []
  const rows: Record<string, unknown> = {
    fiscal_periods: {
      id: 'fp-1', name: '2026', period_start: '2026-01-01', period_end: '2026-12-31',
      is_closed: false, locked_at: null,
    },
    company_settings: settings,
    pending_operations: { id: 'op-1' },
  }
  const from = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {}
    for (const name of ['select', 'eq', 'in', 'gte', 'lte', 'order', 'limit', 'is']) {
      chain[name] = () => chain
    }
    chain.insert = (value: Record<string, unknown>) => {
      inserts.push(value)
      return chain
    }
    chain.maybeSingle = async () => ({ data: rows[table] ?? null, error: null })
    chain.single = async () => ({ data: rows[table] ?? null, error: null })
    chain.then = (resolve: (value: unknown) => unknown) =>
      resolve({ data: rows[table] ?? null, error: null })
    return chain
  })
  return { auth: {}, from, inserts }
}

const plan = (invoiceId: string, side: 'customer' | 'supplier' = 'customer'): KontantmetodCarryPlan => ({
  side,
  invoiceId,
  reference: invoiceId.toUpperCase(),
  creditNote: false,
  mode: 'full',
  description: `${side === 'customer' ? 'Kundfaktura' : 'Leverantörsfaktura'} ${invoiceId.toUpperCase()}: obetald vid bokslut (kontantmetoden)`,
  notes: `Årsomföring kontantmetoden, BFL 5 kap 2 §, faktura ${invoiceId.toUpperCase()}`,
  lines: side === 'customer'
    ? [
        { account_number: '1510', debit_amount: 1250, credit_amount: 0 },
        { account_number: '3001', debit_amount: 0, credit_amount: 1000 },
        { account_number: '2611', debit_amount: 0, credit_amount: 250 },
      ]
    : [
        { account_number: '6110', debit_amount: 400, credit_amount: 0 },
        { account_number: '2641', debit_amount: 100, credit_amount: 0 },
        { account_number: '2440', debit_amount: 0, credit_amount: 500 },
      ],
  total: side === 'customer' ? 1250 : 500,
})

const paid: PaidBeforePosting = {
  side: 'customer', invoiceId: 'inv-2', reference: 'F-2', entryId: 'je-cash',
  entryDate: '2027-01-14', paymentRowId: 'pay-1', paymentAmount: 1250, carryEntryId: null,
}

const correction: PaidBeforePostingCorrectionPreview = {
  side: 'customer', invoiceId: 'inv-2', reference: 'F-2', entryId: 'je-cash', entryDate: '2027-01-14',
  carryEntryId: null,
  stornoLines: [
    { account_number: '1930', debit_amount: 0, credit_amount: 1250 },
    { account_number: '3001', debit_amount: 1000, credit_amount: 0 },
    { account_number: '2611', debit_amount: 250, credit_amount: 0 },
  ],
  correctedLines: [
    { account_number: '1930', debit_amount: 1250, credit_amount: 0 },
    { account_number: '1510', debit_amount: 0, credit_amount: 1250 },
  ],
}

const EMPTY_COLLECTION: CutoffCollection = {
  receivables: [],
  payables: [],
  unknownVatTreatment: [],
  strayVatOnZeroRate: [],
  undatedSettlements: [],
  rowlessSupplierInvoices: [],
  carries: [],
  rotPartialManual: [],
  rotPartialManualInvoices: [],
  paidBeforePosting: [],
  paidBeforePostingManual: [],
  legacyCovered: [],
}

function assessed(
  over: Omit<Partial<KontantmetodCutoffAssessment>, 'collection'> & { collection?: Partial<CutoffCollection> } = {},
): KontantmetodCutoffAssessment {
  const { collection, ...rest } = over
  return {
    mode: 'per_invoice',
    plans: [plan('inv-1'), plan('si-1', 'supplier'), plan('inv-2')],
    lines: buildCutoffLines([], [], 'aktiebolag'),
    postings: {
      complete: false, hasAny: false, receivableEntryId: null, receivableReversalId: null,
      payableEntryId: null, payableReversalId: null, missing: [], duplicates: [],
    },
    complete: false,
    legacyCutoffs: [],
    ...rest,
    collection: { ...EMPTY_COLLECTION, paidBeforePosting: [paid], ...collection },
  }
}

const ROT_TARGET = {
  invoiceId: 'inv-rot', reference: 'F-ROT', creditNote: false, openCustomerShareSek: 4750, openDeductionSek: 2035.71,
  openPartHasVat: true,
}
const ROT_LINES = [
  { account_number: '1510', debit_amount: 4750, credit_amount: 0 },
  { account_number: '1513', debit_amount: 2035.71, credit_amount: 0 },
  { account_number: '3001', debit_amount: 0, credit_amount: 5428.57 },
  { account_number: '2611', debit_amount: 0, credit_amount: 1357.14 },
]

const filedQ4: VatFilingRecord = {
  deadline_id: 'dl-1', period_type: 'quarterly', year: 2026, period: 4, tax_period: '2026-Q4',
  period_start: '2026-10-01', period_end: '2026-12-31', filed_on: '2027-02-12',
  source: 'manual', reference: null,
}

type Staged = {
  staged: boolean
  risk_level: string
  message: string
  preview: Record<string, unknown> & {
    entries: Array<Record<string, unknown>>
    corrections: Array<Record<string, unknown>>
  }
}

const stage = async (args: Record<string, unknown> = {}, supabase = makeSupabase()) =>
  (await tool.execute(
    { fiscal_period_id: 'fp-1', ...args },
    'company-1', 'user-1', supabase as never, { type: 'api_key' },
  )) as Staged

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2027-02-20T12:00:00Z'))
  vi.mocked(assessKontantmetodCutoff).mockResolvedValue(assessed())
  vi.mocked(previewPaidBeforePostingCorrections).mockResolvedValue({ corrections: [correction], refusals: [] })
  vi.mocked(checkPeriodLock).mockResolvedValue({ locked: false, fiscal_period_id: 'fp-1' })
  vi.mocked(listVatFilings).mockResolvedValue([])
})

afterEach(() => {
  vi.useRealTimers()
})

describe('gnubok_post_kontantmetod_cutoff', () => {
  it('is a discoverable high-risk staged bookkeeping write with readiness preflight', () => {
    expect(tool).toBeDefined()
    expect(tool.catalogVisibility).toBe('search')
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true })
    expect(TOOL_SCOPE_MAP.gnubok_post_kontantmetod_cutoff).toBe('bookkeeping:write')
    expect(deriveToolMeta(tool)).toMatchObject({
      requires_approval: true,
      approve_tool: 'gnubok_approve_pending_operation',
      preflight: 'gnubok_year_end_readiness',
    })
    // No vändning any more (#3440): the description must not promise one.
    expect(tool.description).not.toMatch(/next-period reversals/i)
    expect(tool.description).toMatch(/no reversal/)
    expect(tool.description).toMatch(/per invoice/)
  })

  it('is returned by full catalog search with its approval metadata', async () => {
    const result = await searchTool.execute(
      {
        query: 'kontantmetod cutoff',
        detail: 'full',
        __keyScopes: ['bookkeeping:write'],
      },
      'company-1',
      'user-1',
      makeSupabase() as never,
    ) as { tools: Array<Record<string, unknown>> }
    expect(result.tools).toContainEqual(expect.objectContaining({
      name: 'gnubok_post_kontantmetod_cutoff',
      scope: 'bookkeeping:write',
      _meta: expect.objectContaining({
        requires_approval: true,
        approve_tool: 'gnubok_approve_pending_operation',
        preflight: 'gnubok_year_end_readiness',
      }),
    }))
  })

  it('stages one carry verifikat per invoice and each correction, without a next period', async () => {
    const supabase = makeSupabase()
    const result = await stage({}, supabase)

    expect(result.staged).toBe(true)
    expect(result.risk_level).toBe('high')
    expect(result.preview.entries).toHaveLength(3)
    expect(result.preview.entries.map((e) => [e.invoice_id, e.entry_date, e.kind])).toEqual([
      ['inv-1', '2026-12-31', 'carry'],
      ['si-1', '2026-12-31', 'carry'],
      ['inv-2', '2026-12-31', 'carry'],
    ])
    expect(result.preview.entries[0]?.lines).toEqual(plan('inv-1').lines)
    expect(result.preview.corrections).toEqual([{
      side: 'customer', invoice_id: 'inv-2', reference: 'F-2', cash_entry_id: 'je-cash',
      entry_date: '2027-01-14', carry_entry_id: null,
      storno_lines: correction.stornoLines, corrected_lines: correction.correctedLines,
    }])
    expect(assessKontantmetodCutoff).toHaveBeenCalledWith(
      expect.anything(), 'company-1', expect.objectContaining({ id: 'fp-1' }), null, 'aktiebolag',
      { acknowledgedLegacyInvoiceIds: [] },
    )
    expect(supabase.inserts).toHaveLength(1)
    expect(supabase.inserts[0]).toMatchObject({
      operation_type: 'post_kontantmetod_cutoff',
      risk_level: 'high',
      params: {
        fiscal_period_id: 'fp-1',
        period_end: '2026-12-31',
        entity_type: 'aktiebolag',
        acknowledge_filed_vat_periods: [],
        acknowledge_legacy_invoice_ids: [],
        preview_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    })
    expect((supabase.inserts[0]!.params as Record<string, unknown>)).not.toHaveProperty('next_fiscal_period_id')
  })

  it('fingerprints the collection, the corrections and the acknowledgements', async () => {
    const fingerprintOf = async (args: Record<string, unknown> = {}) => {
      const supabase = makeSupabase()
      await stage(args, supabase)
      return (supabase.inserts[0]!.params as Record<string, string>).preview_fingerprint
    }
    const base = await fingerprintOf()
    expect(await fingerprintOf()).toBe(base)

    vi.mocked(assessKontantmetodCutoff).mockResolvedValueOnce(assessed({ plans: [plan('inv-1')] }))
    expect(await fingerprintOf()).not.toBe(base)

    vi.mocked(previewPaidBeforePostingCorrections).mockResolvedValueOnce({
      corrections: [{ ...correction, correctedLines: [
        { account_number: '1930', debit_amount: 1240, credit_amount: 0 },
        { account_number: '1510', debit_amount: 0, credit_amount: 1240 },
      ] }],
      refusals: [],
    })
    expect(await fingerprintOf()).not.toBe(base)

    expect(await fingerprintOf({ acknowledge_legacy_invoice_ids: ['inv-old'] })).not.toBe(base)
    vi.mocked(listVatFilings).mockResolvedValueOnce([filedQ4])
    expect(await fingerprintOf({ acknowledge_filed_vat_periods: ['2026-Q4'] })).not.toBe(base)
  })

  it('refuses with KONTANTMETOD_CUTOFF_PERIOD_LOCKED for the period end and for a correction date', async () => {
    vi.mocked(checkPeriodLock).mockImplementation(async (_s, _c, date) =>
      date === '2026-12-31' ? { locked: true, reason: 'period_locked_at_set', fiscal_period_id: 'fp-1' } : { locked: false })
    await expect(stage()).rejects.toMatchObject({ code: 'KONTANTMETOD_CUTOFF_PERIOD_LOCKED', message: expect.stringContaining('2026-12-31') })

    vi.mocked(checkPeriodLock).mockImplementation(async (_s, _c, date) =>
      date === '2027-01-14' ? { locked: true, reason: 'company_lock_date_covers' } : { locked: false })
    const supabase = makeSupabase()
    await expect(stage({}, supabase)).rejects.toMatchObject({ code: 'KONTANTMETOD_CUTOFF_PERIOD_LOCKED', message: expect.stringContaining('2027-01-14') })
    expect(supabase.inserts).toHaveLength(0)
  })

  it('refuses a filed VAT period until acknowledged, then names the rättad momsdeklaration', async () => {
    vi.mocked(listVatFilings).mockResolvedValue([filedQ4])
    const refused = makeSupabase()
    await expect(stage({}, refused)).rejects.toMatchObject({
      code: 'KONTANTMETOD_CUTOFF_VAT_PERIOD_FILED',
      message: expect.stringContaining('2026-Q4'),
    })
    expect(refused.inserts).toHaveLength(0)

    const result = await stage({ acknowledge_filed_vat_periods: ['2026-Q4'] })
    expect(result.preview).toMatchObject({
      amended_vat_periods_required: [{ tax_period: '2026-Q4', filed_on: '2027-02-12' }],
      acknowledged_filed_vat_periods: ['2026-Q4'],
      compliance_warning: expect.stringContaining('rättad momsdeklaration'),
    })
  })

  it('previews the manual items, the legacy warning and the acknowledged legacy invoices', async () => {
    vi.mocked(assessKontantmetodCutoff).mockResolvedValueOnce(assessed({
      legacyCutoffs: [{ fiscalPeriodId: 'fp-2025', periodEnd: '2025-12-31', receivable: true, payable: false }],
      collection: {
        rotPartialManual: ['F-ROT'],
        rotPartialManualInvoices: [ROT_TARGET],
        paidBeforePostingManual: [{
          side: 'customer', invoiceId: 'inv-9', reference: 'F-9', entryId: 'je-batch',
          entryDate: '2027-01-10', paymentRowId: 'p-9', reason: 'shared_verifikat',
        }],
        legacyCovered: [{ side: 'customer', invoiceId: 'inv-old', reference: 'F-OLD', legacyPeriodEnd: '2025-12-31' }],
      },
    }))
    const result = await stage({ acknowledge_legacy_invoice_ids: ['inv-x'] })
    expect(assessKontantmetodCutoff).toHaveBeenCalledWith(
      expect.anything(), 'company-1', expect.anything(), null, 'aktiebolag',
      { acknowledgedLegacyInvoiceIds: ['inv-x'] },
    )
    expect(result.preview).toMatchObject({
      manual: {
        rot_partial: ['F-ROT'],
        paid_before_posting: [expect.objectContaining({ invoice_id: 'inv-9', reason: 'shared_verifikat' })],
        legacy_covered: [{ side: 'customer', invoice_id: 'inv-old', reference: 'F-OLD', legacy_period_end: '2025-12-31' }],
      },
      legacy_cutoffs: [{ fiscal_period_id: 'fp-2025', period_end: '2025-12-31' }],
      compliance_warning: expect.stringContaining('Makulera inte vändningarna'),
    })
  })

  it('names the first thing a person must do when nothing can be staged automatically', async () => {
    const manualOnly = (collection: Partial<CutoffCollection>) =>
      vi.mocked(assessKontantmetodCutoff).mockResolvedValueOnce(assessed({
        plans: [], collection: { paidBeforePosting: [], ...collection },
      }))
    vi.mocked(previewPaidBeforePostingCorrections).mockResolvedValue({ corrections: [], refusals: [] })

    manualOnly({ legacyCovered: [{ side: 'customer', invoiceId: 'inv-old', reference: 'F-OLD', legacyPeriodEnd: '2025-12-31' }] })
    await expect(stage()).rejects.toMatchObject({ code: 'KONTANTMETOD_LEGACY_COVERED' })

    manualOnly({ rotPartialManual: ['F-ROT'], rotPartialManualInvoices: [ROT_TARGET] })
    await expect(stage()).rejects.toMatchObject({ code: 'KONTANTMETOD_CUTOFF_ROT_PARTIAL_MANUAL' })

    manualOnly({ paidBeforePostingManual: [{
      side: 'customer', invoiceId: 'inv-9', reference: 'F-9', entryId: null, entryDate: null,
      paymentRowId: 'p-9', reason: 'no_verifikat',
    }] })
    await expect(stage()).rejects.toMatchObject({ code: 'KONTANTMETOD_CUTOFF_PAID_BEFORE_POSTING_MANUAL' })

    // Review of #3440: a re-run where only manual items remain still names
    // the filed VAT period holding the payment verifikat to correct.
    vi.mocked(listVatFilings).mockResolvedValueOnce([{
      ...filedQ4, period: 1, tax_period: '2027-01', period_type: 'monthly', year: 2027,
      period_start: '2027-01-01', period_end: '2027-01-31', filed_on: '2027-02-12',
    }])
    manualOnly({ paidBeforePostingManual: [{
      side: 'customer', invoiceId: 'inv-8', reference: 'F-8', entryId: 'je-manual', entryDate: '2027-01-10',
      paymentRowId: 'p-8', reason: 'not_generated_cash_entry',
    }] })
    const refused = await stage().then(() => null, (err: unknown) => err)
    expect(refused).toMatchObject({
      code: 'KONTANTMETOD_CUTOFF_PAID_BEFORE_POSTING_MANUAL',
      amended_vat_periods_required: [expect.objectContaining({ tax_period: '2027-01', filed_on: '2027-02-12' })],
      message: expect.stringContaining('2027-01 (filed 2027-02-12)'),
    })
    // Never lock-checked: the cut-off writes nothing on that date.
    expect(checkPeriodLock).not.toHaveBeenCalled()

    // A correction the rule refuses lands on the same code.
    vi.mocked(assessKontantmetodCutoff).mockResolvedValueOnce(assessed({ plans: [] }))
    vi.mocked(previewPaidBeforePostingCorrections).mockResolvedValueOnce({
      corrections: [],
      refusals: [{ side: 'customer', invoiceId: 'inv-2', reference: 'F-2', entryId: 'je-cash', entryDate: '2027-01-14', reason: 'konto 3002' }],
    })
    await expect(stage()).rejects.toMatchObject({ code: 'KONTANTMETOD_CUTOFF_PAID_BEFORE_POSTING_MANUAL' })
  })

  it('refuses accrual companies, invalid VAT, a legacy period, and a period with nothing left', async () => {
    await expect(stage({}, makeSupabase({ accounting_method: 'accrual', entity_type: 'aktiebolag' })))
      .rejects.toThrow(/inte kontantmetoden/i)

    vi.mocked(assessKontantmetodCutoff).mockResolvedValueOnce(assessed({ collection: { unknownVatTreatment: ['F-9'] } }))
    await expect(stage()).rejects.toThrow(/saknar momsinställning/i)

    // crm#1712: named, with what clears it, instead of "balanserar inte".
    vi.mocked(assessKontantmetodCutoff).mockResolvedValueOnce(assessed({
      plans: [plan('inv-1')], collection: { rowlessSupplierInvoices: ['ankomstnr 12'] },
    }))
    await expect(stage()).rejects.toMatchObject({
      code: 'KONTANTMETOD_CUTOFF_ROWLESS_SUPPLIER_INVOICE',
      message: expect.stringMatching(/^1 supplier invoice\(s\) unpaid at the year end have no rows.*: ankomstnr 12\. Add their rows, or link the verifikat/),
    })

    vi.mocked(assessKontantmetodCutoff).mockResolvedValueOnce(assessed({ mode: 'legacy', plans: [] }))
    await expect(stage()).rejects.toThrow(/äldre bokslutsavgränsning med vändning/)

    vi.mocked(previewPaidBeforePostingCorrections).mockResolvedValue({ corrections: [], refusals: [] })
    vi.mocked(assessKontantmetodCutoff).mockResolvedValueOnce(assessed({
      plans: [], complete: true, collection: { paidBeforePosting: [] },
      postings: { complete: true, hasAny: true, receivableEntryId: null, receivableReversalId: null, payableEntryId: null, payableReversalId: null, missing: [], duplicates: [] },
    }))
    await expect(stage()).rejects.toThrow(/redan bokförd/i)

    vi.mocked(assessKontantmetodCutoff).mockResolvedValueOnce(assessed({
      plans: [], complete: true, collection: { paidBeforePosting: [] },
    }))
    await expect(stage()).rejects.toThrow(/Inga obetalda/i)
  })

  it('refuses a malformed acknowledgement list', async () => {
    await expect(stage({ acknowledge_filed_vat_periods: '2026-Q4' })).rejects.toThrow(/array of strings/)
  })

  // Feedback seq 798354: invoices settled with neither a payment row nor a
  // payment date are taken as settled on the balance date, which is an
  // assumption the approver must see before anything is booked.
  it('discloses invoices whose period-end state was assumed in the staged preview', async () => {
    vi.mocked(assessKontantmetodCutoff).mockResolvedValueOnce(assessed({
      collection: { undatedSettlements: ['F-7', 'L-3'] },
    }))
    const supabase = makeSupabase()
    const result = await stage({}, supabase)

    expect(result.preview).toMatchObject({
      undated_settlement_count: 2,
      undated_settlements_sample: ['F-7', 'L-3'],
      compliance_warning: expect.stringMatching(/^2 fakturor saknar betalningsdatum: .* per 2026-12-31 som i dag/),
    })
    expect(result.message).toMatch(/WARNING: 2 fakturor saknar betalningsdatum/)
    expect(supabase.inserts[0]).toMatchObject({
      preview_data: expect.objectContaining({
        compliance_warning: expect.stringContaining('saknar betalningsdatum'),
      }),
    })
  })

  it('names the assumption when it leaves nothing to post', async () => {
    vi.mocked(previewPaidBeforePostingCorrections).mockResolvedValueOnce({ corrections: [], refusals: [] })
    vi.mocked(assessKontantmetodCutoff).mockResolvedValueOnce(assessed({
      plans: [], complete: true, collection: { paidBeforePosting: [], undatedSettlements: ['F-1'] },
    }))
    await expect(stage()).rejects.toThrow(/Inga obetalda .*\. 1 faktura saknar betalningsdatum/)
  })

  it('refuses to stage before the fiscal period has ended', async () => {
    vi.setSystemTime(new Date('2026-12-01T12:00:00Z'))
    await expect(stage()).rejects.toThrow(/först efter periodens slut/i)
  })

  // Review of #3440: the ROT/RUT manual case had no door; the manual carry
  // posts through this tool and is linked like any carry.
  describe('manual_carries', () => {
    const rotOnly = () =>
      vi.mocked(assessKontantmetodCutoff).mockResolvedValueOnce(assessed({
        plans: [],
        collection: { paidBeforePosting: [], rotPartialManual: ['F-ROT'], rotPartialManualInvoices: [ROT_TARGET] },
      }))

    it('stages a manual carry for a ROT invoice the rule cannot carry', async () => {
      vi.mocked(previewPaidBeforePostingCorrections).mockResolvedValue({ corrections: [], refusals: [] })
      rotOnly()
      const supabase = makeSupabase()
      const result = await stage({ manual_carries: [{ invoice_id: 'inv-rot', lines: ROT_LINES }] }, supabase)
      expect(result.preview.entries).toEqual([expect.objectContaining({
        kind: 'manual_carry', invoice_id: 'inv-rot', mode: 'manual', entry_date: '2026-12-31', total: 4750,
        lines: ROT_LINES,
      })])
      expect(result.preview.manual).toMatchObject({ rot_partial: [] })
      expect(supabase.inserts[0]).toMatchObject({
        params: { manual_carries: [{ invoice_id: 'inv-rot', lines: ROT_LINES }] },
      })
    })

    it('fingerprints the manual lines', async () => {
      vi.mocked(previewPaidBeforePostingCorrections).mockResolvedValue({ corrections: [], refusals: [] })
      const fingerprintOf = async (lines: typeof ROT_LINES) => {
        rotOnly()
        const supabase = makeSupabase()
        await stage({ manual_carries: [{ invoice_id: 'inv-rot', lines }] }, supabase)
        return (supabase.inserts[0]!.params as Record<string, string>).preview_fingerprint
      }
      const base = await fingerprintOf(ROT_LINES)
      const other = await fingerprintOf([
        ROT_LINES[0]!,
        ROT_LINES[1]!,
        { account_number: '3001', debit_amount: 0, credit_amount: 5000 },
        { account_number: '3002', debit_amount: 0, credit_amount: 428.57 },
        ROT_LINES[3]!,
      ])
      expect(other).not.toBe(base)
    })

    it('refuses invalid manual lines, or an invoice not waiting for one, and stages nothing', async () => {
      rotOnly()
      const supabase = makeSupabase()
      await expect(stage({ manual_carries: [{ invoice_id: 'inv-rot', lines: ROT_LINES.slice(0, 3) }] }, supabase))
        .rejects.toMatchObject({ code: 'KONTANTMETOD_MANUAL_CARRY_INVALID' })
      rotOnly()
      await expect(stage({ manual_carries: [{ invoice_id: 'inv-1', lines: ROT_LINES }] }, supabase))
        .rejects.toMatchObject({ code: 'KONTANTMETOD_MANUAL_CARRY_INVALID' })
      rotOnly()
      await expect(stage({ manual_carries: [{ invoice_id: 'inv-rot', lines: [
        ROT_LINES[0]!,
        { account_number: '1513', debit_amount: 1000, credit_amount: 0 },
        { account_number: '3001', debit_amount: 0, credit_amount: 4600 },
        { account_number: '2611', debit_amount: 0, credit_amount: 1150 },
      ] }] }, supabase))
        .rejects.toMatchObject({ code: 'KONTANTMETOD_MANUAL_CARRY_DEDUCTION_MISMATCH' })
      expect(supabase.inserts).toHaveLength(0)
    })
  })

  // Review of #3440: a payment left for manual correction was dated in a VAT
  // period that may be filed; the user must learn it needs amending.
  it('names a filed VAT period holding a payment left for manual correction', async () => {
    vi.mocked(listVatFilings).mockResolvedValue([{
      ...filedQ4, period: 1, tax_period: '2027-01', period_type: 'monthly', year: 2027,
      period_start: '2027-01-01', period_end: '2027-01-31', filed_on: '2027-02-12',
    }])
    vi.mocked(assessKontantmetodCutoff).mockResolvedValueOnce(assessed({
      plans: [plan('inv-1')],
      collection: {
        paidBeforePosting: [],
        paidBeforePostingManual: [{
          side: 'customer', invoiceId: 'inv-9', reference: 'F-9', entryId: 'je-manual',
          entryDate: '2027-01-10', paymentRowId: 'p-9', reason: 'not_generated_cash_entry',
        }],
      },
    }))
    vi.mocked(previewPaidBeforePostingCorrections).mockResolvedValueOnce({ corrections: [], refusals: [] })
    const result = await stage()
    expect(result.preview).toMatchObject({
      amended_vat_periods_required: [expect.objectContaining({ tax_period: '2027-01' })],
    })
  })
})
