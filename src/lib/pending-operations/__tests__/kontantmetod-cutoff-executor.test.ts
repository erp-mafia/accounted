import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingOperation } from '@/types'

vi.mock('@/lib/core/bookkeeping/kontantmetod-cutoff', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/core/bookkeeping/kontantmetod-cutoff')
  >('@/lib/core/bookkeeping/kontantmetod-cutoff')
  return {
    ...actual,
    assessKontantmetodCutoff: vi.fn(),
    postKontantmetodCutoff: vi.fn(),
    previewPaidBeforePostingCorrections: vi.fn(),
  }
})

// The pre-flight runs for real over these two reads (test plan section 8).
vi.mock('@/lib/api/v1/check-period-lock', () => ({ checkPeriodLock: vi.fn() }))
vi.mock('@/lib/vat/filing-record-store', () => ({ listVatFilings: vi.fn() }))

import { commitPendingOperation } from '../commit'
import {
  assessKontantmetodCutoff,
  buildCutoffLines,
  cutoffPreviewFingerprint,
  KontantmetodCutoffPartialError,
  postKontantmetodCutoff,
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

const paid: PaidBeforePosting = {
  side: 'customer', invoiceId: 'inv-2', reference: 'F-2', entryId: 'je-cash',
  entryDate: '2027-01-14', paymentRowId: 'pay-1', paymentAmount: 1250, carryEntryId: null,
}

const collection: CutoffCollection = {
  receivables: [],
  payables: [],
  unknownVatTreatment: [],
  strayVatOnZeroRate: [],
  undatedSettlements: [],
  carries: [],
  rotPartialManual: [],
  rotPartialManualInvoices: [],
  paidBeforePosting: [paid],
  paidBeforePostingManual: [],
  legacyCovered: [],
}

const lines = (receivable: number) => [
  { account_number: '1510', debit_amount: receivable, credit_amount: 0 },
  { account_number: '3001', debit_amount: 0, credit_amount: receivable * 0.8 },
  { account_number: '2611', debit_amount: 0, credit_amount: receivable * 0.2 },
]

/** The per-invoice carries the default assessment plans (#3440). */
const plan = (invoiceId: string): KontantmetodCarryPlan => ({
  side: 'customer',
  invoiceId,
  reference: invoiceId.toUpperCase(),
  creditNote: false,
  mode: 'full',
  description: `Kundfaktura ${invoiceId.toUpperCase()}: obetald vid bokslut (kontantmetoden)`,
  notes: `Årsomföring kontantmetoden, BFL 5 kap 2 §, faktura ${invoiceId.toUpperCase()}`,
  lines: lines(1250),
  total: 1250,
})

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

const OPEN_POSTINGS = {
  complete: false, hasAny: false, receivableEntryId: null,
  receivableReversalId: null, payableEntryId: null, payableReversalId: null,
  missing: [], duplicates: [],
}

/** A per-invoice assessment: the shape assessKontantmetodCutoff returns. */
function assessed(
  over: Partial<KontantmetodCutoffAssessment> = {},
): KontantmetodCutoffAssessment {
  return {
    mode: 'per_invoice',
    collection,
    plans: [plan('inv-1'), plan('inv-2')],
    lines: buildCutoffLines([], [], 'aktiebolag'),
    postings: OPEN_POSTINGS,
    complete: false,
    legacyCutoffs: [],
    ...over,
  }
}

function fingerprint(over: {
  corrections?: PaidBeforePostingCorrectionPreview[]
  acknowledgedFiledVatPeriods?: string[]
  acknowledgedLegacyInvoiceIds?: string[]
} = {}) {
  return cutoffPreviewFingerprint({
    collection,
    lines: buildCutoffLines([], [], 'aktiebolag'),
    entityType: 'aktiebolag',
    periodEnd: '2026-12-31',
    plans: [plan('inv-1'), plan('inv-2')],
    corrections: over.corrections ?? [correction],
    correctionRefusals: [],
    acknowledgedFiledVatPeriods: over.acknowledgedFiledVatPeriods,
    acknowledgedLegacyInvoiceIds: over.acknowledgedLegacyInvoiceIds,
  })
}

function makePendingOp(params: Record<string, unknown> = {}): PendingOperation {
  return {
    id: 'op-1', user_id: 'user-1', company_id: 'company-1',
    operation_type: 'post_kontantmetod_cutoff', status: 'pending', title: 'cut-off',
    params: {
      fiscal_period_id: 'fp-1',
      period_end: '2026-12-31',
      entity_type: 'aktiebolag',
      acknowledge_filed_vat_periods: [],
      acknowledge_legacy_invoice_ids: [],
      preview_fingerprint: fingerprint(),
      ...params,
    },
    preview_data: {}, result_data: null, actor_type: 'api_key', actor_id: null,
    actor_label: null, risk_level: 'high', created_at: '2026-08-13T00:00:00Z',
    resolved_at: null, updated_at: '2026-08-13T00:00:00Z',
  } as unknown as PendingOperation
}

function makeSupabase(options: { period?: unknown; settings?: unknown } = {}) {
  const period = Object.prototype.hasOwnProperty.call(options, 'period')
    ? options.period
    : {
        id: 'fp-1', period_start: '2026-01-01', period_end: '2026-12-31',
        is_closed: false, locked_at: null,
      }
  const settings = options.settings ?? { accounting_method: 'cash', entity_type: 'aktiebolag' }
  const updates: Array<{ table: string; value: unknown }> = []
  const from = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {}
    for (const name of ['select', 'eq', 'in', 'order', 'limit']) chain[name] = () => chain
    chain.update = (value: unknown) => {
      updates.push({ table, value })
      return chain
    }
    const response = () => {
      if (table === 'pending_operations') return { data: { id: 'op-1' }, error: null }
      if (table === 'company_settings') return { data: settings, error: null }
      if (table === 'fiscal_periods') return { data: period, error: null }
      return { data: null, error: null }
    }
    chain.maybeSingle = async () => response()
    chain.single = async () => response()
    chain.then = (resolve: (value: unknown) => unknown) => resolve(response())
    return chain
  })
  return { auth: {}, from, updates }
}

