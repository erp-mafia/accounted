/**
 * gnubok_create_voucher dated on a locked date (crm#1923).
 *
 * The tool stages it (the person may unlock first), and used to answer with
 * period_status: locked in the envelope and a message that read like any
 * other: "call approve". The approval is then refused by the lock triggers.
 * The message now says the date is locked, that the proposal cannot be
 * approved as it stands, and the two ways on. Nothing about the lock is
 * stored on the proposal: the approval queue reads it when it lists the row.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const mockVoucherGuard = vi.hoisted(() => vi.fn())
vi.mock('@/lib/bookkeeping/voucher-warnings-guard', () => ({
  runVoucherWarningsGuard: (...args: unknown[]) => mockVoucherGuard(...args),
  recordVoucherWarningsAcknowledged: vi.fn(),
}))

const mockFindFiscalPeriod = vi.hoisted(() => vi.fn())
vi.mock('@/lib/bookkeeping/engine', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/engine')>('@/lib/bookkeeping/engine')
  return { ...actual, findFiscalPeriod: (...args: unknown[]) => mockFindFiscalPeriod(...args) }
})

vi.mock('@/lib/vat/voucher-vat-impact', () => ({
  previewVoucherVatDeclaration: vi.fn().mockResolvedValue({
    status: 'ok', vat_period: null, counted: true, excluded_as: null, rutor_change: {},
    summary: 'Påverkar ingen ruta i momsdeklarationen.',
  }),
}))

import { tools } from '../server'

const createVoucher = tools.find((t) => t.name === 'gnubok_create_voucher')!

const VOUCHER = {
  entry_date: '2026-10-05',
  description: 'Periodisering hyra',
  lines: [
    { account_number: '5010', debit_amount: 1000 },
    { account_number: '1930', credit_amount: 1000 },
  ],
}

type Staged = {
  staged: boolean
  message: string
  period_status?: { status: string; lock_date: string | null }
}

type Enqueue = (result: { data?: unknown; error?: unknown }) => void

/** The tool's reads up to the period check: the account gate over the two lines. */
function enqueueVoucherReads(enqueue: Enqueue) {
  enqueue({
    data: [
      { account_number: '5010', account_name: 'Lokalhyra', is_active: true },
      { account_number: '1930', account_name: 'Företagskonto', is_active: true },
    ],
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockVoucherGuard.mockResolvedValue({ ok: true, acknowledged: [] })
  mockFindFiscalPeriod.mockResolvedValue('fp-2026')
})

describe('gnubok_create_voucher: a date behind the company lock date', () => {
  it('stages, and the message says the date is locked, that approval is refused and what to do', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueueVoucherReads(enqueue)
    enqueue({ data: { bookkeeping_locked_through: '2026-10-31' } }) // period check: company lock date
    enqueue({ data: { id: 'fp-2026' } }) // period check: the year, for context
    enqueue({ data: { id: 'op-locked-1' } }) // pending_operations insert

    const result = (await createVoucher.execute(VOUCHER, 'company-1', 'user-1', supabase as never)) as Staged

    expect(result.staged).toBe(true)
    expect(result.period_status).toMatchObject({ status: 'locked', lock_date: '2026-10-31' })
    // Right after "Staged as ...", before the approval guidance it qualifies.
    expect(result.message).toMatch(
      /^Staged as pending_operation op-locked-1 \(risk: high\)\. PERIOD LOCKED: 2026-10-05 is on or before the company lock date \(bookkeeping is locked through 2026-10-31\)/,
    )
    expect(result.message).toContain('cannot be approved as it stands')
    expect(result.message).toContain('refused with PERIOD_LOCKED and nothing is booked')
    expect(result.message).toContain('stage it again with a date in an open period')
    expect(result.message).toContain('the user moves the lock date back first')

    // The lock is read when the queue lists the proposal, never stored with it:
    // a stored verdict would outlive an unlock.
    const [inserted] = findCall('pending_operations', 'insert') as [{ preview_data: Record<string, unknown>; params: { entry_date: string } }]
    expect(inserted.params.entry_date).toBe('2026-10-05')
    expect(inserted.preview_data).not.toHaveProperty('period_status')
    expect(inserted.preview_data.compliance_warning).not.toMatch(/PERIOD LOCKED/)
  })
})

describe('gnubok_create_voucher: an open date', () => {
  it('stages with the message it always had', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueVoucherReads(enqueue)
    enqueue({ data: { bookkeeping_locked_through: '2026-09-30' } })
    enqueue({ data: { id: 'fp-2026', is_closed: false, locked_at: null } })
    enqueue({ data: { id: 'op-open-1' } })

    const result = (await createVoucher.execute(VOUCHER, 'company-1', 'user-1', supabase as never)) as Staged

    expect(result.staged).toBe(true)
    expect(result.period_status).toMatchObject({ status: 'open' })
    expect(result.message).toMatch(/^Staged as pending_operation op-open-1 \(risk: high\)\. This is an irreversible posting/)
    expect(result.message).not.toMatch(/PERIOD (LOCKED|CLOSED)/)
  })
})
