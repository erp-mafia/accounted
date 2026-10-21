import type { BankCheckView, CollectionReadinessView } from '../invoice-collection'

/** A bank check view: fresh and clean unless overridden. */
export function bankView(overrides: Partial<BankCheckView> = {}): BankCheckView {
  return {
    outcome: 'pass',
    freshness: 'fresh',
    lastSyncedAt: '2026-10-06T06:00:00.000Z',
    accounts: [{ name: 'Företagskonto', ledgerAccount: '1930', syncedAt: '2026-10-06T06:00:00.000Z', fresh: true, connected: true }],
    candidates: [],
    ...overrides,
  }
}

/** An unbooked bank row that may be the payment. */
export function bankCandidate(id: string, dismissed = false): BankCheckView['candidates'][number] {
  return { transactionId: id, date: '2026-10-01', amount: 500, description: 'Inbetalning', reason: 'name', dismissed }
}

/** The handover dialog's facts for an eligible, overdue business invoice with a clean bank. */
export function readinessView(overrides: Partial<CollectionReadinessView> = {}): CollectionReadinessView {
  return {
    eligible: true,
    blocks: [],
    hints: [],
    invoiceNumber: '1042',
    dueDate: '2026-09-01',
    overdueDays: 35,
    claim: { amount: 1250, vatAmount: 250, remaining: 1250 },
    rotRut: false,
    customer: { id: 'cust-1', name: 'Kund AB', kind: 'business', missingAddress: [], identity: 'not_needed' },
    deliveryAttestation: null,
    responseAttestation: null,
    reminderFee: { agreed: false, since: null },
    bankCheck: bankView(),
    startSteps: ['reminder', 'collection'],
    defaultStartStep: 'reminder',
    minimumAmount: 0,
    watching: false,
    withdrawFreeDays: 14,
    ...overrides,
  }
}
