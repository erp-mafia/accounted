import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { VatDeclarationCheck } from '@/lib/reports/vat-declaration-checks'

const declarationModule = vi.hoisted(() => ({
  calculateVatDeclaration: vi.fn(),
  resolvePeriodDates: vi.fn(),
}))
vi.mock('@/lib/reports/vat-declaration', () => declarationModule)

const closeCheck = vi.hoisted(() => ({ vatFilingVerdict: vi.fn() }))
vi.mock('@/lib/reports/vat-close-check', () => closeCheck)

const store = vi.hoisted(() => ({
  listVatCheckReviews: vi.fn(),
  insertVatCheckReviewRow: vi.fn(),
}))
vi.mock('@/lib/vat/check-review-store', () => store)

import { markVatCheckReviewed, previewVatCheckReview, withdrawVatCheckReview } from '../check-review-service'
import { vatCheckFingerprint } from '../check-reviews'

const supabase = {} as never
const PERIOD = { type: 'yearly', year: 2026, period: 1, start: '2025-10-19', end: '2026-09-30' }
const DECLARATION = {
  period: PERIOD,
  rutor: { ruta22: 1200, ruta30: 300, ruta48: 300 },
  rcBasisByRate: { r25: 1200, r12: 0, r6: 0 },
}
const GAPS = [{ entryId: 'je-a9', rcOutputAccount: '2614', rcOutputAmount: 100, missingBasisAmount: 400 }]

const ADVISORY: VatDeclarationCheck = {
  code: 'RC_BASIS_MISSING',
  status: 'WARNING',
  message: '1 verifikation i perioden har fiktiv moms...',
  rutor: ['ruta20', 'ruta21', 'ruta22', 'ruta23', 'ruta24', 'ruta30', 'ruta31', 'ruta32'],
}
const BLOCKING: VatDeclarationCheck = { ...ADVISORY, status: 'ERROR' }
const FINGERPRINT = vatCheckFingerprint(ADVISORY, { declaration: DECLARATION as never, gaps: GAPS })

const TARGET = { periodType: 'yearly' as const, year: 2026, period: 1, checkCode: 'RC_BASIS_MISSING' }

function verdict(checks: VatDeclarationCheck[], gaps: unknown[] | null = GAPS) {
  closeCheck.vatFilingVerdict.mockResolvedValue({ checks, blocked: checks.some((c) => c.status === 'ERROR'), gaps })
}

beforeEach(() => {
  vi.clearAllMocks()
  declarationModule.calculateVatDeclaration.mockResolvedValue(DECLARATION)
  declarationModule.resolvePeriodDates.mockResolvedValue({ start: PERIOD.start, end: PERIOD.end, source: 'fiscal_period' })
  store.listVatCheckReviews.mockResolvedValue([])
  store.insertVatCheckReviewRow.mockResolvedValue({ created_at: '2026-10-15T09:00:00Z' })
  verdict([ADVISORY])
})

