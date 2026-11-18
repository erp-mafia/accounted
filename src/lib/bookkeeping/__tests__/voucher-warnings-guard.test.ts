/**
 * The confirm-before-posting guard's third source of warnings: the blocks'
 * own (../voucher-block-warnings.ts, wired in
 * lib/composition/voucher-block-warnings.ts). The plausibility and duplicate
 * halves have their own tests.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'

const block = vi.hoisted(() => ({ warn: vi.fn() }))
vi.mock('@/lib/composition/voucher-block-warnings', () => ({
  VOUCHER_BLOCK_WARNINGS: [{ id: 'vat-period-already-filed', module: 'vat', warn: block.warn }],
}))
vi.mock('../voucher-duplicate-check', () => ({ detectVoucherDuplicates: vi.fn().mockResolvedValue([]) }))

import { runVoucherWarningsGuard } from '../voucher-warnings-guard'

const supabase = {} as SupabaseClient
const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as Logger

const lines = [
  { account_number: '6540', debit_amount: 400, credit_amount: 0 },
  { account_number: '2641', debit_amount: 100, credit_amount: 0 },
  { account_number: '1930', debit_amount: 0, credit_amount: 500 },
]
const FILED = {
  code: 'VAT_PERIOD_ALREADY_FILED' as const,
  message_sv: 'Verifikationen ändrar momsen i en period som redan är deklarerad: 2026-Q3 (inlämnad 2026-11-11).',
  message_en: 'The voucher changes the VAT of a period already declared: 2026-Q3 (filed 2026-11-11).',
  details: { entry_date: '2026-09-27', filed_periods: [] },
}

beforeEach(() => {
  vi.clearAllMocks()
  block.warn.mockResolvedValue(null)
})

describe('runVoucherWarningsGuard: the blocks\' warnings', () => {
  it('refuses until a block\'s warning is confirmed, then passes it on as acknowledged', async () => {
    block.warn.mockResolvedValue(FILED)
    const input = { entry_date: '2026-09-27', description: 'Loopia', lines }

    const refused = await runVoucherWarningsGuard(supabase, 'c-1', input, log)
    expect(refused).toEqual({ ok: false, code: 'VOUCHER_NEEDS_CONFIRMATION', details: { warnings: [FILED] } })

    const confirmed = await runVoucherWarningsGuard(supabase, 'c-1', input, log, { acknowledged: ['VAT_PERIOD_ALREADY_FILED'] })
    expect(confirmed).toEqual({ ok: true, acknowledged: [FILED] })
  })

  it('asks the block about a new verifikat with its own date and no original', async () => {
    await runVoucherWarningsGuard(supabase, 'c-1', { entry_date: '2026-09-27', description: 'Loopia', lines }, log)

    expect(block.warn).toHaveBeenCalledWith(supabase, 'c-1', { entry_date: '2026-09-27', lines, replaces: null })
  })

  it('asks the block about a rättelse without its own date on its original\'s date', async () => {
    const replaces = { entry_date: '2026-09-27', lines }

    await runVoucherWarningsGuard(supabase, 'c-1', { entry_date: '', description: '', lines, replaces }, log, { checkDuplicates: false })

    expect(block.warn).toHaveBeenCalledWith(supabase, 'c-1', { entry_date: '2026-09-27', lines, replaces })
  })

  it('still asks the block when the door skips the duplicate half', async () => {
    block.warn.mockResolvedValue(FILED)

    const result = await runVoucherWarningsGuard(supabase, 'c-1', { entry_date: '2026-09-27', description: 'x', lines }, log, {
      checkDuplicates: false,
    })

    expect(result.ok).toBe(false)
  })

  it('never lets a block that cannot tell stop a booking', async () => {
    block.warn.mockRejectedValue(new Error('filing record unreadable'))

    const result = await runVoucherWarningsGuard(supabase, 'c-1', { entry_date: '2026-09-27', description: 'x', lines }, log)

    expect(result).toEqual({ ok: true, acknowledged: [] })
    expect(log.warn).toHaveBeenCalledWith(
      'voucher block warning vat-period-already-filed failed (continuing)',
      expect.any(Error),
    )
  })

  it('keeps a plausibility warning and a block warning as two things to confirm', async () => {
    block.warn.mockResolvedValue(FILED)
    // Reverse-charge output VAT with no input side: REVERSE_CHARGE_ONE_SIDED.
    const oneSided = [
      { account_number: '6540', debit_amount: 156.24, credit_amount: 0 },
      { account_number: '2614', debit_amount: 39.06, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: 195.3 },
    ]
    const input = { entry_date: '2026-09-27', description: 'x', lines: oneSided }

    const halfConfirmed = await runVoucherWarningsGuard(supabase, 'c-1', input, log, { acknowledged: ['REVERSE_CHARGE_ONE_SIDED'] })

    expect(halfConfirmed.ok).toBe(false)
    if (!halfConfirmed.ok) {
      expect(halfConfirmed.details.warnings.map((w) => w.code)).toEqual(['REVERSE_CHARGE_ONE_SIDED', 'VAT_PERIOD_ALREADY_FILED'])
    }
  })
})
