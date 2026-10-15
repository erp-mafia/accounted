import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eventBus } from '@/lib/events'
import { openCollectionCase, priorPaymentsFor, retrySubmittedCase, submissionStaysOpen } from '../open-case'
import { handOverInvoice } from '../case-actions'
import { encodeFakeCaseRef } from '../adapters/fake'
import { CollectionsError } from '../errors'
import {
  CONNECTION_ID,
  createCaseWorld,
  CUSTOMER_ID,
  ENV_OFF,
  INVOICE_ID,
  MINUTE,
  OPENED_AT,
  refusedError,
  retryableError,
  TEST_DOCUMENT,
} from './case-fixtures'
import { ADMIN_ID, COMPANY_ID } from './memory-supabase'

vi.mock('../case-document', async () => {
  const { TEST_DOCUMENT: document } = await import('./case-fixtures')
  class HandoverDocumentError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message)
    }
  }
  return {
    HandoverDocumentError,
    resolveHandoverDocument: vi.fn(async () => document),
    readArchivedDocument: vi.fn(async (_db: unknown, _company: string, _id: string, sha?: string) => {
      if (sha && sha !== document.sha256) throw new HandoverDocumentError('COLLECTION_DOCUMENT_CHANGED', 'changed')
      return document
    }),
  }
})

const opened: unknown[] = []

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  opened.length = 0
  eventBus.on('collection.case_opened', async (payload) => {
    opened.push(payload)
  })
})

const HANDOVER = { invoiceId: INVOICE_ID, expectedRemaining: 1250 }

