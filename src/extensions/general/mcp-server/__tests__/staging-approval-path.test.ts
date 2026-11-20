/**
 * What a staging answer tells the agent about approval, and the identical
 * twin it leaves behind.
 *
 * A key without pending_operations:approve (the default one-click
 * connection) cannot approve here: the answer says so outright, with the link
 * for the user, and carries no approve hint for a tool the key does not have.
 * A key that can approve is not told it might not. A reversal staged again
 * with identical params replaces the older open card, which used to wait out
 * the 30-day expiry after its twin was approved.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

// The filed-momsperiod note (lib/pending-operations/filed-vat-note.ts),
// stubbed so the queued reads stay the tool's own: none by default.
const filedVat = vi.hoisted(() => ({ note: null as string | null, asked: [] as unknown[] }))
vi.mock('@/lib/pending-operations/filed-vat-note', () => ({
  stagedFiledVatNote: async (_supabase: unknown, _companyId: unknown, op: unknown) => {
    filedVat.asked.push(op)
    return filedVat.note
  },
}))
import type { ActorContext } from '../server'

import { tools } from '../server'

const reverseEntry = tools.find((t) => t.name === 'gnubok_reverse_journal_entry')!

const ENTRY_ID = '33333333-3333-4333-8333-333333333333'

const CONNECTOR: ActorContext = { type: 'api_key', id: 'key-1', label: 'Claude (Anthropic)' }

/** A reversal staged up to its insert: the original, its period and owner checks, staging's period check. */
function stageReversal() {
  const mock = createQueuedMockSupabase()
  mock.enqueue({
    data: {
      id: ENTRY_ID,
      status: 'posted',
      entry_date: '2026-09-09',
      description: 'Leverantörsfaktura 3744267',
      voucher_number: 2,
      voucher_series: 'D',
      fiscal_period_id: 'fp-1',
      correction_of_id: null,
      reverses_id: null,
      source_type: 'supplier_invoice_registered',
      source_id: 'si-1',
      fiscal_periods: { name: '2026', is_closed: false, locked_at: null },
      lines: [
        { account_number: '1710', debit_amount: 1000, credit_amount: 0, line_description: null },
        { account_number: '2440', debit_amount: 0, credit_amount: 1000, line_description: null },
      ],
    },
    error: null,
  })
  mock.enqueue({ data: { name: '2026', period_start: '2026-01-01', period_end: '2026-12-31' }, error: null })
  mock.enqueue({ data: { bookkeeping_locked_through: null }, error: null })
  mock.enqueue({ data: { id: 'fp-1', is_closed: false, locked_at: null }, error: null })
  mock.enqueue({ data: { id: 'si-1', supplier_invoice_number: '3744267', status: 'approved', credited_invoice_id: null }, error: null })
  mock.enqueue({ data: { bookkeeping_locked_through: null }, error: null })
  mock.enqueue({ data: { id: 'fp-1', is_closed: false, locked_at: null }, error: null })
  mock.enqueue({ data: { id: 'op-new' }, error: null }) // the insert
  const run = (actor: ActorContext) =>
    reverseEntry.execute({ entry_id: ENTRY_ID }, 'company-1', 'user-1', mock.supabase as never, actor) as Promise<
      Record<string, unknown>
    >
  return { ...mock, run }
}

beforeEach(() => {
  vi.clearAllMocks()
  filedVat.note = null
  filedVat.asked.length = 0
})

describe('staging answer: who approves', () => {
  it('tells a key without the approve scope to send the user to the app, with no approve hint', async () => {
    const s = stageReversal()

    const result = await s.run({ ...CONNECTOR, canApprove: false })

    expect(result.staged).toBe(true)
    expect(result.message).toContain('This connection cannot approve')
    expect(result.message).toContain('/pending')
    expect(result.message).not.toContain('If that tool is missing from your catalog')
    expect(result).not.toHaveProperty('approve')
  })

  it('tells a key with the approve scope to approve, without the conditional fallback', async () => {
    const s = stageReversal()

    const result = await s.run({ ...CONNECTOR, canApprove: true })

    expect(result.message).toContain('call gnubok_approve_pending_operation with operation_id="op-new" and confirmed=true')
    expect(result.message).not.toContain('If that tool is missing from your catalog')
    expect(result.approve).toEqual({
      tool: 'gnubok_approve_pending_operation',
      args: { operation_id: 'op-new', company_id: 'company-1' },
    })
  })

  it('keeps the conditional wording when the scopes are unknown', async () => {
    const s = stageReversal()

    const result = await s.run(CONNECTOR)

    expect(result.message).toContain('If that tool is missing from your catalog')
    expect(result).toHaveProperty('approve')
  })
})