const filedQ4: VatFilingRecord = {
  deadline_id: 'dl-1', period_type: 'quarterly', year: 2026, period: 4, tax_period: '2026-Q4',
  period_start: '2026-10-01', period_end: '2026-12-31', filed_on: '2027-02-12',
  source: 'manual', reference: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2027-02-20T12:00:00Z'))
  vi.mocked(assessKontantmetodCutoff).mockResolvedValue(assessed())
  vi.mocked(previewPaidBeforePostingCorrections).mockResolvedValue({ corrections: [correction], refusals: [] })
  vi.mocked(checkPeriodLock).mockResolvedValue({ locked: false, fiscal_period_id: 'fp-x' })
  vi.mocked(listVatFilings).mockResolvedValue([])
  vi.mocked(postKontantmetodCutoff).mockResolvedValue({
    posted: [
      { side: 'customer', invoiceId: 'inv-1', reference: 'INV-1', entryId: 'je-1' },
      { side: 'customer', invoiceId: 'inv-2', reference: 'INV-2', entryId: 'je-2' },
    ],
    compensated: [],
    corrected: [{
      side: 'customer', invoiceId: 'inv-2', reference: 'F-2', entryId: 'je-cash',
      stornoEntryId: 'storno-1', correctionEntryId: 'k-1',
    }],
    correctionFailed: [],
    remaining: 0,
  })
})

afterEach(() => {
  vi.useRealTimers()
})

const commit = (op = makePendingOp(), supabase = makeSupabase()) =>
  commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

