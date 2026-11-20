/**
 * The business events of the SQL step of the posting port: pure builders,
 * each the same business act as the door that books it one at a time, and
 * each a row the port accepts (the closed kinds, subjects and evidence).
 */
import { describe, expect, it } from 'vitest'
import { buildRow } from '@/lib/posting/port'
import type { LinkBasisColumns } from '@/lib/links/link-basis'
import { bankLineBookingBusinessEvent } from '../bank-line-business-events'
import {
  batchAllocationBusinessEvent,
  batchAllocationSettledAmount,
  bulkBookedBankLineBusinessEvent,
  expensePayoutBusinessEvent,
  voucherLinkKursdifferensBusinessEvent,
  type BatchAllocationFacts,
} from '../sql-posting-business-events'

const COMPANY = '00000000-0000-4000-8000-0000000000c1'
const TX = '00000000-0000-4000-8000-0000000000a1'
const INVOICE = '00000000-0000-4000-8000-0000000000b1'
const PARTY = '00000000-0000-4000-8000-0000000000d1'
const CLAIM = '00000000-0000-4000-8000-0000000000e1'
const EMPLOYEE = '00000000-0000-4000-8000-0000000000f1'
const TEMPLATE = '00000000-0000-4000-8000-0000000000f2'
const OP = '00000000-0000-4000-8000-0000000000f3'

const CREATED: LinkBasisColumns = { link_basis: 'user_created', link_evidence: null }
const CONFIRMED: LinkBasisColumns = { link_basis: 'user_confirmed', link_evidence: null }
const STAGED: LinkBasisColumns = { link_basis: 'agent_proposed_user_approved', link_evidence: { pending_operation_id: OP } }

const accepted = (event: Parameters<typeof buildRow>[1]) => buildRow(COMPANY, event, () => '00000000-0000-4000-8000-000000000001')

const ROW = { id: TX, date: '2026-03-10', amount: -50, currency: 'SEK', amount_sek: null, exchange_rate: null } as Parameters<
  typeof bankLineBookingBusinessEvent
>[0]

describe('bulkBookedBankLineBusinessEvent', () => {
  it('is the book route\'s bank.categorized for the bank line, own rows naming no rule', () => {
    const event = bulkBookedBankLineBusinessEvent(ROW, { linkBasis: CREATED })
    expect(event).toEqual(bankLineBookingBusinessEvent(ROW, { linkBasis: CREATED }))
    expect(accepted(event)).toMatchObject({
      kind: 'bank.categorized',
      subject_type: 'transaction',
      subject_id: TX,
      amount: 50,
      amount_sek: 50,
      currency: 'SEK',
      mapping_version: null,
      evidence: { direction: 'out', link_basis: 'user_created' },
    })
  })

  it('names the booking template it was booked through, and the template rule', () => {
    const row = accepted(bulkBookedBankLineBusinessEvent(ROW, { linkBasis: CREATED, templateId: TEMPLATE }))
    expect(row.evidence).toMatchObject({ template_id: TEMPLATE, direction: 'out' })
    expect(row.mapping_version).toMatch(/^se\.booking-template@/)
  })
})

describe('batchAllocationSettledAmount (as match_batch_allocate records the payment row)', () => {
  const facts = (amount: number, currency: string, remaining: number | null, total = 1000): BatchAllocationFacts => ({
    kind: 'customer_invoice',
    invoiceId: INVOICE,
    partyId: PARTY,
    amount,
    invoice: { currency, remaining_amount: remaining, total },
  })

  it('settles the allocation on an invoice in the bank line\'s currency', () => {
    expect(batchAllocationSettledAmount(facts(1000, 'SEK', 1000), 'SEK')).toBe(1000)
    expect(batchAllocationSettledAmount(facts(600, 'SEK', 1000), 'SEK')).toBe(600)
  })

  it('settles the whole remainder inside the öresavrundning band', () => {
    expect(batchAllocationSettledAmount(facts(1750, 'SEK', 1750.4), 'SEK')).toBe(1750.4)
    expect(batchAllocationSettledAmount(facts(1001, 'SEK', 1000.5), 'SEK')).toBe(1000.5)
    expect(batchAllocationSettledAmount(facts(1749, 'SEK', 1750.4), 'SEK')).toBe(1749)
  })

  it('settles the whole remainder of an invoice in another currency, the total when none is stored', () => {
    expect(batchAllocationSettledAmount(facts(1120, 'EUR', 100), 'SEK')).toBe(100)
    expect(batchAllocationSettledAmount(facts(1120, 'EUR', null, 120), 'SEK')).toBe(120)
  })
})