describe('openCollectionCase', () => {
  it('reserves the case, sends the invoice with the case id as the key and stores the provider snapshot', async () => {
    const world = await createCaseWorld()
    const outcome = await openCollectionCase(world.deps(), HANDOVER)
    if (!outcome.ok || outcome.dryRun) throw new Error(`expected a case, got ${JSON.stringify(outcome)}`)
    expect(outcome.registered).toBe(true)

    const [request] = world.openRequests
    expect(request.idempotencyKey).toBe(outcome.case.id)
    expect(request).toMatchObject({
      invoice: { ref: INVOICE_ID, number: '20261042', claimAmount: 1250, claimVatAmount: 250, claimRemaining: 1250, reference: 'Anna Andersson' },
      startStep: 'reminder',
      reminderFeeAgreed: false,
      lateInterest: null,
      priorPayments: [],
      priorCredits: [],
      debtor: { kind: 'business', orgNumber: '5560125790', personalNumber: null, accountingDebtorRef: CUSTOMER_ID },
      document: { filename: TEST_DOCUMENT.filename, sha256: TEST_DOCUMENT.sha256 },
    })

    const [row] = world.db.rows('collection_cases')
    expect(row).toMatchObject({
      company_id: COMPANY_ID,
      connection_id: CONNECTION_ID,
      origin: 'handover',
      submission_status: 'registered',
      submission_request: null,
      stage: 'registered',
      is_open: true,
      claim_amount: 1250,
      opened_by: ADMIN_ID,
    })
    expect((row.provider_case_ref as string).startsWith('fake.')).toBe(true)
    expect(row.bank_check).toMatchObject({ outcome: 'pass', delivered_outcome: 'delivered', attested_by: null })
    expect(opened).toEqual([
      expect.objectContaining({ caseId: row.id, invoiceId: INVOICE_ID, origin: 'handover', companyId: COMPANY_ID, userId: ADMIN_ID }),
    ])
  })

  it('checks everything again but sends nothing on a dry run', async () => {
    const world = await createCaseWorld()
    const outcome = await openCollectionCase(world.deps({ channel: 'agent' }), { ...HANDOVER, dryRun: true })
    expect(outcome).toMatchObject({ ok: true, dryRun: true, preview: { remaining_amount: 1250, bank_check: 'pass', provider: 'Acme Inkasso' } })
    expect(world.openRequests).toEqual([])
    expect(world.db.rows('collection_cases')).toEqual([])
  })

  it('answers the start gates before anything else', async () => {
    const world = await createCaseWorld()
    expect(await openCollectionCase(world.deps({ env: ENV_OFF }), HANDOVER)).toMatchObject({ ok: false, code: 'COLLECTIONS_DISABLED', status: 503 })
    expect(await openCollectionCase(world.deps({ facts: world.facts({ capability: false }) }), HANDOVER)).toMatchObject({
      ok: false,
      code: 'CAPABILITY_REQUIRED',
      status: 403,
    })
    expect(world.openRequests).toEqual([])
  })

  it('refuses when what is still owed changed since the dialog opened', async () => {
    const world = await createCaseWorld({ invoice: { status: 'partially_paid', paid_amount: 250, remaining_amount: 1000 } })
    expect(await openCollectionCase(world.deps(), HANDOVER)).toMatchObject({
      ok: false,
      code: 'COLLECTION_REMAINING_CHANGED',
      status: 409,
      details: { remaining: 1000 },
    })
    expect(world.db.rows('collection_cases')).toEqual([])
  })

  it('refuses while an unbooked bank row may be the payment, until a person dismisses it', async () => {
    const world = await createCaseWorld()
    world.db.seed('transactions', [
      {
        id: 'tx-1',
        company_id: COMPANY_ID,
        date: '2026-09-20',
        amount: 1250,
        description: 'Betalning 20261042',
        original_description: null,
        merchant_name: null,
        reference: null,
        potential_invoice_id: null,
        is_ignored: false,
        invoice_id: null,
        supplier_invoice_id: null,
        journal_entry_id: null,
        is_business: true,
      },
    ])
    expect(await openCollectionCase(world.deps(), HANDOVER)).toMatchObject({
      ok: false,
      code: 'COLLECTION_BANK_CANDIDATES',
      details: { candidates: ['tx-1'] },
    })
    const outcome = await openCollectionCase(world.deps(), { ...HANDOVER, dismissedTransactionIds: ['tx-1'] })
    expect(outcome).toMatchObject({ ok: true, registered: true })
    expect(world.db.rows('collection_cases')[0].bank_check).toMatchObject({ dismissed: [{ transaction_id: 'tx-1', by: ADMIN_ID }] })
  })

  it('takes attestations only from a person in the web UI', async () => {
    const world = await createCaseWorld()
    expect(await openCollectionCase(world.deps({ channel: 'agent' }), { ...HANDOVER, attestations: { bank: true } })).toMatchObject({
      ok: false,
      code: 'COLLECTION_ATTESTATION_WEB_ONLY',
      status: 403,
    })
    // "Not a payment of this invoice" is a person's word too.
    expect(await openCollectionCase(world.deps({ channel: 'agent' }), { ...HANDOVER, dismissedTransactionIds: ['tx-1'] })).toMatchObject({
      ok: false,
      code: 'COLLECTION_ATTESTATION_WEB_ONLY',
    })
    expect(world.db.rows('collection_cases')).toEqual([])
  })

  it('asks a person to attest a bank not synced in 24 hours, and refuses an agent', async () => {
    const world = await createCaseWorld()
    world.db.rows('bank_connections')[0].last_synced_at = new Date(OPENED_AT - 30 * 3_600_000).toISOString()
    expect(await openCollectionCase(world.deps(), HANDOVER)).toMatchObject({
      ok: false,
      code: 'COLLECTION_ATTESTATION_REQUIRED',
      details: { attestations: ['bank'] },
    })
    expect(await openCollectionCase(world.deps({ channel: 'agent' }), HANDOVER)).toMatchObject({ ok: false, code: 'COLLECTION_BANK_STALE' })
    const attested = await openCollectionCase(world.deps(), { ...HANDOVER, attestations: { bank: true } })
    expect(attested).toMatchObject({ ok: true, registered: true })
    expect(world.db.rows('collection_cases')[0].bank_check).toMatchObject({ outcome: 'stale', attested_by: ADMIN_ID })
  })

  it('needs the import attestation for an invoice without delivery history; an agent cannot give it', async () => {
    const world = await createCaseWorld()
    world.db.tables.set('invoice_deliveries', [])
    expect(await openCollectionCase(world.deps(), HANDOVER)).toMatchObject({
      ok: false,
      code: 'COLLECTION_ATTESTATION_REQUIRED',
      details: { attestations: ['imported'] },
    })
    expect(await openCollectionCase(world.deps({ channel: 'agent' }), HANDOVER)).toMatchObject({
      ok: false,
      code: 'COLLECTION_ATTESTATION_WEB_ONLY',
      details: { attestations: ['imported'] },
    })
    const outcome = await openCollectionCase(world.deps(), { ...HANDOVER, attestations: { imported: true } })
    expect(outcome).toMatchObject({ ok: true })
    expect(world.db.rows('collection_cases')[0].bank_check).toMatchObject({ delivered_outcome: 'attested', imported_attestation: true })
  })

  it('refuses an ineligible invoice with its checklist', async () => {
    const world = await createCaseWorld({ invoice: { due_date: '2026-10-30' } })
    expect(await openCollectionCase(world.deps(), HANDOVER)).toMatchObject({
      ok: false,
      code: 'COLLECTION_NOT_ELIGIBLE',
      details: { blocks: [{ code: 'elig_not_overdue' }] },
    })
  })

  it('refuses a customer marked "Skicka aldrig till inkasso" before anything is reserved or sent', async () => {
    const world = await createCaseWorld({ customer: { collections_excluded: true } })
    expect(await openCollectionCase(world.deps(), HANDOVER)).toMatchObject({
      ok: false,
      code: 'COLLECTION_NOT_ELIGIBLE',
      details: { blocks: [{ code: 'debtor_excluded' }] },
    })
    expect(world.db.rows('collection_cases')).toHaveLength(0)
    expect(world.openRequests).toHaveLength(0)
  })

  it('reports earlier payments, including what the previous system recorded without a payment row', async () => {
    const world = await createCaseWorld({ invoice: { status: 'partially_paid', paid_amount: 500, paid_at: '2026-09-01T00:00:00Z', remaining_amount: 750 } })
    world.db.seed('invoice_payments', [{ id: 'pay-1', company_id: COMPANY_ID, invoice_id: INVOICE_ID, payment_date: '2026-09-10', amount: 300, transaction_id: null }])
    const outcome = await openCollectionCase(world.deps(), { ...HANDOVER, expectedRemaining: 750 })
    expect(outcome).toMatchObject({ ok: true })
    expect(world.openRequests[0].priorPayments).toEqual([
      { paymentRef: 'pay-1', date: '2026-09-10', amount: 300 },
      { paymentRef: `${INVOICE_ID}:prior`, date: '2026-09-01', amount: 200 },
    ])
    expect(world.openRequests[0].invoice.claimRemaining).toBe(750)
  })

  it('hands over a Swedish customer whose country is stored as a name, with the debtor address in ISO code', async () => {
    const world = await createCaseWorld({ customer: { country: 'Sverige' } })
    expect(await openCollectionCase(world.deps(), HANDOVER)).toMatchObject({ ok: true, registered: true })
    expect(world.openRequests[0].debtor.address.countryCode).toBe('SE')
  })

  it('sends a consumer personnummer in transit only, and hands a consumer over without one', async () => {
    const consumer = { customer_type: 'individual', org_number: null, personal_number: '19800101-1231' }
    const world = await createCaseWorld({ customer: consumer })
    world.openFailures.push(retryableError())
    const outcome = await openCollectionCase(world.deps(), HANDOVER)
    expect(outcome).toMatchObject({ ok: true, registered: false })
    expect(world.openRequests[0].debtor).toMatchObject({ kind: 'private', personalNumber: '198001011231', orgNumber: null })
    const stored = world.db.rows('collection_cases')[0].submission_request as Record<string, never>
    expect(JSON.stringify(stored)).not.toContain('198001011231')
    expect(JSON.stringify(stored)).not.toContain(TEST_DOCUMENT.base64)
    expect(stored).toMatchObject({ personalNumberSent: true, documentId: TEST_DOCUMENT.documentId })

    const without = await createCaseWorld({ customer: { ...consumer, personal_number: null } })
    expect(await openCollectionCase(without.deps(), HANDOVER)).toMatchObject({ ok: true, registered: true })
    expect(without.openRequests[0].debtor).toMatchObject({ kind: 'private', personalNumber: null })
  })

  it('leaves a timed-out handover submitted, and the retry repeats the exact request with the same key', async () => {
    const consumer = { customer_type: 'individual', org_number: null, personal_number: '19800101-1231' }
    const world = await createCaseWorld({ customer: consumer })
    world.openFailures.push(retryableError())
    const first = await openCollectionCase(world.deps(), HANDOVER)
    if (!first.ok || first.dryRun) throw new Error('expected a case')
    expect(first.registered).toBe(false)
    expect(world.db.rows('collection_cases')[0]).toMatchObject({ submission_status: 'submitted', sync_error: 'CONNECTOR_UNREACHABLE', is_open: true })
    expect(opened).toEqual([])

    world.clock.now += 5 * MINUTE
    const retried = await retrySubmittedCase({ db: world.db.client, adapterFor: () => world.adapter, now: world.now }, first.case.id)
    expect(retried).toMatchObject({ registered: true })
    expect(world.openRequests).toHaveLength(2)
    expect(world.openRequests[1]).toEqual(world.openRequests[0])
    expect(world.db.rows('collection_cases')[0]).toMatchObject({ submission_status: 'registered', submission_request: null, sync_error: null, submission_attempts: 2 })
    expect(opened).toHaveLength(1)
  })

  it('closes a refused handover as failed and answers with the provider code', async () => {
    const world = await createCaseWorld()
    world.openFailures.push(refusedError())
    const outcome = await openCollectionCase(world.deps(), HANDOVER)
    expect(outcome).toMatchObject({ ok: false, code: 'CONNECTOR_COLLECTIONS_DEBTOR_INVALID', status: 422 })
    expect(world.db.rows('collection_cases')[0]).toMatchObject({
      submission_status: 'failed',
      is_open: false,
      submission_request: null,
      sync_error: 'CONNECTOR_COLLECTIONS_DEBTOR_INVALID',
    })
    expect(world.db.rows('collection_case_events')).toMatchObject([{ kind: 'sync_error', label: 'CONNECTOR_COLLECTIONS_DEBTOR_INVALID' }])
    // A new handover of the same invoice is a new case.
    expect(await openCollectionCase(world.deps(), HANDOVER)).toMatchObject({ ok: true, registered: true })
    expect(world.db.rows('collection_cases')).toHaveLength(2)
  })

  it('never closes a handover the provider may hold: an unreadable answer stays submitted', async () => {
    const world = await createCaseWorld()
    world.openFailures.push(new CollectionsError('shape', { code: 'CONNECTOR_PROTOCOL_ERROR', retryable: false }))
    expect(await openCollectionCase(world.deps(), HANDOVER)).toMatchObject({ ok: true, registered: false })
    expect(world.db.rows('collection_cases')[0]).toMatchObject({ submission_status: 'submitted', is_open: true, sync_error: 'CONNECTOR_PROTOCOL_ERROR' })
    expect(submissionStaysOpen({ code: 'CONNECTOR_IDEMPOTENCY_MISMATCH', retryable: false })).toBe(true)
    expect(submissionStaysOpen({ code: 'CONNECTOR_COLLECTIONS_DEBTOR_INVALID', retryable: false })).toBe(false)
  })

  it('refuses a second handover while the first is open', async () => {
    const world = await createCaseWorld()
    expect(await openCollectionCase(world.deps(), HANDOVER)).toMatchObject({ ok: true })
    expect(await openCollectionCase(world.deps(), HANDOVER)).toMatchObject({
      ok: false,
      code: 'COLLECTION_NOT_ELIGIBLE',
      details: { blocks: [{ code: 'elig_open_case' }] },
    })
  })

  it('refuses a second handover while the provider closed the first as paid and the payment is not booked', async () => {
    const world = await createCaseWorld()
    expect(await openCollectionCase(world.deps(), HANDOVER)).toMatchObject({ ok: true })
    // The provider collected the claim and closed the case; the books still show the invoice owed.
    Object.assign(world.db.rows('collection_cases')[0], { is_open: false, stage: 'closed_paid', close_reason: 'paid', actions: [] })
    expect(await openCollectionCase(world.deps(), HANDOVER)).toMatchObject({
      ok: false,
      code: 'COLLECTION_NOT_ELIGIBLE',
      details: { blocks: [{ code: 'elig_collected_unbooked' }] },
    })
    expect(world.db.rows('collection_cases')).toHaveLength(1)
  })

  it('answers COLLECTIONS_UNAVAILABLE before reserving when the installation has no adapter for the route', async () => {
    const world = await createCaseWorld()
    expect(await openCollectionCase(world.deps({ adapterFor: () => null }), HANDOVER)).toMatchObject({ ok: false, code: 'COLLECTIONS_UNAVAILABLE' })
    expect(world.db.rows('collection_cases')).toEqual([])
  })
})

