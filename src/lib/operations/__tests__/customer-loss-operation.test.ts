import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const doubtful = vi.fn()
const confirmed = vi.fn()
const recovered = vi.fn()
const loadState = vi.fn()
vi.mock('@/lib/customer-loss/doubtful', () => ({ recordDoubtfulLoss: (...a: unknown[]) => doubtful(...a) }))
vi.mock('@/lib/customer-loss/confirmed', () => ({ recordConfirmedLoss: (...a: unknown[]) => confirmed(...a) }))
vi.mock('@/lib/customer-loss/recovered', () => ({ recordRecoveredLoss: (...a: unknown[]) => recovered(...a) }))
vi.mock('@/lib/customer-loss/state', () => ({ loadCustomerLossState: (...a: unknown[]) => loadState(...a) }))
vi.mock('@/lib/customer-loss/view', () => ({ buildCustomerLossView: () => ({ menuVisible: true }) }))

import { TargetPeriodLockedError } from '@/lib/bookkeeping/errors'
import { invoicesRecordCustomerLoss } from '../customer-loss'
import type { OperationContext } from '../types'

const ctx = { supabase: {}, companyId: 'company-1', userId: 'user-1', log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as OperationContext
const INVOICE = '22222222-2222-4222-8222-222222222222'
const run = (input: Record<string, unknown>, dryRun = false) =>
  invoicesRecordCustomerLoss.run(ctx, invoicesRecordCustomerLoss.input.parse(input), { dryRun } as never)

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('CUSTOMER_LOSS_ENABLED', '1')
})
afterEach(() => vi.unstubAllEnvs())

describe('invoices.customer-loss.record', () => {
  it('refuses while CUSTOMER_LOSS_ENABLED is off', async () => {
    vi.stubEnv('CUSTOMER_LOSS_ENABLED', '')
    expect(await run({ invoice_id: INVOICE, kind: 'doubtful', reason: 'x' })).toEqual({ ok: false, code: 'CUSTOMER_LOSS_DISABLED' })
    expect(doubtful).not.toHaveBeenCalled()
  })

  it('previews without booking on a dry run', async () => {
    loadState.mockResolvedValue({ ok: true, state: {} })
    const outcome = await run({ invoice_id: INVOICE, kind: 'confirmed', reason: 'Konkurs' }, true)
    expect(outcome).toMatchObject({ ok: true, dryRun: true, preview: { kind: 'confirmed', menuVisible: true } })
    expect(confirmed).not.toHaveBeenCalled()
  })

  it('books through the service for the staging person', async () => {
    confirmed.mockResolvedValue({ ok: true, writeOffId: 'w', journalEntryId: 'je', invoiceStatus: 'written_off', amount: 1250 })
    const outcome = await run({
      invoice_id: INVOICE,
      kind: 'confirmed',
      reason: 'Konkurs',
      entry_date: '2026-06-30',
      evidence_document_id: '44444444-4444-4444-8444-444444444444',
    })
    expect(outcome).toEqual({
      ok: true,
      data: { write_off_id: 'w', journal_entry_id: 'je', invoice_status: 'written_off', amount: 1250 },
    })
    expect(confirmed).toHaveBeenCalledWith({}, 'company-1', 'user-1', {
      invoiceId: INVOICE,
      entryDate: '2026-06-30',
      reason: 'Konkurs',
      decidedBy: 'user-1',
      evidenceDocumentId: '44444444-4444-4444-8444-444444444444',
    })
  })

  it('needs an amount for a recovery and hands an engine refusal over as is', async () => {
    expect(await run({ invoice_id: INVOICE, kind: 'recovered', reason: 'x' })).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' })
    const locked = new TargetPeriodLockedError('2026-06-30', '2026-06-30')
    doubtful.mockRejectedValue(locked)
    expect(await run({ invoice_id: INVOICE, kind: 'doubtful', reason: 'x' })).toMatchObject({ ok: false, code: locked.code, error: locked })
  })
})
