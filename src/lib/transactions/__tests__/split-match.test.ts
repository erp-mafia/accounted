import { describe, expect, it } from 'vitest'
import { canOfferSplitMatch, planPickedAllocations, type PickedInvoice } from '../split-match'

const base = { isUnbooked: true, hasRotRutPayoutMatch: false, hasExpensePayoutMatch: false }

describe('canOfferSplitMatch', () => {
  it('offers the split on an unbooked row', () => {
    expect(canOfferSplitMatch(base)).toBe(true)
  })

  it('does not take the invoice suggestion as input, so a suggested match never hides it', () => {
    // Regression: one 10 000 kr payment against four 2 500 kr invoices. The
    // matcher suggests one invoice; the split must still be reachable.
    const withSuggestion = { ...base, potential_invoice: { id: 'inv-1' } }
    expect(canOfferSplitMatch(withSuggestion)).toBe(true)
  })

  it('hides the split on a booked row', () => {
    expect(canOfferSplitMatch({ ...base, isUnbooked: false })).toBe(false)
  })

  it('hides the split when the row is a ROT/RUT payout', () => {
    expect(canOfferSplitMatch({ ...base, hasRotRutPayoutMatch: true })).toBe(false)
  })

  it('hides the split when the row repays an utlägg', () => {
    expect(canOfferSplitMatch({ ...base, hasExpensePayoutMatch: true })).toBe(false)
  })
})

const supplier = (id: string, remaining: number, dueDate: string | null = '2026-10-01'): PickedInvoice => ({
  kind: 'supplier_invoice',
  id,
  remaining,
  dueDate,
})

describe('planPickedAllocations', () => {
  it('pays two supplier invoices that add up to the outgoing row (PH 192)', () => {
    // One internet payment for two invoices of the same supplier.
    const plan = planPickedAllocations(-10000, [supplier('si-b', 2500), supplier('si-a', 7500)])
    expect(plan.outcome).toBe('exact')
    expect(plan.pickedTotal).toBe(10000)
    expect(plan.difference).toBe(0)
    expect(plan.allocations).toEqual([
      { kind: 'supplier_invoice', supplier_invoice_id: 'si-a', amount: 7500 },
      { kind: 'supplier_invoice', supplier_invoice_id: 'si-b', amount: 2500 },
    ])
  })

  it('orders by due date, oldest first, and builds customer allocations for an incoming row', () => {
    const plan = planPickedAllocations(3000, [
      { kind: 'customer_invoice', id: 'inv-new', remaining: 1000, dueDate: '2026-10-20' },
      { kind: 'customer_invoice', id: 'inv-old', remaining: 2000, dueDate: '2026-09-20' },
    ])
    expect(plan.outcome).toBe('exact')
    expect(plan.allocations).toEqual([
      { kind: 'customer_invoice', invoice_id: 'inv-old', amount: 2000 },
      { kind: 'customer_invoice', invoice_id: 'inv-new', amount: 1000 },
    ])
  })

  it('puts a sub-krona difference on the last invoice, which the RPC books as öresavrundning', () => {
    const plan = planPickedAllocations(-1500, [supplier('a', 1000.4, '2026-09-01'), supplier('b', 499.8, '2026-09-02')])
    expect(plan.outcome).toBe('ore_rounding')
    expect(plan.difference).toBe(-0.2)
    expect(plan.allocations).toEqual([
      { kind: 'supplier_invoice', supplier_invoice_id: 'a', amount: 1000.4 },
      { kind: 'supplier_invoice', supplier_invoice_id: 'b', amount: 499.6 },
    ])
    expect(plan.allocations.reduce((sum, a) => sum + a.amount, 0)).toBeCloseTo(1500, 5)
  })

  it('lets a whole-krona row overpay the öre too, never by a krona or more', () => {
    const plan = planPickedAllocations(-1000, [supplier('a', 600.25), supplier('b', 399.5, '2026-10-02')])
    expect(plan.outcome).toBe('ore_rounding')
    expect(plan.allocations[1]).toEqual({ kind: 'supplier_invoice', supplier_invoice_id: 'b', amount: 399.75 })
  })

  it('pays the last invoice in part when the invoices owe more than the row', () => {
    const plan = planPickedAllocations(-2500, [supplier('a', 2000, '2026-09-01'), supplier('b', 1000, '2026-09-15')])
    expect(plan.outcome).toBe('partial')
    expect(plan.partiallyPaidId).toBe('b')
    expect(plan.difference).toBe(-500)
    expect(plan.allocations).toEqual([
      { kind: 'supplier_invoice', supplier_invoice_id: 'a', amount: 2000 },
      { kind: 'supplier_invoice', supplier_invoice_id: 'b', amount: 500 },
    ])
  })

  it('says one invoice too many when the last one would get nothing, keeping what each owes', () => {
    const plan = planPickedAllocations(-2000, [supplier('a', 2000, '2026-09-01'), supplier('b', 1000, '2026-09-15')])
    expect(plan.outcome).toBe('over')
    expect(plan.partiallyPaidId).toBeNull()
    expect(plan.allocations.map((a) => a.amount)).toEqual([2000, 1000])
  })

  it('never invents a difference line when the row is a krona or more larger', () => {
    // The 1:1 match would call 2 500 kr a bank fee on 6570; a batch has no
    // such line, so the gap stays visible until more invoices cover it.
    const plan = planPickedAllocations(-10000, [supplier('a', 7500)])
    expect(plan.outcome).toBe('short')
    expect(plan.difference).toBe(2500)
    expect(plan.allocations).toEqual([{ kind: 'supplier_invoice', supplier_invoice_id: 'a', amount: 7500 }])
  })

  it('returns an empty plan for nothing ticked', () => {
    const plan = planPickedAllocations(-100, [])
    expect(plan.allocations).toEqual([])
    expect(plan.pickedTotal).toBe(0)
  })
})
