import { describe, it, expect } from 'vitest'
import { COLLECTIONS_OPERATIONS, type CollectionsSignatureStartRequest } from '@accounted/connect-contract'
import { COLLECTIONS_FIXTURES } from '../../../../packages/connect-contract/src/__tests__/fixtures'
import {
  createFakeCollectionsAdapter,
  createFakeCollectionsStore,
  decodeFakeCaseRef,
  encodeFakeCaseRef,
  FAKE_COLLECTION_FEE,
  type FakeCollectionsStore,
} from '../adapters/fake'
import type { CollectionsCallContext } from '../port'

const MINUTE = 60_000
const OPENED = Date.parse('2026-10-04T08:00:00Z')
const CTX: CollectionsCallContext = { companyId: 'company-1', connectionHandle: 'fake-connection-company-1' }
const OPEN = COLLECTIONS_FIXTURES.openCase.request

function clockAt(ms: number) {
  const clock = { now: ms }
  return { clock, now: () => new Date(clock.now) }
}

function setup(store: FakeCollectionsStore = createFakeCollectionsStore()) {
  const { clock, now } = clockAt(OPENED)
  const adapter = createFakeCollectionsAdapter({ now, store, minuteMs: MINUTE })
  return { adapter, clock, store }
}

describe('fake collections adapter: determinism', () => {
  it('answers the same for the same inputs, store and time, in two separate stores', async () => {
    const a = setup()
    const b = setup()
    const caseA = (await a.adapter.openCase(CTX, OPEN)).case
    const caseB = (await b.adapter.openCase(CTX, OPEN)).case
    expect(caseA).toEqual(caseB)
    a.clock.now = b.clock.now = OPENED + 7 * MINUTE
    expect(await a.adapter.getCase(CTX, { caseRef: caseA.caseRef })).toEqual(await b.adapter.getCase(CTX, { caseRef: caseB.caseRef }))
  })

  it('round-trips the case handle within the contract length', () => {
    const handle = { step: 'collection' as const, openedAt: OPENED, claimAmount: 1250.5, claimRemaining: 999.99, invoiceRef: 'x'.repeat(64) }
    const ref = encodeFakeCaseRef(handle)
    expect(ref.length).toBeLessThanOrEqual(128)
    expect(decodeFakeCaseRef(ref)).toEqual(handle)
    expect(decodeFakeCaseRef('not-a-fake-ref')).toBeNull()
  })

  it('answers a replayed openCase with the same case', async () => {
    const { adapter, clock } = setup()
    const first = await adapter.openCase(CTX, OPEN)
    clock.now += 3 * MINUTE
    const replay = await adapter.openCase(CTX, OPEN)
    expect(replay.case.caseRef).toBe(first.case.caseRef)
    expect(replay.acceptedAt).toBe(first.acceptedAt)
  })

  it('refuses a request the contract refuses, like Connect would', async () => {
    const { adapter } = setup()
    await expect(adapter.openCase(CTX, { ...OPEN, invoice: { ...OPEN.invoice, claimRemaining: 0 } })).rejects.toMatchObject({
      code: 'CONNECTOR_REQUEST_INVALID',
    })
  })

  it('every operation answers in the contract shape', async () => {
    const { adapter, clock } = setup()
    const opened = await adapter.openCase(CTX, OPEN)
    expect(COLLECTIONS_OPERATIONS.openCase.response.safeParse(opened).success).toBe(true)
    clock.now += 30 * MINUTE
    const read = await adapter.getCase(CTX, { caseRef: opened.case.caseRef })
    expect(COLLECTIONS_OPERATIONS.getCase.response.safeParse(read).success).toBe(true)
    expect(COLLECTIONS_OPERATIONS.connection.response.safeParse(await adapter.connection(CTX)).success).toBe(true)
    expect(COLLECTIONS_OPERATIONS.caseDocument.response.safeParse(await adapter.caseDocument(CTX, { caseRef: opened.case.caseRef, documentRef: 'letter-1' })).success).toBe(true)
    expect(await adapter.changes({ after: null })).toEqual({ changes: [], next: null })
    expect(await adapter.settlements(CTX, { since: '2026-09-01' })).toEqual([])
    await expect(adapter.settlement(CTX, { settlementRef: 's-1' })).rejects.toMatchObject({ code: 'COLLECTIONS_NOT_FOUND' })
  })
})