describe('markVatCheckReviewed', () => {
  it('recomputes the finding from the books and stores its fingerprint in the person\'s name', async () => {
    const result = await markVatCheckReviewed(supabase, 'company-1', 'user-1', {
      ...TARGET,
      fiscalPeriodId: 'fp-1',
      note: '  Basbeloppet är bokat i A61  ',
      source: 'web',
    })

    expect(declarationModule.calculateVatDeclaration).toHaveBeenCalledWith(supabase, 'company-1', 'yearly', 2026, 1, { fiscalPeriodId: 'fp-1' })
    expect(closeCheck.vatFilingVerdict).toHaveBeenCalledWith(supabase, 'company-1', DECLARATION, { fiscalPeriodId: 'fp-1' })
    expect(store.insertVatCheckReviewRow).toHaveBeenCalledWith(supabase, {
      companyId: 'company-1',
      period: { type: 'yearly', start: '2025-10-19', end: '2026-09-30' },
      checkCode: 'RC_BASIS_MISSING',
      action: 'reviewed',
      fingerprint: FINGERPRINT,
      note: 'Basbeloppet är bokat i A61',
      source: 'web',
      actor: 'user-1',
    })
    expect(result).toEqual({
      ok: true,
      data: expect.objectContaining({ fingerprint: FINGERPRINT, reviewed_by: 'user-1', source: 'web', changed: true }),
    })
  })

  it('refuses an ERROR, and a finding the period does not show, without writing', async () => {
    verdict([BLOCKING])
    expect(await markVatCheckReviewed(supabase, 'company-1', 'user-1', { ...TARGET, source: 'web' })).toEqual({
      ok: false,
      code: 'VAT_CHECK_NOT_REVIEWABLE',
    })
    verdict([])
    expect(await markVatCheckReviewed(supabase, 'company-1', 'user-1', { ...TARGET, source: 'web' })).toEqual({
      ok: false,
      code: 'VAT_CHECK_NOT_FOUND',
    })
    expect(store.insertVatCheckReviewRow).not.toHaveBeenCalled()
  })

  it('refuses the scan-unavailable warning: there was nothing to review', async () => {
    verdict([ADVISORY], null)
    expect(await markVatCheckReviewed(supabase, 'company-1', 'user-1', { ...TARGET, source: 'web' })).toEqual({
      ok: false,
      code: 'VAT_CHECK_NOT_REVIEWABLE',
    })
  })

  it('refuses figures that moved since the caller saw them', async () => {
    const result = await markVatCheckReviewed(supabase, 'company-1', 'user-1', {
      ...TARGET,
      expectedFingerprint: 'v1:ffffffffffffffff',
      source: 'agent',
    })
    expect(result).toEqual({ ok: false, code: 'VAT_CHECK_CHANGED' })
    expect(store.insertVatCheckReviewRow).not.toHaveBeenCalled()
  })

  it('answers a dry run with the finding and its fingerprint, writing nothing', async () => {
    const result = await markVatCheckReviewed(supabase, 'company-1', 'user-1', { ...TARGET, source: 'agent' }, { dryRun: true })
    expect(result).toEqual({
      ok: true,
      dryRun: true,
      preview: {
        period: { type: 'yearly', start: '2025-10-19', end: '2026-09-30' },
        check_code: 'RC_BASIS_MISSING',
        message: ADVISORY.message,
        fingerprint: FINGERPRINT,
        current_review: null,
      },
    })
    expect(store.insertVatCheckReviewRow).not.toHaveBeenCalled()
  })

  it('writes nothing when the same review is already in force, and a new row for a new note', async () => {
    store.listVatCheckReviews.mockResolvedValue([
      {
        check_code: 'RC_BASIS_MISSING',
        fingerprint: FINGERPRINT,
        reviewed_at: '2026-10-14T09:00:00Z',
        reviewed_by: 'user-2',
        note: 'A61',
        source: 'web',
      },
    ])
    const same = await markVatCheckReviewed(supabase, 'company-1', 'user-1', { ...TARGET, note: 'A61', source: 'agent' })
    expect(same).toEqual({ ok: true, data: expect.objectContaining({ changed: false, reviewed_by: 'user-2' }) })
    expect(store.insertVatCheckReviewRow).not.toHaveBeenCalled()

    const renoted = await markVatCheckReviewed(supabase, 'company-1', 'user-1', { ...TARGET, note: 'A61 och A62', source: 'agent' })
    expect(renoted).toEqual({ ok: true, data: expect.objectContaining({ changed: true, source: 'agent' }) })
    expect(store.insertVatCheckReviewRow).toHaveBeenCalledTimes(1)
  })

  it('treats a stored review of other figures as no review', async () => {
    store.listVatCheckReviews.mockResolvedValue([
      { check_code: 'RC_BASIS_MISSING', fingerprint: 'v1:0000000000000000', reviewed_at: 'x', reviewed_by: 'user-2', note: null, source: 'web' },
    ])
    const outcome = await previewVatCheckReview(supabase, 'company-1', TARGET)
    expect(outcome).toEqual({ ok: true, preview: expect.objectContaining({ current_review: null }) })
  })
})

describe('withdrawVatCheckReview', () => {
  it('appends a withdrawal for a review in force', async () => {
    store.listVatCheckReviews.mockResolvedValue([
      { check_code: 'RC_BASIS_MISSING', fingerprint: FINGERPRINT, reviewed_at: 'x', reviewed_by: 'user-1', note: null, source: 'web' },
    ])
    const result = await withdrawVatCheckReview(supabase, 'company-1', 'user-1', { ...TARGET, source: 'web' })
    expect(result).toEqual({
      ok: true,
      data: { period: { type: 'yearly', start: '2025-10-19', end: '2026-09-30' }, check_code: 'RC_BASIS_MISSING', withdrawn: true },
    })
    expect(store.insertVatCheckReviewRow).toHaveBeenCalledWith(supabase, expect.objectContaining({
      action: 'withdrawn',
      fingerprint: null,
      actor: 'user-1',
    }))
    // Keyed by the period's dates only: no recompute of the declaration.
    expect(declarationModule.calculateVatDeclaration).not.toHaveBeenCalled()
  })

  it('answers VAT_CHECK_REVIEW_NOT_FOUND when nothing is reviewed', async () => {
    expect(await withdrawVatCheckReview(supabase, 'company-1', 'user-1', { ...TARGET, source: 'web' })).toEqual({
      ok: false,
      code: 'VAT_CHECK_REVIEW_NOT_FOUND',
    })
    expect(store.insertVatCheckReviewRow).not.toHaveBeenCalled()
  })
})
