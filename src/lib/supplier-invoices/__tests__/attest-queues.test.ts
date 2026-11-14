import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import { NO_ATTEST_POLICY, type AttestPolicy } from '../attest-policy'
import { attestQueueOf, loadAttestQueues, loadToPayQueue, paymentOrderReadChunks, type AttestQueueInvoice } from '../attest-queues'

const POLICY: AttestPolicy = { ...NO_ATTEST_POLICY, enabled: true, attesters: ['kim'] }

const invoice = (overrides: Partial<AttestQueueInvoice> = {}): AttestQueueInvoice => ({
  id: 'inv-1',
  company_id: 'c1',
  user_id: 'alex',
  status: 'registered',
  approved_at: null,
  due_date: '2026-11-19',
  remaining_amount: 11250,
  auto_debit: false,
  is_credit_note: false,
  currency: 'SEK',
  total: 11250,
  total_sek: null,
  exchange_rate: null,
  ...overrides,
})

describe('attestQueueOf', () => {
  it('waits for attest until attested, then is ready to pay', () => {
    expect(attestQueueOf(POLICY, 'accrual', invoice(), false)).toBe('waiting')
    expect(attestQueueOf(POLICY, 'accrual', invoice({ status: 'approved', approved_at: '2026-10-31T10:00:00Z' }), false)).toBe('ready')
    // An attested invoice that has fallen due stays the payer's to pay.
    expect(attestQueueOf(POLICY, 'accrual', invoice({ status: 'overdue', approved_at: '2026-10-31T10:00:00Z', due_date: '2026-09-15' }), false)).toBe('ready')
  })

  it('has no queues where no policy governs (no policy, kontantmetoden), and none for a credit note', () => {
    expect(attestQueueOf(NO_ATTEST_POLICY, 'accrual', invoice(), false)).toBeNull()
    expect(attestQueueOf(POLICY, 'cash', invoice(), false)).toBeNull()
    expect(attestQueueOf(POLICY, 'accrual', invoice({ is_credit_note: true }), false)).toBeNull()
  })

  it('counts an invoice under the threshold as ready, attested or not: the policy does not hold it, and Att göra counts it', () => {
    expect(attestQueueOf({ ...POLICY, threshold_amount: 20000 }, 'accrual', invoice(), false)).toBe('ready')
    expect(attestQueueOf({ ...POLICY, threshold_amount: 20000 }, 'accrual', invoice({ approved_at: '2026-10-31T10:00:00Z', status: 'approved' }), false)).toBe('ready')
  })

  it('is no longer the payer\'s to pay once settled, at the bank, or debited by the supplier itself', () => {
    const attested = { status: 'approved', approved_at: '2026-10-31T10:00:00Z' }
    expect(attestQueueOf(POLICY, 'accrual', invoice({ ...attested, status: 'paid', remaining_amount: 0 }), false)).toBeNull()
    expect(attestQueueOf(POLICY, 'accrual', invoice({ ...attested, remaining_amount: 0.004 }), false)).toBeNull()
    expect(attestQueueOf(POLICY, 'accrual', invoice(attested), true)).toBeNull()
    expect(attestQueueOf(POLICY, 'accrual', invoice({ ...attested, auto_debit: true }), false)).toBeNull()
  })

  it('keeps a part-paid attested invoice ready: the payment file pays the rest (PAYABLE_SUPPLIER_INVOICE_STATUSES)', () => {
    // 10 000 kr attested, 4 000 kr matched: 6 000 kr still to pay.
    const partPaid = invoice({ status: 'partially_paid', approved_at: '2026-10-31T10:00:00Z', total: 10000, remaining_amount: 6000 })
    expect(attestQueueOf(POLICY, 'accrual', partPaid, false)).toBe('ready')
    // Unattested and part paid cannot be attested any more (canApproveSupplierInvoice): it waits on nobody.
    expect(attestQueueOf(POLICY, 'accrual', { ...partPaid, approved_at: null }, false)).toBeNull()
  })
})