describe('fake collections adapter: timeline and actions', () => {
  it('walks a reminder handover to a waiting collection notice, then approval moves it to collection', async () => {
    const { adapter, clock } = setup()
    const { case: opened } = await adapter.openCase(CTX, OPEN)
    expect(opened).toMatchObject({ stage: 'registered', isOpen: true, outstandingPrincipal: 1000, actions: ['pause', 'withdraw'] })

    clock.now = OPENED + MINUTE
    expect((await adapter.getCase(CTX, opened)).stage).toBe('reminder')

    clock.now = OPENED + 5 * MINUTE
    const waiting = await adapter.getCase(CTX, opened)
    expect(waiting).toMatchObject({ stage: 'awaiting_decision', decisionKind: 'approve_collection_notice' })
    expect(waiting.actions).toContain('approve_step')

    const approved = await adapter.caseAction(CTX, { idempotencyKey: 'a-1', caseRef: opened.caseRef, action: 'approve_step', step: null, message: null, until: null })
    expect(approved).toMatchObject({ stage: 'collection', decisionKind: null, outstandingTotal: 1000 + FAKE_COLLECTION_FEE })
    // The approval is remembered on later reads.
    clock.now = OPENED + 60 * MINUTE
    expect((await adapter.getCase(CTX, opened)).stage).toBe('collection')
  })

  it('pauses and resumes back to the waiting decision', async () => {
    const { adapter, clock } = setup()
    const { case: opened } = await adapter.openCase(CTX, OPEN)
    clock.now = OPENED + 6 * MINUTE
    const paused = await adapter.caseAction(CTX, { idempotencyKey: 'p-1', caseRef: opened.caseRef, action: 'pause', step: null, message: null, until: null })
    expect(paused).toMatchObject({ stage: 'paused', actions: ['resume', 'withdraw'] })
    const resumed = await adapter.caseAction(CTX, { idempotencyKey: 'r-1', caseRef: opened.caseRef, action: 'resume', step: null, message: null, until: null })
    expect(resumed).toMatchObject({ stage: 'awaiting_decision', decisionKind: 'approve_collection_notice' })
  })

  it('withdraw closes the case for good, and an action the stage does not offer is refused', async () => {
    const { adapter, clock } = setup()
    const { case: opened } = await adapter.openCase(CTX, OPEN)
    clock.now = OPENED + 2 * MINUTE
    const withdrawn = await adapter.caseAction(CTX, { idempotencyKey: 'w-1', caseRef: opened.caseRef, action: 'withdraw', step: null, message: null, until: null })
    expect(withdrawn).toMatchObject({ stage: 'closed_other', isOpen: false, closeReason: 'withdrawn', actions: [], outstandingPrincipal: 0 })
    await expect(
      adapter.caseAction(CTX, { idempotencyKey: 'a-2', caseRef: opened.caseRef, action: 'approve_step', step: null, message: null, until: null }),
    ).rejects.toMatchObject({ code: 'CONNECTOR_COLLECTIONS_ACTION_UNAVAILABLE' })
    // A replay of the withdrawal under its own key is answered, not refused.
    await expect(
      adapter.caseAction(CTX, { idempotencyKey: 'w-1', caseRef: opened.caseRef, action: 'withdraw', step: null, message: null, until: null }),
    ).resolves.toMatchObject({ closeReason: 'withdrawn' })
  })

  it('starts a collection handover at the collection notice', async () => {
    const { adapter, clock } = setup()
    const { case: opened } = await adapter.openCase(CTX, { ...OPEN, idempotencyKey: 'case-c', startStep: 'collection' })
    clock.now = OPENED + MINUTE
    expect((await adapter.getCase(CTX, opened)).stage).toBe('collection')
  })
})