describe('batchAllocationBusinessEvent', () => {
  it('a customer invoice: sale.payment_received, the invoice and its customer, money in', () => {
    const row = accepted(
      batchAllocationBusinessEvent(
        { kind: 'customer_invoice', invoiceId: INVOICE, partyId: PARTY, amount: 1120, invoice: { currency: 'EUR', remaining_amount: 100, total: 100 } },
        { date: '2026-03-15', currency: 'SEK' },
        STAGED,
      ),
    )
    expect(row).toMatchObject({
      kind: 'sale.payment_received',
      occurred_on: '2026-03-15',
      subject_type: 'invoice',
      subject_id: INVOICE,
      party_type: 'customer',
      party_id: PARTY,
      currency: 'EUR',
      amount: 100,
      amount_sek: 1120,
      tax_amounts: [],
      pending_operation_id: OP,
      evidence: { direction: 'in', link_basis: 'agent_proposed_user_approved', link_evidence: { pending_operation_id: OP } },
    })
    expect(row.mapping_version).toMatch(/^se\.customer-payment-lines@/)
  })

  it('a supplier invoice: purchase.paid, money out; no kronor from a bank line in another currency', () => {
    const row = accepted(
      batchAllocationBusinessEvent(
        { kind: 'supplier_invoice', invoiceId: INVOICE, partyId: PARTY, amount: 800, invoice: { currency: 'EUR', remaining_amount: 800, total: 800 } },
        { date: '2026-03-16', currency: 'EUR' },
        CONFIRMED,
      ),
    )
    expect(row).toMatchObject({
      kind: 'purchase.paid',
      subject_type: 'supplier_invoice',
      party_type: 'supplier',
      currency: 'EUR',
      amount: 800,
      amount_sek: null,
      evidence: { direction: 'out', link_basis: 'user_confirmed' },
    })
    expect(row.mapping_version).toMatch(/^se\.supplier-payment-lines@/)
  })
})

describe('voucherLinkKursdifferensBusinessEvent', () => {
  it('the payment the link records, dated the linked verifikat, settled in full', () => {
    for (const [side, kind, subject, party, source] of [
      ['customer', 'sale.payment_received', 'invoice', 'customer', 'se.customer-payment-lines'],
      ['supplier', 'purchase.paid', 'supplier_invoice', 'supplier', 'se.supplier-payment-lines'],
    ] as const) {
      const row = accepted(
        voucherLinkKursdifferensBusinessEvent(
          { side, invoiceId: INVOICE, partyId: PARTY, currency: 'EUR', remaining: 1000, voucherDate: '2026-03-17' },
          CONFIRMED,
        ),
      )
      expect(row).toMatchObject({
        kind,
        occurred_on: '2026-03-17',
        subject_type: subject,
        party_type: party,
        currency: 'EUR',
        amount: 1000,
        amount_sek: null,
        evidence: { link_basis: 'user_confirmed' },
      })
      expect(row.evidence.direction).toBeUndefined()
      expect(row.mapping_version?.startsWith(`${source}@`)).toBe(true)
    }
  })
})

describe('expensePayoutBusinessEvent', () => {
  it('one claim repaid: expense.paid_out, the kronor repaid, the employee as party', () => {
    const row = accepted(
      expensePayoutBusinessEvent(
        { id: CLAIM, employee_id: EMPLOYEE, amount_sek: 265, document_id: TEMPLATE },
        { payoutDate: '2026-03-21', bankLine: true },
        CREATED,
      ),
    )
    expect(row).toMatchObject({
      kind: 'expense.paid_out',
      occurred_on: '2026-03-21',
      subject_type: 'expense_claim',
      subject_id: CLAIM,
      party_type: 'employee',
      party_id: EMPLOYEE,
      currency: null,
      amount: null,
      amount_sek: 265,
      evidence: { direction: 'out', document_id: TEMPLATE, link_basis: 'user_created' },
    })
    expect(row.mapping_version).toMatch(/^se\.expense-claim@/)
  })

  it('an owner\'s claim names nobody; a transfer not matched to a bank line has no direction', () => {
    const row = accepted(
      expensePayoutBusinessEvent({ id: CLAIM, employee_id: null, amount_sek: 500, document_id: null }, { payoutDate: '2026-03-20', bankLine: false }, CREATED),
    )
    expect(row).toMatchObject({ party_type: null, party_id: null, amount_sek: 500 })
    expect(row.evidence.direction).toBeUndefined()
  })
})
