import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import { NO_ATTEST_POLICY, type AttestPolicy } from '../attest-policy'
import { attestQueueOf, isToPayWithoutAttest, loadAttestQueues, loadToPayQueue, paymentOrderReadChunks, type AttestQueueInvoice } from '../attest-queues'

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

  it('leaves out what the policy does not govern: no policy, kontantmetoden, a credit note, under the threshold', () => {
    expect(attestQueueOf(NO_ATTEST_POLICY, 'accrual', invoice(), false)).toBeNull()
    expect(attestQueueOf(POLICY, 'cash', invoice(), false)).toBeNull()
    expect(attestQueueOf(POLICY, 'accrual', invoice({ is_credit_note: true }), false)).toBeNull()
    expect(attestQueueOf({ ...POLICY, threshold_amount: 20000 }, 'accrual', invoice(), false)).toBeNull()
    expect(attestQueueOf({ ...POLICY, threshold_amount: 20000 }, 'accrual', invoice({ approved_at: '2026-10-31T10:00:00Z', status: 'approved' }), false)).toBeNull()
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

describe('isToPayWithoutAttest (crm#1631)', () => {
  it('takes a registered invoice as it stands on kontantmetoden, and only an approved one on faktureringsmetoden', () => {
    expect(isToPayWithoutAttest('cash', invoice(), false)).toBe(true)
    expect(isToPayWithoutAttest('cash', invoice({ status: 'overdue' }), false)).toBe(true)
    expect(isToPayWithoutAttest('accrual', invoice(), false)).toBe(false)
    expect(isToPayWithoutAttest(null, invoice({ status: 'overdue' }), false)).toBe(false)
    expect(isToPayWithoutAttest('accrual', invoice({ status: 'approved', approved_at: '2026-10-31T10:00:00Z' }), false)).toBe(true)
  })

  it('shares the ready rule with the attest queue: nothing left, not payable, debited by the supplier, at the bank, a credit note', () => {
    expect(isToPayWithoutAttest('cash', invoice({ remaining_amount: 0.004 }), false)).toBe(false)
    expect(isToPayWithoutAttest('cash', invoice({ status: 'paid' }), false)).toBe(false)
    expect(isToPayWithoutAttest('cash', invoice({ auto_debit: true }), false)).toBe(false)
    expect(isToPayWithoutAttest('cash', invoice(), true)).toBe(false)
    expect(isToPayWithoutAttest('cash', invoice({ is_credit_note: true }), false)).toBe(false)
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

  it('counts the same way for a company without an attest queue', async () => {
    const toPay = await loadToPayQueue(seed([], 'cash'), 'c1', '2026-11-12')
    expect(toPay).toEqual({ attested: false, queue: { count: 3, next_due: '2026-11-05', overdue: 1 } })
  })
})