describe('fake collections adapter: money reported to the provider', () => {
  it('lowers the principal, acknowledges the payment, closes when paid and reopens on a revert', async () => {
    const { adapter, clock } = setup()
    const { case: opened } = await adapter.openCase(CTX, OPEN)
    clock.now = OPENED + 2 * MINUTE

    const partial = await adapter.registerPayment(CTX, { idempotencyKey: 'f-1', caseRef: opened.caseRef, paymentRef: 'pay-1', date: '2026-10-04', amount: 400, description: null })
    expect(partial).toEqual({ accepted: true, providerRef: 'fake-payment-pay-1', ignoredAmount: 0 })
    const afterPartial = await adapter.getCase(CTX, opened)
    expect(afterPartial.outstandingPrincipal).toBe(600)
    expect(afterPartial.reportedPayments).toEqual([{ paymentRef: 'pay-1', amount: 400, matchedAmount: 400, date: '2026-10-04' }])

    clock.now += 1000
    const rest = await adapter.registerPayment(CTX, { idempotencyKey: 'f-2', caseRef: opened.caseRef, paymentRef: 'pay-2', date: '2026-10-04', amount: 700, description: null })
    expect(rest.ignoredAmount).toBe(100)
    expect(await adapter.getCase(CTX, opened)).toMatchObject({ stage: 'closed_paid', closeReason: 'paid', isOpen: false })

    clock.now += 1000
    await adapter.revertPayment(CTX, { idempotencyKey: 'f-2:revert', caseRef: opened.caseRef, paymentRef: 'pay-2', date: '2026-10-04', amount: 600, description: null })
    expect(await adapter.getCase(CTX, opened)).toMatchObject({ stage: 'reminder', isOpen: true, outstandingPrincipal: 600 })
  })

  it('closes as credited when credit notes cover the principal, and a replayed report counts once', async () => {
    const { adapter, clock } = setup()
    const { case: opened } = await adapter.openCase(CTX, OPEN)
    clock.now = OPENED + 2 * MINUTE
    const note = { idempotencyKey: 'c-1', caseRef: opened.caseRef, creditRef: 'credit-1', date: '2026-10-04', amount: 500 }
    await adapter.registerCreditNote(CTX, note)
    await adapter.registerCreditNote(CTX, note)
    expect((await adapter.getCase(CTX, opened)).outstandingPrincipal).toBe(500)
    await adapter.registerCreditNote(CTX, { ...note, idempotencyKey: 'c-2', creditRef: 'credit-2' })
    expect(await adapter.getCase(CTX, opened)).toMatchObject({ stage: 'closed_other', closeReason: 'credited' })
  })

  it('answers a replayed payment with its first receipt, even after it paid the case off', async () => {
    const { adapter, clock } = setup()
    const { case: opened } = await adapter.openCase(CTX, OPEN)
    clock.now = OPENED + 2 * MINUTE
    const payment = { idempotencyKey: 'f-1', caseRef: opened.caseRef, paymentRef: 'pay-1', date: '2026-10-04', amount: 1000, description: null }
    const first = await adapter.registerPayment(CTX, payment)
    expect(first).toEqual({ accepted: true, providerRef: 'fake-payment-pay-1', ignoredAmount: 0 })
    expect(await adapter.getCase(CTX, opened)).toMatchObject({ stage: 'closed_paid', isOpen: false })

    clock.now += 1000
    expect(await adapter.registerPayment(CTX, payment)).toEqual(first)
    expect((await adapter.getCase(CTX, opened)).reportedPayments).toHaveLength(1)
  })
})

