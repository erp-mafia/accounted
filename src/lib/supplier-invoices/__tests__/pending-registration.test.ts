import { describe, expect, it } from 'vitest'
import type { PayerChoice } from '@/lib/expenses/payer'
import type { SupplierInvoiceFormData } from '../form-payload'
import {
  pendingRegistrationReducer,
  type PendingRegistration,
  type PendingRegistrationEvent,
} from '../pending-registration'

const form = (payer: PayerChoice, number = 'F-1'): SupplierInvoiceFormData =>
  ({ supplier_id: 'supplier-1', supplier_invoice_number: number, payment_reference: '5550001', payer, items: [] }) as unknown as SupplierInvoiceFormData

const submitted = (payer: PayerChoice, knownTransactionId: string | null = null): PendingRegistrationEvent => ({
  type: 'submitted',
  data: form(payer),
  knownTransactionId,
})
const picked = (transactionId: string): PendingRegistrationEvent => ({ type: 'row_picked', transactionId })

/** What the editor holds after the person has done these things, in order. */
const after = (...events: PendingRegistrationEvent[]): PendingRegistration | null =>
  events.reduce<PendingRegistration | null>(pendingRegistrationReducer, null)

describe('pendingRegistrationReducer: the bank row belongs to one submit', () => {
  it('holds the row picked for a registration the company paid', () => {
    expect(after(submitted('company'), picked('tx-X'))).toMatchObject({ data: { payer: 'company' }, transactionId: 'tx-X' })
  })

  // The review's sequence: Företaget, pick row X, the review opens (a reused
  // OCR to acknowledge), Tillbaka, switch to Obetald, Registrera, "Registrera
  // ändå". The unpaid invoice was attested, matched to X and marked paid.
  it('an invoice registered as unpaid after a pick the person stepped back from has no bank row', () => {
    expect(after(submitted('company'), picked('tx-X'), submitted('unpaid'))).toEqual({ data: form('unpaid'), transactionId: null })
  })

  it("nor has a person's utlägg registered after such a pick", () => {
    expect(after(submitted('company'), picked('tx-X'), submitted('owner'))?.transactionId).toBeNull()
    expect(after(submitted('company'), picked('tx-X'), submitted('employee'))?.transactionId).toBeNull()
  })

  it('a second submit for the company starts without the first one\'s row, until a row is picked for it', () => {
    expect(after(submitted('company'), picked('tx-X'), submitted('company'))?.transactionId).toBeNull()
    expect(after(submitted('company'), picked('tx-X'), submitted('company'), picked('tx-Y'))?.transactionId).toBe('tx-Y')
  })

  it('takes the row the Inkorg already knows, for a registration the company paid only', () => {
    expect(after(submitted('company', 'tx-known'))?.transactionId).toBe('tx-known')
    expect(after(submitted('unpaid', 'tx-known'))?.transactionId).toBeNull()
    expect(after(submitted('owner', 'tx-known'))?.transactionId).toBeNull()
    // Företaget first, then back and Obetald: the known row does not come along.
    expect(after(submitted('company', 'tx-known'), submitted('unpaid', 'tx-known'))?.transactionId).toBeNull()
  })

  it('ignores a pick with nothing submitted, or for a registration the company did not pay', () => {
    expect(after(picked('tx-X'))).toBeNull()
    expect(after(submitted('unpaid'), picked('tx-X'))?.transactionId).toBeNull()
    expect(after(submitted('employee'), picked('tx-X'))?.transactionId).toBeNull()
  })

  it('whatever the person does, only a registration the company paid has a bank row, and it is the latest submit\'s own', () => {
    const steps: PendingRegistrationEvent[] = [
      submitted('company'),
      submitted('company', 'tx-known'),
      submitted('unpaid'),
      submitted('unpaid', 'tx-known'),
      submitted('owner'),
      picked('tx-X'),
      picked('tx-Y'),
    ]
    const sequences = (length: number): PendingRegistrationEvent[][] =>
      length === 0 ? [[]] : sequences(length - 1).flatMap((head) => steps.map((step) => [...head, step]))
    for (const sequence of sequences(4)) {
      const pending = after(...sequence)
      if (!pending || pending.transactionId === null) continue
      expect(pending.data.payer, JSON.stringify(sequence.map((e) => e.type))).toBe('company')
      // The row is the known one of the last submit, or one picked after it.
      const lastSubmit = sequence.map((e) => e.type).lastIndexOf('submitted')
      const own = sequence.slice(lastSubmit).flatMap((e) => (e.type === 'submitted' ? [e.knownTransactionId] : [e.transactionId]))
      expect(own).toContain(pending.transactionId)
    }
  })
})
