/**
 * vat-check-reviews.mark (crm#1171): an agent stages a person's review of a
 * momsdeklaration WARNING; approval writes it in the approver's name with
 * source 'agent', holding to the figures the preview fingerprinted.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createLogger } from '@/lib/logger'
import type { OperationContext } from '../types'

const service = vi.hoisted(() => ({ markVatCheckReviewed: vi.fn() }))
vi.mock('@/lib/vat/check-review-service', () => service)

import { vatCheckReviewsMark } from '../vat-check-reviews'

const ctx: OperationContext = {
  supabase: {} as never,
  companyId: 'company-1',
  userId: 'approver-1',
  log: createLogger('test'),
}

const input = {
  period_type: 'yearly' as const,
  year: 2026,
  period: 1,
  check_code: 'RC_BASIS_MISSING' as const,
  note: 'Basbeloppet för de 13 verifikaten är bokat i A61.',
}

const PREVIEW = {
  period: { type: 'yearly', start: '2025-10-19', end: '2026-09-30' },
  check_code: 'RC_BASIS_MISSING',
  message: '13 verifikationer i perioden har fiktiv moms...',
  fingerprint: 'v1:0123456789abcdef',
  current_review: null,
}

beforeEach(() => vi.clearAllMocks())

describe('vat-check-reviews.mark: contract', () => {
  it('is a low-risk bookkeeping:write that stages as mark_vat_check_reviewed, out of tools/list', () => {
    expect(vatCheckReviewsMark.kind).toBe('write')
    expect(vatCheckReviewsMark.scope).toBe('bookkeeping:write')
    expect(vatCheckReviewsMark.risk).toBe('low')
    expect(vatCheckReviewsMark.mcp?.name).toBe('gnubok_mark_vat_check_reviewed')
    expect(vatCheckReviewsMark.mcp?.visibility).toBeUndefined()
    expect(vatCheckReviewsMark.mcp?.stage?.pendingType).toBe('mark_vat_check_reviewed')
    expect(vatCheckReviewsMark.mcp?.stage?.title(input)).toBe(
      'Markera momsvarning RC_BASIS_MISSING som granskad för Helår 2026',
    )
    expect((vatCheckReviewsMark.mcp?.description ?? '').length).toBeLessThanOrEqual(280)
  })

  it('refuses an unknown code, a bad period and an overlong note (validation, 400)', () => {
    expect(vatCheckReviewsMark.input.safeParse({ ...input, check_code: 'WHATEVER' }).success).toBe(false)
    expect(vatCheckReviewsMark.input.safeParse({ ...input, period: 2 }).success).toBe(false)
    expect(vatCheckReviewsMark.input.safeParse({ ...input, note: 'x'.repeat(1001) }).success).toBe(false)
    expect(vatCheckReviewsMark.input.safeParse(input).success).toBe(true)
  })

  it('pins the previewed fingerprint so approval holds to the figures the approver saw', () => {
    const pinned = vatCheckReviewsMark.mcp?.stage?.pinParams?.(input, PREVIEW)
    expect(pinned).toEqual({ ...input, expected_fingerprint: 'v1:0123456789abcdef' })
    expect(vatCheckReviewsMark.input.safeParse(pinned).success).toBe(true)
  })
})

describe('vat-check-reviews.mark: run', () => {
  it('previews through the service on a dry run', async () => {
    service.markVatCheckReviewed.mockResolvedValue({ ok: true, dryRun: true, preview: PREVIEW })
    const outcome = await vatCheckReviewsMark.run(ctx, input, { dryRun: true })
    expect(outcome).toEqual({ ok: true, dryRun: true, preview: PREVIEW })
    expect(service.markVatCheckReviewed).toHaveBeenCalledWith({}, 'company-1', 'approver-1', expect.objectContaining({ source: 'agent' }), {
      dryRun: true,
    })
  })

  it('writes as the approver with source agent and the pinned fingerprint', async () => {
    const data = { ...PREVIEW, reviewed_at: 't', reviewed_by: 'approver-1', reviewed_by_label: null, note: input.note, source: 'agent', changed: true }
    service.markVatCheckReviewed.mockResolvedValue({ ok: true, data })
    const outcome = await vatCheckReviewsMark.run(ctx, { ...input, expected_fingerprint: 'v1:0123456789abcdef' }, { dryRun: false })
    expect(outcome).toEqual({ ok: true, data, created: true })
    expect(service.markVatCheckReviewed).toHaveBeenCalledWith(
      {},
      'company-1',
      'approver-1',
      {
        periodType: 'yearly',
        year: 2026,
        period: 1,
        fiscalPeriodId: undefined,
        checkCode: 'RC_BASIS_MISSING',
        note: input.note,
        expectedFingerprint: 'v1:0123456789abcdef',
        source: 'agent',
      },
      { dryRun: false },
    )
  })

  it('passes a refusal through as its code', async () => {
    service.markVatCheckReviewed.mockResolvedValue({ ok: false, code: 'VAT_CHECK_CHANGED' })
    expect(await vatCheckReviewsMark.run(ctx, input, { dryRun: false })).toEqual({ ok: false, code: 'VAT_CHECK_CHANGED' })
  })
})