describe('fake collections adapter: connection', () => {
  it('walks not started, awaiting terms, awaiting signature, then active', async () => {
    const { adapter } = setup()
    const before = { companyId: 'company-1', connectionHandle: null }
    expect(await adapter.connection(before)).toMatchObject({ state: 'connecting', subStatus: 'not_started', connectionHandle: null })

    const onboarded = await adapter.onboard(before, COLLECTIONS_FIXTURES.onboard.request)
    expect(onboarded).toMatchObject({ state: 'connecting', subStatus: 'awaiting_terms', connectionHandle: 'fake-connection-company-1' })

    const ctx = { companyId: 'company-1', connectionHandle: onboarded.connectionHandle }
    expect(await adapter.acceptTerms(ctx, COLLECTIONS_FIXTURES.acceptTerms.request)).toMatchObject({ subStatus: 'awaiting_signature', terms: { accepted: true } })
    expect(await adapter.startSignature(ctx, COLLECTIONS_FIXTURES.startSignature.request as CollectionsSignatureStartRequest)).toEqual({ signUrl: null, signers: [] })
    expect(await adapter.connection(ctx)).toMatchObject({ state: 'active', subStatus: null })
    expect(await adapter.disconnect(ctx, COLLECTIONS_FIXTURES.disconnect.request)).toMatchObject({ state: 'disconnected' })
    expect(await adapter.connection(ctx)).toMatchObject({ state: 'disconnected' })
  })

  it('never lets a status read skip the terms or the signature', async () => {
    const { adapter } = setup()
    const onboarded = await adapter.onboard({ companyId: 'company-1', connectionHandle: null }, COLLECTIONS_FIXTURES.onboard.request)
    const ctx = { companyId: 'company-1', connectionHandle: onboarded.connectionHandle }
    expect(await adapter.connection(ctx)).toMatchObject({ state: 'connecting', subStatus: 'awaiting_terms', terms: { accepted: false } })

    // A signature started before the terms were accepted activates nothing.
    await adapter.startSignature(ctx, COLLECTIONS_FIXTURES.startSignature.request as CollectionsSignatureStartRequest)
    expect(await adapter.connection(ctx)).toMatchObject({ state: 'connecting', subStatus: 'awaiting_terms' })

    await adapter.acceptTerms(ctx, COLLECTIONS_FIXTURES.acceptTerms.request)
    expect(await adapter.connection(ctx)).toMatchObject({ state: 'connecting', subStatus: 'awaiting_signature' })

    // A replayed onboard does not move the connection back.
    await adapter.onboard(ctx, COLLECTIONS_FIXTURES.onboard.request)
    expect(await adapter.connection(ctx)).toMatchObject({ subStatus: 'awaiting_signature' })
  })

  it('starts over at the terms when a cancelled activation is onboarded again', async () => {
    const { adapter } = setup()
    const onboarded = await adapter.onboard({ companyId: 'company-1', connectionHandle: null }, COLLECTIONS_FIXTURES.onboard.request)
    const ctx = { companyId: 'company-1', connectionHandle: onboarded.connectionHandle }
    await adapter.cancelOnboarding(ctx, COLLECTIONS_FIXTURES.cancelOnboarding.request)
    expect(await adapter.connection(ctx)).toMatchObject({ state: 'disconnected' })
    await adapter.onboard({ companyId: 'company-1', connectionHandle: null }, COLLECTIONS_FIXTURES.onboard.request)
    expect(await adapter.connection(ctx)).toMatchObject({ state: 'connecting', subStatus: 'awaiting_terms' })
  })

  it('reads a handle this process has not seen as active (another server instance onboarded it)', async () => {
    const { adapter } = setup()
    expect(await adapter.connection({ companyId: 'company-1', connectionHandle: 'fake-connection-elsewhere' })).toMatchObject({ state: 'active' })
  })
})
