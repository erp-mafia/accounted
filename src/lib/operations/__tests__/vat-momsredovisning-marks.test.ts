/**
 * vat-momsredovisning-marks.mark/.withdraw (crm#1849): an agent stages the
 * Moms page's "rättelse, inte momsredovisning" mark or its withdrawal; the
 * approval runs the same service as the page, reading with the door's client
 * and writing through the server in the approver's name.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createLogger } from '@/lib/logger'
import type { OperationContext } from '../types'

const service = vi.hoisted(() => ({
  previewMomsredovisningMark: vi.fn(),
  markNotMomsredovisning: vi.fn(),
  withdrawNotMomsredovisning: vi.fn(),
}))
vi.mock('@/lib/vat/momsredovisning-marks', () => service)

const WRITER = vi.hoisted(() => ({ writer: true }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn(() => WRITER) }))

import { vatMomsredovisningMarksMark, vatMomsredovisningMarksWithdraw } from '../vat-momsredovisning-marks'
import { OPERATION_DOORS } from '@/lib/permissions/doors'
import { OPERATION_RISK_TIERS } from '@/lib/pending-operations/risk-tiers'

const SESSION = { session: true }
const ctx: OperationContext = {
  supabase: SESSION as never,
  companyId: 'company-1',
  userId: 'approver-1',
  log: createLogger('test'),
}

const ID = '33333333-3333-4333-8333-333333333333'
const input = { journal_entry_id: ID }

const PREVIEW = {
  journal_entry_id: ID,
  verifikat: 'A158',
  entry_date: '2026-09-30',
  description: 'Rättelse: Offentliga bidrag för personal',
  marked_now: false,
}

beforeEach(() => vi.clearAllMocks())

describe.each([
  ['mark', vatMomsredovisningMarksMark, 'gnubok_mark_not_momsredovisning', 'mark_not_momsredovisning', 'Räkna A158 som rättelse, inte momsredovisning'],
  ['withdraw', vatMomsredovisningMarksWithdraw, 'gnubok_withdraw_not_momsredovisning', 'withdraw_not_momsredovisning', 'Ta bort markeringen som rättelse på A158'],
] as const)('vat-momsredovisning-marks.%s: contract', (action, op, tool, pendingType, title) => {
  it('is a staged, medium-risk bookkeeping:write behind the tax door', () => {
    expect(op.kind).toBe('write')
    expect(op.scope).toBe('bookkeeping:write')
    expect(op.risk).toBe('medium')
    expect(op.reversible).toBe(true)
    expect(op.mcp?.name).toBe(tool)
    expect(op.mcp?.stage?.pendingType).toBe(pendingType)
    expect(OPERATION_RISK_TIERS[pendingType]).toBe('medium')
    expect(OPERATION_DOORS[op.id]).toEqual({ permission: 'tax.prepare', effect: 'ledger' })
    expect(op.mcp?.stage?.title(input, PREVIEW)).toBe(title)
    expect((op.mcp?.description ?? '').length).toBeLessThanOrEqual(280)
    expect(op.id).toBe(`vat-momsredovisning-marks.${action}`)
  })

  it('declares the refusals its door can answer', () => {
    expect(op.errorCodes).toEqual(expect.arrayContaining(['VAT_MARK_PERIOD_FILED', 'VAT_MARK_PERIOD_LOCKED', 'VAT_MARK_STORNO']))
    expect((op.errorCodes ?? []).includes('VAT_MARK_NOT_SHAPE')).toBe(action === 'mark')
    expect((op.errorCodes ?? []).includes('VAT_MARK_NOT_FOUND')).toBe(action === 'withdraw')
  })

  it('takes one verifikat id and nothing else (validation, 400)', () => {
    expect(op.input.safeParse(input).success).toBe(true)
    expect(op.input.safeParse({ journal_entry_id: 'A158' }).success).toBe(false)
    expect(op.input.safeParse({}).success).toBe(false)
  })

  it('shows the approver the verifikat under labelled keys', () => {
    const shown = op.mcp?.stage?.preview?.(input, PREVIEW)
    expect(shown).toEqual({
      voucher: 'A158',
      voucher_date: '2026-09-30',
      voucher_description: 'Rättelse: Offentliga bidrag för personal',
      already_in_state: action === 'withdraw',
    })
  })
})

describe('vat-momsredovisning-marks: run', () => {
  it('previews through the service on a dry run and writes nothing', async () => {
    service.previewMomsredovisningMark.mockResolvedValue({ ok: true, preview: PREVIEW })
    expect(await vatMomsredovisningMarksMark.run(ctx, input, { dryRun: true }))
      .toEqual({ ok: true, dryRun: true, preview: PREVIEW })
    expect(service.previewMomsredovisningMark).toHaveBeenCalledWith(SESSION, 'company-1', ID, 'mark')
    await vatMomsredovisningMarksWithdraw.run(ctx, input, { dryRun: true })
    expect(service.previewMomsredovisningMark).toHaveBeenLastCalledWith(SESSION, 'company-1', ID, 'withdraw')
    expect(service.markNotMomsredovisning).not.toHaveBeenCalled()
    expect(service.withdrawNotMomsredovisning).not.toHaveBeenCalled()
  })

  it('marks as the approver: reads with the door\'s client, writes through the server', async () => {
    const data = { journal_entry_id: ID, marked: true, changed: true }
    service.markNotMomsredovisning.mockResolvedValue({ ok: true, data })
    expect(await vatMomsredovisningMarksMark.run(ctx, input, { dryRun: false })).toEqual({ ok: true, data, created: true })
    expect(service.markNotMomsredovisning).toHaveBeenCalledWith(SESSION, WRITER, 'company-1', 'approver-1', ID)
  })

  it('withdraws as the approver', async () => {
    const data = { journal_entry_id: ID, marked: false, changed: true }
    service.withdrawNotMomsredovisning.mockResolvedValue({ ok: true, data })
    expect(await vatMomsredovisningMarksWithdraw.run(ctx, input, { dryRun: false })).toEqual({ ok: true, data, created: true })
    expect(service.withdrawNotMomsredovisning).toHaveBeenCalledWith(SESSION, WRITER, 'company-1', 'approver-1', ID)
  })

  it('answers an already-marked verifikat as unchanged', async () => {
    const data = { journal_entry_id: ID, marked: true, changed: false }
    service.markNotMomsredovisning.mockResolvedValue({ ok: true, data })
    expect(await vatMomsredovisningMarksMark.run(ctx, input, { dryRun: false })).toEqual({ ok: true, data, created: false })
  })

  it('passes a refusal through as its code, on the preview and the commit', async () => {
    service.previewMomsredovisningMark.mockResolvedValue({ ok: false, code: 'VAT_MARK_PERIOD_FILED' })
    expect(await vatMomsredovisningMarksMark.run(ctx, input, { dryRun: true })).toEqual({ ok: false, code: 'VAT_MARK_PERIOD_FILED' })
    service.withdrawNotMomsredovisning.mockResolvedValue({ ok: false, code: 'VAT_MARK_NOT_FOUND' })
    expect(await vatMomsredovisningMarksWithdraw.run(ctx, input, { dryRun: false })).toEqual({ ok: false, code: 'VAT_MARK_NOT_FOUND' })
  })
})