describe('handOverInvoice on a delivered invoice the provider watches', () => {
  it('starts reminders on the same claim instead of opening a second case', async () => {
    const world = await createCaseWorld()
    const caseRef = encodeFakeCaseRef({ step: 'invoice', openedAt: OPENED_AT, claimAmount: 1250, claimRemaining: 1250, invoiceRef: INVOICE_ID })
    world.db.seed('collection_cases', [
      {
        id: 'case-watch',
        company_id: COMPANY_ID,
        invoice_id: INVOICE_ID,
        connection_id: CONNECTION_ID,
        origin: 'distribution',
        start_step: 'invoice',
        submission_status: 'registered',
        submission_request: null,
        submission_attempts: 1,
        provider_case_ref: caseRef,
        provider_case_number: null,
        parent_case_ref: null,
        stage: 'invoice_sent',
        decision_kind: null,
        is_open: true,
        close_reason: null,
        actions: ['start', 'withdraw'],
        claim_amount: 1250,
        outstanding_principal: 1250,
        outstanding_total: 1250,
        bank_check: {},
        opened_by: ADMIN_ID,
        opened_at: new Date(OPENED_AT).toISOString(),
        closed_at: null,
        last_synced_at: null,
        sync_error: null,
        paused_by_sweep: false,
        last_bank_checked_at: null,
        created_at: new Date(OPENED_AT).toISOString(),
        updated_at: new Date(OPENED_AT).toISOString(),
      },
    ])
    world.clock.now += 2 * MINUTE
    const outcome = await handOverInvoice(world.deps(), { ...HANDOVER, startStep: 'reminder' })
    expect(outcome).toMatchObject({ ok: true, case: { id: 'case-watch', stage: 'reminder' } })
    expect(world.openRequests).toEqual([])
    expect(world.db.rows('collection_cases')).toHaveLength(1)
    expect(world.db.rows('collection_cases')[0].last_bank_checked_at).not.toBeNull()
  })
})

describe('priorPaymentsFor', () => {
  const invoice = { id: 'inv', paid_amount: 0, paid_at: null, invoice_date: '2026-08-01' } as never
  it('refuses a history it cannot report: a negative row, or rows above what was paid', () => {
    expect(priorPaymentsFor({ invoice, payments: [{ id: 'p', payment_date: '2026-09-01', amount: -5 }] })).toBeNull()
    expect(priorPaymentsFor({ invoice, payments: [{ id: 'p', payment_date: '2026-09-01', amount: 5 }] })).toBeNull()
  })
})