describe('staging answer: an identical reversal already open', () => {
  it('replaces the older identical card through the reject path', async () => {
    const s = stageReversal()
    s.enqueue({ data: [{ id: 'op-older', params: { entry_id: ENTRY_ID } }], error: null }) // identical open twins
    s.enqueue({ data: [{ id: 'op-older', status: 'pending', operation_type: 'reverse_entry', risk_level: 'high' }], error: null }) // reject: read
    s.enqueue({ data: [{ id: 'op-older' }], error: null }) // reject: compare-and-set on pending

    const result = await s.run({ ...CONNECTOR, canApprove: true })

    expect(result).toMatchObject({ staged: true, operation_id: 'op-new', superseded_operation_ids: ['op-older'] })
    expect(result.message).toContain('replaces your identical earlier proposal(s) op-older')
    // Only this stager's open twins of the same type, never the new row itself.
    const eqs = s.findCalls('pending_operations', 'eq')
    expect(eqs).toContainEqual(['operation_type', 'reverse_entry'])
    expect(eqs).toContainEqual(['status', 'pending'])
    expect(eqs).toContainEqual(['actor_id', 'key-1'])
    expect(s.findCall('pending_operations', 'neq')).toEqual(['id', 'op-new'])
    expect(s.findCall('pending_operations', 'update')?.[0]).toMatchObject({
      status: 'rejected',
      rejection_category: 'superseded',
    })
  })

  it('leaves an open reversal with other params alone', async () => {
    const s = stageReversal()
    s.enqueue({ data: [{ id: 'op-older', params: { entry_id: ENTRY_ID, reversal_date: '2026-10-01' } }], error: null })

    const result = await s.run({ ...CONNECTOR, canApprove: true })

    expect(result).not.toHaveProperty('superseded_operation_ids')
    expect(s.findCalls('pending_operations', 'update')).toHaveLength(0)
  })
})

describe('staging answer: a proposal that changes a filed momsperiod', () => {
  const NOTE =
    'Momsdeklarationen för 2026-Q3 är redan inlämnad (2026-11-11), och makuleringen ändrar underlaget för den. ' +
    'Godkänns förslaget kan deklarationen behöva rättas.'

  it('tells the agent in the answer and the approver on the stored proposal', async () => {
    filedVat.note = NOTE
    const s = stageReversal()

    const result = await s.run({ ...CONNECTOR, canApprove: true })

    expect(result.staged).toBe(true)
    expect(result.message).toContain(`WARNING: ${NOTE}`)
    expect((result.preview as Record<string, unknown>).compliance_warning).toBe(NOTE)
    const [inserted] = s.findCall('pending_operations', 'insert') as [{ preview_data: Record<string, unknown> }]
    expect(inserted.preview_data.compliance_warning).toBe(NOTE)
  })

  it('is asked with the staged row: the type, the params and the preview the approver sees', async () => {
    const s = stageReversal()

    await s.run({ ...CONNECTOR, canApprove: true })

    expect(filedVat.asked).toHaveLength(1)
    expect(filedVat.asked[0]).toMatchObject({
      operation_type: 'reverse_entry',
      params: { entry_id: ENTRY_ID },
      // The storno's own date and mirrored lines: what the note judges.
      preview_data: {
        reversal: {
          entry_date: '2026-09-09',
          lines: [
            { account_number: '1710', debit_amount: 0, credit_amount: 1000 },
            { account_number: '2440', debit_amount: 1000, credit_amount: 0 },
          ],
        },
      },
    })
  })

  it('adds nothing to the answer or the proposal when the approval changes no filed period', async () => {
    const s = stageReversal()

    const result = await s.run({ ...CONNECTOR, canApprove: true })

    expect(result.message).not.toContain('WARNING')
    expect(result.preview).not.toHaveProperty('compliance_warning')
  })
})
