/**
 * A kundförlust decision's business event for the posting port
 * (sale.customer_loss): the invoice as subject, the amount the decision
 * moves, and the moms it reverses or books back.
 */
import { describe, expect, it } from 'vitest'
import { customerLossBusinessEvent } from '../record'
import type { CustomerLossState } from '../state'

const state = { invoice: { id: '00000000-0000-4000-8000-000000000a01' } } as CustomerLossState

describe('customerLossBusinessEvent', () => {
  it('records a konstaterad write-off with its moms, dated the decision', () => {
    const event = customerLossBusinessEvent({ state, entryDate: '2026-10-15', amount: 1250, vat: 250, evidenceDocumentId: null })
    expect(event).toMatchObject({
      kind: 'sale.customer_loss',
      category: null,
      occurredOn: '2026-10-15',
      subject: { type: 'invoice', id: state.invoice.id },
      currency: 'SEK',
      amount: 1250,
      amountSek: 1250,
      taxAmounts: [{ tax: 'vat', treatment: null, amount_sek: 250 }],
      jurisdiction: 'SE',
    })
    expect(event.mappingVersion).toMatch(/^se\.customer-loss-lines@/)
    expect(event.party).toBeUndefined()
  })

  it('keeps amounts as magnitudes and names the evidence document', () => {
    const event = customerLossBusinessEvent({
      state,
      entryDate: '2026-10-15',
      amount: -400,
      vat: -80,
      evidenceDocumentId: '00000000-0000-4000-8000-000000000d01',
    })
    expect(event.amount).toBe(400)
    expect(event.taxAmounts).toEqual([{ tax: 'vat', treatment: null, amount_sek: 80 }])
    expect(event.evidence).toEqual({ document_id: '00000000-0000-4000-8000-000000000d01' })
  })

  it('states no moms for a befarad reserve, which books none', () => {
    expect(customerLossBusinessEvent({ state, entryDate: '2026-10-15', amount: 1000, vat: 0 }).taxAmounts).toEqual([])
  })
})