describe('commitPendingOperation: post_kontantmetod_cutoff', () => {
  it('re-assesses, checks the pre-flight and posts the carries and corrections (happy path)', async () => {
    const result = await commit()

    expect(result.status).toBe('committed')
    expect(result.data).toEqual({
      posted: [
        { side: 'customer', invoice_id: 'inv-1', reference: 'INV-1', journal_entry_id: 'je-1' },
        { side: 'customer', invoice_id: 'inv-2', reference: 'INV-2', journal_entry_id: 'je-2' },
      ],
      compensated: [],
      corrected: [{
        side: 'customer', invoice_id: 'inv-2', reference: 'F-2', cash_entry_id: 'je-cash',
        storno_entry_id: 'storno-1', correction_entry_id: 'k-1',
      }],
      correction_failed: [],
      manual_corrections: [],
      amended_vat_periods_required: [],
      remaining: 0,
    })
    // No next fiscal period is read or required: there is no vändning.
    expect(assessKontantmetodCutoff).toHaveBeenCalledWith(
      expect.anything(), 'company-1', expect.objectContaining({ id: 'fp-1' }), null, 'aktiebolag',
      { acknowledgedLegacyInvoiceIds: [] },
    )
    expect(postKontantmetodCutoff).toHaveBeenCalledWith(
      expect.anything(), 'company-1', 'user-1',
      expect.objectContaining({
        fiscalPeriodId: 'fp-1', periodEnd: '2026-12-31',
        plans: [plan('inv-1'), plan('inv-2')], paidBeforePosting: [paid],
      }),
    )
    // Both write dates were checked: the carries' and the correction's.
    expect(vi.mocked(checkPeriodLock).mock.calls.map((c) => c[2])).toEqual(['2026-12-31', '2027-01-14'])
  })

  it('answers 400 for malformed staged parameters', async () => {
    await expect(commit(makePendingOp({ preview_fingerprint: undefined })))
      .resolves.toMatchObject({ status: 'failed', http_status: 400 })
    await expect(commit(makePendingOp({ acknowledge_filed_vat_periods: '2026-Q4' })))
      .resolves.toMatchObject({ status: 'failed', http_status: 400 })
    expect(postKontantmetodCutoff).not.toHaveBeenCalled()
  })

  it('answers 404 for a fiscal period that does not exist', async () => {
    await expect(commit(makePendingOp(), makeSupabase({ period: null })))
      .resolves.toMatchObject({ status: 'rejected', http_status: 404 })
  })

  it('rejects when the reskontra, the corrections or the acknowledgements changed after staging', async () => {
    vi.mocked(assessKontantmetodCutoff).mockResolvedValueOnce(assessed({
      plans: [{ ...plan('inv-1'), lines: lines(1300), total: 1300 }, plan('inv-2')],
    }))
    await expect(commit()).resolves.toMatchObject({ status: 'rejected', http_status: 409 })

    vi.mocked(previewPaidBeforePostingCorrections).mockResolvedValueOnce({
      corrections: [{ ...correction, correctedLines: [
        { account_number: '1930', debit_amount: 1240, credit_amount: 0 },
        { account_number: '1510', debit_amount: 0, credit_amount: 1240 },
      ] }],
      refusals: [],
    })
    await expect(commit()).resolves.toMatchObject({ status: 'rejected', http_status: 409 })

    // Staged with an acknowledgement the params no longer carry.
    await expect(commit(makePendingOp({
      preview_fingerprint: fingerprint({ acknowledgedFiledVatPeriods: ['2026-Q4'] }),
    }))).resolves.toMatchObject({ status: 'rejected', http_status: 409 })
    expect(postKontantmetodCutoff).not.toHaveBeenCalled()
  })

  it('refuses with KONTANTMETOD_CUTOFF_PERIOD_LOCKED for a locked period end', async () => {
    vi.mocked(checkPeriodLock).mockImplementation(async (_s, _c, date) =>
      date === '2026-12-31'
        ? { locked: true, reason: 'company_lock_date_covers' }
        : { locked: false })
    const result = await commit()
    expect(result).toMatchObject({ status: 'rejected', http_status: 409, code: 'KONTANTMETOD_CUTOFF_PERIOD_LOCKED' })
    expect(result.error).toContain('2026-12-31')
    expect(postKontantmetodCutoff).not.toHaveBeenCalled()
  })

  it('refuses with KONTANTMETOD_CUTOFF_PERIOD_LOCKED for a locked correction date', async () => {
    vi.mocked(checkPeriodLock).mockImplementation(async (_s, _c, date) =>
      date === '2027-01-14' ? { locked: true, reason: 'period_locked_at_set', fiscal_period_id: 'fp-2' } : { locked: false })
    const result = await commit()
    expect(result).toMatchObject({ status: 'rejected', code: 'KONTANTMETOD_CUTOFF_PERIOD_LOCKED' })
    expect(result.error).toContain('2027-01-14')
    expect(postKontantmetodCutoff).not.toHaveBeenCalled()
  })

  it('refuses a filed VAT period, and posts once it is acknowledged, listing the rättad deklaration', async () => {
    vi.mocked(listVatFilings).mockResolvedValue([filedQ4])
    const refused = await commit()
    expect(refused).toMatchObject({ status: 'rejected', http_status: 409, code: 'KONTANTMETOD_CUTOFF_VAT_PERIOD_FILED' })
    expect(refused.error).toContain('2026-Q4')
    expect(postKontantmetodCutoff).not.toHaveBeenCalled()

    const acknowledged = await commit(makePendingOp({
      acknowledge_filed_vat_periods: ['2026-Q4'],
      preview_fingerprint: fingerprint({ acknowledgedFiledVatPeriods: ['2026-Q4'] }),
    }))
    expect(acknowledged.status).toBe('committed')
    expect(acknowledged.data).toMatchObject({
      amended_vat_periods_required: [{
        tax_period: '2026-Q4', period_start: '2026-10-01', period_end: '2026-12-31', filed_on: '2027-02-12',
      }],
    })
  })

  it('carries acknowledged legacy-covered invoices through to the assessment', async () => {
    const result = await commit(makePendingOp({
      acknowledge_legacy_invoice_ids: ['inv-old'],
      preview_fingerprint: fingerprint({ acknowledgedLegacyInvoiceIds: ['inv-old'] }),
    }))
    expect(result.status).toBe('committed')
    expect(assessKontantmetodCutoff).toHaveBeenCalledWith(
      expect.anything(), 'company-1', expect.anything(), null, 'aktiebolag',
      { acknowledgedLegacyInvoiceIds: ['inv-old'] },
    )
  })

  it('posts nothing for a legacy period, a complete one, or one left with only manual items', async () => {
    vi.mocked(assessKontantmetodCutoff).mockResolvedValueOnce(assessed({ mode: 'legacy', plans: [] }))
    await expect(commit()).resolves.toMatchObject({ status: 'rejected', http_status: 409 })

    vi.mocked(assessKontantmetodCutoff).mockResolvedValueOnce(assessed({
      plans: [], complete: true, collection: { ...collection, paidBeforePosting: [] },
    }))
    await expect(commit()).resolves.toMatchObject({ status: 'rejected', http_status: 409 })

    vi.mocked(assessKontantmetodCutoff).mockResolvedValueOnce(assessed({
      plans: [], collection: { ...collection, paidBeforePosting: [], rotPartialManual: ['F-9'] },
    }))
    const manual = await commit()
    expect(manual).toMatchObject({ status: 'rejected', http_status: 409 })
    expect(manual.error).toMatch(/manuellt/)
    expect(postKontantmetodCutoff).not.toHaveBeenCalled()
  })

  it('rejects a locked period, the wrong accounting method and preview-affecting drift', async () => {
    await expect(commit(makePendingOp(), makeSupabase({
      period: { id: 'fp-1', period_end: '2026-12-31', locked_at: 'x', is_closed: false },
    }))).resolves.toMatchObject({ status: 'rejected', http_status: 409 })
    await expect(commit(makePendingOp(), makeSupabase({ settings: { accounting_method: 'accrual', entity_type: 'aktiebolag' } })))
      .resolves.toMatchObject({ status: 'rejected', http_status: 409 })
    await expect(commit(makePendingOp(), makeSupabase({ settings: { accounting_method: 'cash', entity_type: 'enskild_firma' } })))
      .resolves.toMatchObject({ status: 'rejected', http_status: 409 })
    expect(postKontantmetodCutoff).not.toHaveBeenCalled()
  })

  it('refuses a future-dated cut-off even when it was staged earlier', async () => {
    vi.setSystemTime(new Date('2026-12-01T12:00:00Z'))
    await expect(commit()).resolves.toMatchObject({ status: 'rejected', http_status: 409 })
    expect(postKontantmetodCutoff).not.toHaveBeenCalled()
  })

  it('reports a failed correction without failing the operation', async () => {
    vi.mocked(postKontantmetodCutoff).mockResolvedValueOnce({
      posted: [{ side: 'customer', invoiceId: 'inv-2', reference: 'INV-2', entryId: 'je-2' }],
      compensated: [],
      corrected: [],
      correctionFailed: [{
        side: 'customer', invoiceId: 'inv-2', reference: 'F-2', entryId: 'je-cash', code: 'PERIOD_LOCKED', message: 'låst',
      }],
      remaining: 0,
    })
    const result = await commit()
    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({
      correction_failed: [{ invoice_id: 'inv-2', cash_entry_id: 'je-cash', code: 'PERIOD_LOCKED', message: 'låst' }],
    })
  })

  it('marks immutable partial work as failed_partial with posted ids', async () => {
    vi.mocked(postKontantmetodCutoff).mockRejectedValueOnce(
      new KontantmetodCutoffPartialError(
        'carry run stopped',
        { carry_inv_1: 'ar', carry_inv_2: 'ar-2' },
        new Error('period locked'),
      ),
    )
    const supabase = makeSupabase()
    const result = await commit(makePendingOp(), supabase)
    expect(result).toMatchObject({
      status: 'failed',
      http_status: 500,
      code: 'partial_commit',
      data: {
        posted_ids: { carry_inv_1: 'ar', carry_inv_2: 'ar-2' },
      },
    })
    expect(supabase.updates).toContainEqual({
      table: 'pending_operations',
      value: expect.objectContaining({
        status: 'failed_partial',
        result_data: expect.objectContaining({
          posted_ids: { carry_inv_1: 'ar', carry_inv_2: 'ar-2' },
        }),
      }),
    })
  })

  // Review of #3440: the manual carry of a ROT/RUT invoice is re-checked at
  // approval against the same assessment and fingerprint, then posted and
  // linked with the rule-built carries.
  describe('manual carries', () => {
    const rotTarget = {
      invoiceId: 'inv-rot', reference: 'F-ROT', creditNote: false, openCustomerShareSek: 4750, openDeductionSek: 2035.71,
      openPartHasVat: true,
    }
    const rotLines = [
      { account_number: '1510', debit_amount: 4750, credit_amount: 0 },
      { account_number: '1513', debit_amount: 2035.71, credit_amount: 0 },
      { account_number: '3001', debit_amount: 0, credit_amount: 5428.57 },
      { account_number: '2611', debit_amount: 0, credit_amount: 1357.14 },
    ]
    const rotCollection = { ...collection, rotPartialManual: ['F-ROT'], rotPartialManualInvoices: [rotTarget] }
    const manualPlan: KontantmetodCarryPlan = {
      side: 'customer', invoiceId: 'inv-rot', reference: 'F-ROT', creditNote: false, mode: 'manual',
      description: 'Kundfaktura F-ROT: obetald vid bokslut (kontantmetoden)',
      notes: 'Manuell årsomföring kontantmetoden, BFL 5 kap 2 §, faktura F-ROT',
      lines: rotLines, total: 4750,
    }
    const rotFingerprint = (lines = rotLines) => cutoffPreviewFingerprint({
      collection: rotCollection,
      lines: buildCutoffLines([], [], 'aktiebolag'),
      entityType: 'aktiebolag',
      periodEnd: '2026-12-31',
      plans: [plan('inv-1'), plan('inv-2'), { ...manualPlan, lines }],
      corrections: [correction],
      correctionRefusals: [],
    })

    it('posts the manual carry with the rule-built ones', async () => {
      vi.mocked(assessKontantmetodCutoff).mockResolvedValue(assessed({ collection: rotCollection }))
      const result = await commit(makePendingOp({
        manual_carries: [{ invoice_id: 'inv-rot', lines: rotLines }],
        preview_fingerprint: rotFingerprint(),
      }))
      expect(result.status).toBe('committed')
      expect(postKontantmetodCutoff).toHaveBeenCalledWith(
        expect.anything(), 'company-1', 'user-1',
        expect.objectContaining({ plans: [plan('inv-1'), plan('inv-2'), manualPlan] }),
      )
    })

    it('refuses when the manual lines no longer match what was approved', async () => {
      vi.mocked(assessKontantmetodCutoff).mockResolvedValue(assessed({ collection: rotCollection }))
      const result = await commit(makePendingOp({
        manual_carries: [{ invoice_id: 'inv-rot', lines: rotLines }],
        preview_fingerprint: rotFingerprint([
          rotLines[0]!,
          { account_number: '3001', debit_amount: 0, credit_amount: 3800 },
          { account_number: '2611', debit_amount: 0, credit_amount: 950 },
        ]),
      }))
      expect(result.status).not.toBe('committed')
      expect(postKontantmetodCutoff).not.toHaveBeenCalled()
    })

    // Review of #3440: less than Skatteverket's open share on 1513 left the
    // year-2 payout clearing 1513 with no moms. Re-checked at approval too.
    it('refuses at approval a manual carry whose 1513 is not exactly the open share', async () => {
      vi.mocked(assessKontantmetodCutoff).mockResolvedValue(assessed({ collection: rotCollection }))
      const short = [
        rotLines[0]!,
        { account_number: '1513', debit_amount: 1000, credit_amount: 0 },
        { account_number: '3001', debit_amount: 0, credit_amount: 4600 },
        { account_number: '2611', debit_amount: 0, credit_amount: 1150 },
      ]
      const result = await commit(makePendingOp({
        manual_carries: [{ invoice_id: 'inv-rot', lines: short }],
        preview_fingerprint: rotFingerprint(short),
      }))
      expect(result).toMatchObject({
        status: 'rejected', http_status: 409, code: 'KONTANTMETOD_MANUAL_CARRY_DEDUCTION_MISMATCH',
      })
      expect(postKontantmetodCutoff).not.toHaveBeenCalled()
    })

    it('refuses a manual carry whose invoice is no longer waiting for one', async () => {
      const result = await commit(makePendingOp({
        manual_carries: [{ invoice_id: 'inv-rot', lines: rotLines }],
        preview_fingerprint: rotFingerprint(),
      }))
      expect(result).toMatchObject({ status: 'rejected', http_status: 409, code: 'KONTANTMETOD_MANUAL_CARRY_INVALID' })
      expect(postKontantmetodCutoff).not.toHaveBeenCalled()
    })
  })
})
