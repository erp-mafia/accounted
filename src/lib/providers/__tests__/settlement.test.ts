import { describe, it, expect } from 'vitest'
import { NOTHING_SETTLED, resolveInvoiceSettlement } from '../settlement'
import type { PaymentStatusDto } from '../dto'

const statement = (paid: boolean, balance: number, lastPaymentDate?: string, source: PaymentStatusDto['source'] = 'balance'): PaymentStatusDto => ({
  paid,
  balance: { value: balance, currencyCode: 'SEK' },
  lastPaymentDate,
  source,
})

describe('resolveInvoiceSettlement', () => {
  it('settles a fully paid invoice and dates it from the provider payment date', () => {
    expect(resolveInvoiceSettlement(statement(false, 0, '2026-02-05'), 'booked', 1000)).toEqual({
      status: 'paid',
      paidAmount: 1000,
      remainingAmount: 0,
      paidAt: '2026-02-05',
    })
  })

  it('leaves paidAt null when the provider names no payment date: unknown is not the issue date', () => {
    expect(resolveInvoiceSettlement(statement(false, 0), 'booked', 1000)).toEqual({
      status: 'paid',
      paidAmount: 1000,
      remainingAmount: 0,
      paidAt: null,
    })
  })

  it('normalises an empty payment date string to null rather than writing it', () => {
    expect(resolveInvoiceSettlement(statement(false, 0, ''), 'booked', 1000).paidAt).toBeNull()
  })

  it('reports a partial payment as partially_paid with both amounts and no paid date', () => {
    expect(resolveInvoiceSettlement(statement(false, 300, '2026-02-05'), 'sent', 1000)).toEqual({
      status: 'partially_paid',
      paidAmount: 700,
      remainingAmount: 300,
      paidAt: null,
    })
  })

  it('says nothing about a still-open invoice, so the caller keeps its lifecycle status', () => {
    expect(resolveInvoiceSettlement(statement(false, 1000), 'overdue', 1000)).toEqual({
      status: null,
      paidAmount: 0,
      remainingAmount: 1000,
      paidAt: null,
    })
  })

  it('never settles a zero total on a balance alone', () => {
    expect(resolveInvoiceSettlement(statement(false, 0), 'booked', 0).status).toBeNull()
  })

  it('honours a provider that says a zero total is paid', () => {
    expect(resolveInvoiceSettlement(statement(true, 0), 'paid', 0).status).toBe('paid')
  })

  it('never lets a zero balance override an explicit unpaid enum', () => {
    expect(resolveInvoiceSettlement(statement(false, 0, undefined, 'enum'), 'booked', 1000)).toEqual({
      status: null,
      paidAmount: 0,
      remainingAmount: 1000,
      paidAt: null,
    })
  })

  it('a paid flag settles the invoice whatever the balance says', () => {
    expect(resolveInvoiceSettlement(statement(true, 1000), 'booked', 1000)).toMatchObject({
      status: 'paid', paidAmount: 1000, remainingAmount: 0,
    })
  })

  it('a lifecycle saying paid settles the invoice when the money fields are silent', () => {
    expect(resolveInvoiceSettlement(statement(false, 1000), 'paid', 1000)).toMatchObject({
      status: 'paid', paidAmount: 1000, remainingAmount: 0,
    })
  })

  it('clamps an overpaid or over-stated balance to the row: never a negative amount', () => {
    expect(resolveInvoiceSettlement(statement(false, -200), 'sent', 1000)).toMatchObject({ status: 'paid', paidAmount: 1000, remainingAmount: 0 })
    expect(resolveInvoiceSettlement(statement(false, 1200), 'sent', 1000)).toMatchObject({ status: null, paidAmount: 0, remainingAmount: 1200 })
  })

  it('a document its mapper read as unissued arrives owing its total, and stays as it is', () => {
    expect(resolveInvoiceSettlement(statement(false, 1000), 'draft', 1000)).toEqual({
      status: null, paidAmount: 0, remainingAmount: 1000, paidAt: null,
    })
  })

  it('a draft that is only a mapper\'s fallback keeps the money its fields state', () => {
    expect(resolveInvoiceSettlement(statement(false, 250), 'draft', 1250)).toEqual({
      status: 'partially_paid', paidAmount: 1000, remainingAmount: 250, paidAt: null,
    })
    expect(resolveInvoiceSettlement(statement(true, 0), 'draft', 1250)).toMatchObject({
      status: 'paid', paidAmount: 1250, remainingAmount: 0,
    })
  })

  it('a voided document neither collected nor owes anything', () => {
    expect(resolveInvoiceSettlement(statement(true, 0, '2026-02-05'), 'cancelled', 1000)).toEqual(NOTHING_SETTLED)
    expect(resolveInvoiceSettlement(statement(false, 1000), 'cancelled', 1000)).toEqual(NOTHING_SETTLED)
  })

  it('an original the source credited keeps its status and the money its fields state', () => {
    expect(resolveInvoiceSettlement(statement(true, 0, '2026-02-05'), 'credited', 1000)).toEqual({
      status: null, paidAmount: 1000, remainingAmount: 0, paidAt: '2026-02-05',
    })
    expect(resolveInvoiceSettlement(statement(false, 300), 'credited', 1000)).toMatchObject({
      status: null, paidAmount: 700, remainingAmount: 300,
    })
  })
})