describe('paymentOrderReadChunks', () => {
  it('fills each read to the cap, one company\'s invoices spanning reads when they must', () => {
    const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`)
    const reads = paymentOrderReadChunks(new Map([['a', ids('a', 100)], ['b', ids('b', 100)], ['c', ids('c', 100)]]))
    expect(reads.map((r) => r.companyIds.length + r.invoiceIds.length)).toEqual([150, 53 + 97, 5])
    expect(reads.map((r) => r.companyIds)).toEqual([['a', 'b'], ['b', 'c'], ['c']])
    expect(reads.flatMap((r) => r.invoiceIds)).toHaveLength(300)
    expect(paymentOrderReadChunks(new Map())).toEqual([])
  })
})

describe('loadAttestQueues', () => {
  const attested = '2026-10-31T10:00:00Z'

  function seed() {
    const mock = createTableMockSupabase()
    // c1 attests (Alex's client), c2 has its policy off (not returned by the enabled filter), c3 keeps kontantmetoden.
    mock.setTable('company_attest_policies', {
      data: [
        { company_id: 'c1', enabled: true, threshold_amount: null, mode: 'any', attesters: ['kim'], preparer_may_attest: false, updated_by: null, updated_at: null },
        { company_id: 'c3', enabled: true, threshold_amount: null, mode: 'any', attesters: ['x'], preparer_may_attest: false, updated_by: null, updated_at: null },
      ],
    })
    mock.setTable('company_settings', {
      data: [
        { company_id: 'c1', accounting_method: 'accrual' },
        { company_id: 'c3', accounting_method: 'cash' },
      ],
    })
    mock.setTable('supplier_invoices', {
      data: [
        // Two Möbelfirman AB invoices due 15 Sep, not attested: waiting, both fallen due on 31 Oct.
        invoice({ id: 'mf-1', due_date: '2026-09-15', status: 'overdue', total: 29625, remaining_amount: 29625 }),
        invoice({ id: 'mf-2', due_date: '2026-09-15', status: 'overdue', total: 24375, remaining_amount: 24375 }),
        // Konsult due 19 Nov, attested: ready to pay.
        invoice({ id: 'kb', status: 'approved', approved_at: attested }),
        // Attested and already at the bank: nobody's to pay.
        invoice({ id: 'at-bank', status: 'approved', approved_at: attested, due_date: '2026-11-02' }),
        // Attested, 4 000 of 10 000 kr matched: the rest is still to pay.
        invoice({ id: 'part-paid', status: 'partially_paid', approved_at: attested, due_date: '2026-11-25', total: 10000, remaining_amount: 6000 }),
        // Attested, and the bank refused its newest payment: still to pay, its own Att göra row.
        invoice({ id: 'refused', status: 'approved', approved_at: attested, due_date: '2026-11-20' }),
        invoice({ id: 'kontant', company_id: 'c3' }),
      ],
    })
    mock.setTable('supplier_payment_batch_items', { data: [] })
    mock.setTable('payment_orders', {
      data: [
        { supplier_invoice_id: 'at-bank', status: 'awaiting_signature', created_at: attested, supplier_invoice_payment_id: null },
        // An older attempt the bank rejected, then a newer one that failed.
        { supplier_invoice_id: 'refused', status: 'rejected', created_at: '2026-10-20T10:00:00Z', supplier_invoice_payment_id: null },
        { supplier_invoice_id: 'refused', status: 'failed', created_at: '2026-10-30T10:00:00Z', supplier_invoice_payment_id: null },
      ],
    })
    return mock
  }

  it('counts each attesting company\'s queues with the nearest due date and the fallen-due ones', async () => {
    const mock = seed()
    const queues = await loadAttestQueues(mock.supabase as unknown as SupabaseClient, ['c1', 'c2', 'c3'], '2026-10-31')
    expect(queues.get('c1')).toEqual({
      waiting: { count: 2, next_due: '2026-09-15', overdue: 2 },
      // The attested one due 19 Nov, the refused one 20 Nov, the part-paid one 25 Nov.
      ready: { count: 3, next_due: '2026-11-19', overdue: 0 },
    })
    // No policy, and kontantmetoden: no attest step, no queues.
    expect(queues.has('c2')).toBe(false)
    expect(queues.has('c3')).toBe(false)
    // The payment orders of the attested invoices are one read, not one per company.
    expect(mock.findCalls('payment_orders', 'select')).toHaveLength(1)
  })

  it('leaves out what another row already shows, asking for it only when an attested invoice could be ready', async () => {
    const mock = seed()
    const shown = vi.fn(async () => new Set(['refused']))
    const queues = await loadAttestQueues(mock.supabase as unknown as SupabaseClient, ['c1'], '2026-10-31', { leaveOut: shown })
    expect(queues.get('c1')?.ready).toEqual({ count: 2, next_due: '2026-11-19', overdue: 0 })
    expect(shown).toHaveBeenCalledTimes(1)

    // A governed company with nothing attested: nothing could be ready, so the other row is not asked.
    const waitingOnly = createTableMockSupabase()
    waitingOnly.setTable('company_attest_policies', {
      data: [{ company_id: 'c1', enabled: true, threshold_amount: null, mode: 'any', attesters: ['kim'], preparer_may_attest: false, updated_by: null, updated_at: null }],
    })
    waitingOnly.setTable('company_settings', { data: [{ company_id: 'c1', accounting_method: 'accrual' }] })
    waitingOnly.setTable('supplier_invoices', { data: [invoice({ id: 'mf-1', due_date: '2026-09-15', status: 'overdue' })] })
    waitingOnly.setTable('supplier_payment_batch_items', { data: [] })
    waitingOnly.setTable('payment_orders', { data: [] })
    const unasked = vi.fn(async () => new Set<string>())
    const waiting = await loadAttestQueues(waitingOnly.supabase as unknown as SupabaseClient, ['c1'], '2026-10-31', { leaveOut: unasked })
    expect(waiting.get('c1')?.waiting.count).toBe(1)
    expect(unasked).not.toHaveBeenCalled()
  })

  it('reads the payment orders of a few companies\' attested invoices in one paged read', async () => {
    const mock = createTableMockSupabase()
    const policy = (company_id: string) => ({ company_id, enabled: true, threshold_amount: null, mode: 'any', attesters: ['kim'], preparer_may_attest: false, updated_by: null, updated_at: null })
    mock.setTable('company_attest_policies', { data: [policy('c1'), policy('c4')] })
    mock.setTable('company_settings', { data: [{ company_id: 'c1', accounting_method: 'accrual' }, { company_id: 'c4', accounting_method: 'accrual' }] })
    mock.setTable('supplier_invoices', {
      data: [
        invoice({ id: 'a-1', company_id: 'c1', status: 'approved', approved_at: attested }),
        invoice({ id: 'b-1', company_id: 'c4', status: 'approved', approved_at: attested }),
      ],
    })
    mock.setTable('payment_orders', { data: [] })
    mock.setTable('supplier_payment_batch_items', { data: [] })
    const queues = await loadAttestQueues(mock.supabase as unknown as SupabaseClient, ['c1', 'c4'], '2026-10-31')
    expect(queues.get('c1')?.ready.count).toBe(1)
    expect(queues.get('c4')?.ready.count).toBe(1)
    expect(mock.findCalls('payment_orders', 'select')).toHaveLength(1)
    // Paged: PostgREST cuts a read at 1000 rows without a word.
    expect(mock.findCalls('payment_orders', 'range')).toHaveLength(1)
  })

  it('keeps every orders read at 150 ids, company ids and invoice ids together, for a byrå with many clients', async () => {
    const mock = createTableMockSupabase()
    const companies = Array.from({ length: 60 }, (_, i) => `c${i}`)
    const policy = (company_id: string) => ({ company_id, enabled: true, threshold_amount: null, mode: 'any', attesters: ['kim'], preparer_may_attest: false, updated_by: null, updated_at: null })
    mock.setTable('company_attest_policies', { data: companies.map(policy) })
    mock.setTable('company_settings', { data: companies.map((company_id) => ({ company_id, accounting_method: 'accrual' })) })
    // Three attested invoices per client: 180 invoice ids and 60 company ids, past one URL.
    mock.setTable('supplier_invoices', {
      data: companies.flatMap((company_id) =>
        [1, 2, 3].map((n) => invoice({ id: `${company_id}-${n}`, company_id, status: 'approved', approved_at: attested })),
      ),
    })
    mock.setTable('payment_orders', { data: [] })
    const queues = await loadAttestQueues(mock.supabase as unknown as SupabaseClient, companies, '2026-10-31')
    expect(queues.get('c59')?.ready.count).toBe(3)

    const inLists = mock.calls.filter((c) => c.table === 'payment_orders' && c.method === 'in')
    const reads = mock.findCalls('payment_orders', 'select').length
    expect(reads).toBeGreaterThan(1)
    for (let r = 0; r < reads; r++) {
      const [companyIds, invoiceIds] = [inLists[r * 3].args[1] as string[], inLists[r * 3 + 1].args[1] as string[]]
      expect(inLists[r * 3].args[0]).toBe('company_id')
      expect(companyIds.length + invoiceIds.length).toBeLessThanOrEqual(150)
    }
    const read = new Set(inLists.filter((c) => c.args[0] === 'supplier_invoice_id').flatMap((c) => c.args[1] as string[]))
    expect(read.size).toBe(180)
  })

  it('reads nothing past the policies when no company attests', async () => {
    const mock = createTableMockSupabase()
    mock.setTable('company_attest_policies', { data: [] })
    const queues = await loadAttestQueues(mock.supabase as unknown as SupabaseClient, ['c1'], '2026-10-31')
    expect(queues.size).toBe(0)
    expect(mock.findCall('supplier_invoices', 'select')).toBeUndefined()
  })

  it('throws when it cannot tell, so each surface chooses how to degrade', async () => {
    const mock = createTableMockSupabase()
    mock.setTable('company_attest_policies', { error: { message: 'boom' } })
    await expect(loadAttestQueues(mock.supabase as unknown as SupabaseClient, ['c1'], '2026-10-31')).rejects.toBeTruthy()
  })
})

describe('a ticked "Inlagd i banken" in the to-pay counts (crm#1824)', () => {
  const attested = '2026-10-31T10:00:00Z'
  const tick = '2026-11-10T09:00:00Z'
  const policyRow = { company_id: 'c1', enabled: true, threshold_amount: null, mode: 'any', attesters: ['kim'], preparer_may_attest: false, updated_by: null, updated_at: null }

  /** Four attested invoices of c1 on 12 Nov: plain, ticked and not due, ticked and fallen due, ticked then un-ticked. */
  function seed(policies: unknown[], accountingMethod: string) {
    const mock = createTableMockSupabase()
    mock.setTable('company_attest_policies', { data: policies })
    mock.setTable('company_settings', { data: [{ company_id: 'c1', accounting_method: accountingMethod }] })
    mock.setTable('supplier_invoices', {
      data: [
        invoice({ id: 'plain', status: 'approved', approved_at: attested, due_date: '2026-11-25' }),
        invoice({ id: 'ticked', status: 'approved', approved_at: attested, due_date: '2026-11-30', bank_entered_at: tick }),
        invoice({ id: 'ticked-due', status: 'overdue', approved_at: attested, due_date: '2026-11-05', bank_entered_at: tick }),
        invoice({ id: 'unticked', status: 'approved', approved_at: attested, due_date: '2026-11-28', bank_entered_at: null }),
      ],
    })
    mock.setTable('payment_orders', { data: [] })
    return mock.supabase as unknown as SupabaseClient
  }

  it('leaves the ticked one out of ready until it falls due, where the attest policy governs', async () => {
    const queues = await loadAttestQueues(seed([policyRow], 'accrual'), ['c1'], '2026-11-12')
    expect(queues.get('c1')?.ready).toEqual({ count: 3, next_due: '2026-11-05', overdue: 1 })
  })

  it('counts the same way where the policy governs: the Att göra row and the Att betala tab are one population', async () => {
    // loadToPayQueue reads one company's policy and method as one row each.
    const mock = createTableMockSupabase()
    mock.setTable('company_attest_policies', { data: policyRow })
    mock.setTable('company_settings', { data: { accounting_method: 'accrual' } })
    const governed = seed([policyRow], 'accrual') as unknown as { from: (table: string) => unknown }
    const supabase = {
      ...(governed as object),
      from: (table: string) => (table === 'company_attest_policies' || table === 'company_settings' ? mock.supabase.from(table) : governed.from(table)),
    } as unknown as SupabaseClient
    const toPay = await loadToPayQueue(supabase, 'c1', '2026-11-12')
    expect(toPay).toEqual({ queue: { count: 3, next_due: '2026-11-05', overdue: 1 } })
  })

  it('counts the same way for a company without an attest queue', async () => {
    const mock = createTableMockSupabase()
    mock.setTable('company_attest_policies', { data: null })
    mock.setTable('company_settings', { data: { accounting_method: 'cash' } })
    const plain = seed([], 'cash') as unknown as { from: (table: string) => unknown }
    const supabase = {
      ...(plain as object),
      from: (table: string) => (table === 'company_attest_policies' || table === 'company_settings' ? mock.supabase.from(table) : plain.from(table)),
    } as unknown as SupabaseClient
    const toPay = await loadToPayQueue(supabase, 'c1', '2026-11-12')
    expect(toPay).toEqual({ queue: { count: 3, next_due: '2026-11-05', overdue: 1 } })
  })
})

// The byrå's Redo att betala once counted only attested invoices while Att
// göra counted every one the policy lets through: the byrå said 0 and the
// client's Att göra said 1 for the same invoice.
describe('the byrå\'s Redo att betala and the Att göra Betala row: one population', () => {
  const policyRow = { company_id: 'c1', enabled: true, threshold_amount: 10_000, mode: 'any', attesters: ['kim'], preparer_may_attest: false, updated_by: null, updated_at: null }

  /** c1 on 12 Nov: one invoice the policy holds, one under its threshold, one under it already at the bank. */
  function invoicesAndOrders() {
    const mock = createTableMockSupabase()
    mock.setTable('supplier_invoices', {
      data: [
        invoice({ id: 'held', status: 'registered', approved_at: null, total: 50_000, remaining_amount: 50_000, due_date: '2026-11-20' }),
        invoice({ id: 'below', status: 'registered', approved_at: null, total: 2_000, remaining_amount: 2_000, due_date: '2026-11-25' }),
        invoice({ id: 'below-at-bank', status: 'registered', approved_at: null, total: 3_000, remaining_amount: 3_000, due_date: '2026-11-18' }),
      ],
    })
    mock.setTable('supplier_payment_batch_items', { data: [] })
    mock.setTable('payment_orders', {
      data: [{ supplier_invoice_id: 'below-at-bank', status: 'awaiting_signature', created_at: '2026-11-11T10:00:00Z', supplier_invoice_payment_id: null }],
    })
    return mock
  }

  it('counts the unattested invoice under the threshold in both, and neither the held one nor the one at the bank', async () => {
    // The byrå reads every client's policy and method as lists.
    const byraData = invoicesAndOrders()
    byraData.setTable('company_attest_policies', { data: [policyRow] })
    byraData.setTable('company_settings', { data: [{ company_id: 'c1', accounting_method: 'accrual' }] })
    const byra = await loadAttestQueues(byraData.supabase as unknown as SupabaseClient, ['c1'], '2026-11-12')

    // Att göra reads one company's policy and method as one row each, over the same invoices and orders.
    const oneRow = createTableMockSupabase()
    oneRow.setTable('company_attest_policies', { data: policyRow })
    oneRow.setTable('company_settings', { data: { accounting_method: 'accrual' } })
    const shared = invoicesAndOrders()
    const attGora = await loadToPayQueue(
      {
        ...(shared.supabase as object),
        from: (table: string) =>
          table === 'company_attest_policies' || table === 'company_settings' ? oneRow.supabase.from(table) : shared.supabase.from(table),
      } as unknown as SupabaseClient,
      'c1',
      '2026-11-12',
    )

    expect(byra.get('c1')?.ready).toEqual({ count: 1, next_due: '2026-11-25', overdue: 0 })
    expect(attGora.queue).toEqual(byra.get('c1')?.ready)
    // The held one waits for attest on the byrå's board; the one at the bank is nobody's to pay.
    expect(byra.get('c1')?.waiting).toEqual({ count: 1, next_due: '2026-11-20', overdue: 0 })
    // The bank is asked about every invoice the policy does not hold, attested or not.
    expect(byraData.findCalls('payment_orders', 'in')).toContainEqual(['supplier_invoice_id', expect.arrayContaining(['below', 'below-at-bank'])])
  })
})

describe('loadToPayQueue: what waits to be paid (lib/supplier-invoices/to-pay.ts)', () => {
  const policy = (threshold: number | null) => ({
    company_id: 'c1', enabled: true, threshold_amount: threshold, mode: 'any', attesters: ['kim'], preparer_may_attest: false, updated_by: null, updated_at: null,
  })
  function seed(policy: unknown, accountingMethod: string, invoices: unknown[]) {
    const mock = createTableMockSupabase()
    // One company's policy, read as one row (loadAttestPolicy).
    mock.setTable('company_attest_policies', { data: policy })
    mock.setTable('company_settings', { data: { accounting_method: accountingMethod } })
    mock.setTable('supplier_invoices', { data: invoices })
    mock.setTable('payment_orders', { data: [] })
    return mock.supabase as unknown as SupabaseClient
  }

  it('counts an unattested invoice of a company without a policy: the payment file pays it', async () => {
    const toPay = await loadToPayQueue(
      seed(null, 'accrual', [invoice({ id: 'unattested', status: 'registered', approved_at: null, due_date: '2026-11-25' })]),
      'c1',
      '2026-11-12',
    )
    expect(toPay.queue.count).toBe(1)
  })

  it('leaves out what the policy holds back, and counts what it lets through below its threshold', async () => {
    const toPay = await loadToPayQueue(
      seed(policy(10_000), 'accrual', [
        invoice({ id: 'big-unattested', status: 'registered', approved_at: null, total: 50_000, remaining_amount: 50_000, due_date: '2026-11-20' }),
        invoice({ id: 'small-unattested', status: 'registered', approved_at: null, total: 2_000, remaining_amount: 2_000, due_date: '2026-11-25' }),
        invoice({ id: 'big-attested', status: 'approved', approved_at: '2026-11-01T10:00:00Z', total: 50_000, remaining_amount: 50_000, due_date: '2026-11-30' }),
      ]),
      'c1',
      '2026-11-12',
    )
    expect(toPay.queue).toEqual({ count: 2, next_due: '2026-11-25', overdue: 0 })
  })
})
