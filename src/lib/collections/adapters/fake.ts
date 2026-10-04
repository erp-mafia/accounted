import { createHash } from 'node:crypto'
import {
  COLLECTIONS_MAX_DOCUMENT_CHARS,
  COLLECTIONS_OPERATIONS,
  type CollectionsAction,
  type CollectionsCase,
  type CollectionsCloseReason,
  type CollectionsConnection,
  type CollectionsDecisionKind,
  type CollectionsDocument,
  type CollectionsEvent,
  type CollectionsFeatures,
  type CollectionsOperation,
  type CollectionsReportedPayment,
  type CollectionsStage,
  type DeliveryFeatures,
  type ProviderProfile,
} from '@accounted/connect-contract'
import { CONNECTOR_REQUEST_INVALID_CODE } from '@/lib/connect/instance/connector-fetch'
import { roundOre } from '@/lib/money'
import { COLLECTIONS_NOT_FOUND, CollectionsError } from '../errors'
import type { CollectionsAdapter, CollectionsCallContext } from '../port'

/**
 * The deterministic fake collections provider. It runs in unit tests, in local
 * development (COLLECTIONS_FAKE_ADAPTER=1 outside production) and, in
 * production, for sandbox companies only (their connection row has route
 * 'fake'). It never talks to anything and never runs for a real company.
 *
 * Deterministic: a case's stage is a function of the time since it was
 * opened (the case handle carries the opening time, the start step and the
 * amounts), plus what was done to it. What was done (actions, reported
 * payments and credit notes) lives in a FakeCollectionsStore, a per-process
 * map by default: injected in tests, so the same inputs and the same store
 * give the same answers. Across processes a case falls back to its timeline,
 * which only a sandbox can notice.
 *
 * Timeline, in "fake minutes" (one real minute unless minuteMs says
 * otherwise), from the moment the case was opened:
 *   start step reminder:    0 registered, 1 reminder, 5 awaiting_decision
 *                           (approve_collection_notice: approval before every
 *                           collection notice is locked on in this version)
 *   start step collection:  0 registered, 1 collection
 *   delivered invoice:      invoice_sent until the `start` action
 * Actions follow the provider-neutral model: approve_step moves a waiting
 * case to collection, pause/resume, dispute/contest_dispute, withdraw closes
 * it as withdrawn, already_paid closes it as paid, approve_legal_action moves
 * it to enforcement. Payments and credit notes lower the principal; a case
 * whose principal reaches zero closes as paid or credited.
 *
 * Connection: before onboarding (no handle) the connection is
 * connecting/not_started; onboard answers awaiting_terms with a handle,
 * acceptTerms awaiting_signature, and once a signature was started every read
 * of the connection answers active. The ledger's own row is the record of
 * where activation stands; the fake only has to walk the steps.
 */

const FAKE_TERMS_VERSION = 'fake-2026-10'

export const FAKE_PROVIDER_PROFILE: ProviderProfile = {
  ref: 'acme-inkasso',
  displayName: 'Acme Inkasso',
  legalName: 'Acme Inkasso AB (testleverantör)',
  orgNumber: null,
  country: 'SE',
  termsUrl: null,
  termsVersion: FAKE_TERMS_VERSION,
  privacyUrl: null,
  dpaUrl: null,
  dpaVersion: null,
  portalUrl: null,
  supportUrl: null,
  termsSummarySv: 'Testleverantör: inget avtal tecknas och inget skickas till någon kund.',
  feeSummarySv: 'Testleverantör: inga avgifter.',
}

export const FAKE_COLLECTIONS_FEATURES: CollectionsFeatures = {
  startSteps: ['reminder', 'collection'],
  withdrawFreeDays: 14,
  currencies: ['SEK'],
  debtorCountries: ['SE'],
  privateDebtors: true,
  minimumAmount: 0,
  settlementIsVatInvoice: false,
  stepApprovalAction: true,
}

export const FAKE_DELIVERY_FEATURES: DeliveryFeatures = {
  methods: ['post', 'kivra', 'einvoice_bank'],
  payeeModes: ['creditor'],
  followUp: 'optional',
  maxDocumentChars: COLLECTIONS_MAX_DOCUMENT_CHARS,
}

/** The fee the fake adds to the outstanding total once a collection notice went out. */
export const FAKE_COLLECTION_FEE = 180

type FakeStep = 'reminder' | 'collection' | 'invoice'

type OverlayEntry =
  | { kind: 'action'; key: string; at: number; action: CollectionsAction; step: 'reminder' | 'collection' | null }
  | { kind: 'payment'; key: string; at: number; paymentRef: string; amount: number; date: string }
  | { kind: 'revert'; key: string; at: number; paymentRef: string }
  | { kind: 'credit'; key: string; at: number; creditRef: string; amount: number; date: string }

/** What was done to fake cases, keyed by case handle. */
export interface FakeCollectionsStore {
  cases: Map<string, OverlayEntry[]>
  /** openCase replays: idempotency key -> case handle. */
  opened: Map<string, string>
}

export function createFakeCollectionsStore(): FakeCollectionsStore {
  return { cases: new Map(), opened: new Map() }
}

const processStore = createFakeCollectionsStore()

export interface FakeCollectionsOptions {
  now?: () => Date
  /** Length of one timeline minute; tests shrink or stretch it. */
  minuteMs?: number
  store?: FakeCollectionsStore
}

const HANDLE_PREFIX = 'fake'
const STEP_CODES: Record<FakeStep, string> = { reminder: 'r', collection: 'c', invoice: 'i' }

interface CaseHandle {
  step: FakeStep
  openedAt: number
  claimAmount: number
  claimRemaining: number
  invoiceRef: string
}

/** `fake.<step>.<opened s base36>.<claim öre base36>.<remaining öre base36>.<invoice ref>`, at most 128 characters. */
export function encodeFakeCaseRef(handle: CaseHandle): string {
  return [
    HANDLE_PREFIX,
    STEP_CODES[handle.step],
    Math.floor(handle.openedAt / 1000).toString(36),
    Math.round(handle.claimAmount * 100).toString(36),
    Math.round(handle.claimRemaining * 100).toString(36),
    handle.invoiceRef,
  ].join('.')
}

export function decodeFakeCaseRef(caseRef: string): CaseHandle | null {
  const parts = caseRef.split('.')
  if (parts.length < 6 || parts[0] !== HANDLE_PREFIX) return null
  const step = (Object.keys(STEP_CODES) as FakeStep[]).find((s) => STEP_CODES[s] === parts[1])
  const openedSec = parseInt(parts[2], 36)
  const claimOre = parseInt(parts[3], 36)
  const remainingOre = parseInt(parts[4], 36)
  if (!step || ![openedSec, claimOre, remainingOre].every(Number.isFinite)) return null
  return {
    step,
    openedAt: openedSec * 1000,
    claimAmount: claimOre / 100,
    claimRemaining: remainingOre / 100,
    invoiceRef: parts.slice(5).join('.'),
  }
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** Refuse what Connect would refuse: the fake validates against the same contract. */
export function validateFakeRequest(operation: CollectionsOperation, body: unknown): void {
  const parsed = COLLECTIONS_OPERATIONS[operation].request.safeParse(body)
  if (parsed.success) return
  throw new CollectionsError(`Fake collections ${operation}: the request does not match the contract`, {
    code: CONNECTOR_REQUEST_INVALID_CODE,
    retryable: false,
    detail: parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; '),
  })
}

function notFound(what: string): CollectionsError {
  return new CollectionsError(`Fake collections: no such ${what}`, { code: COLLECTIONS_NOT_FOUND, retryable: false })
}

const STAGE_LABELS_SV: Record<CollectionsStage, string> = {
  registered: 'Registrerad',
  invoice_sent: 'Faktura skickad',
  reminder: 'Påminnelse skickad',
  collection: 'Inkassokrav skickat',
  awaiting_decision: 'Väntar på beslut',
  enforcement: 'Hos Kronofogden',
  payment_plan: 'Avbetalningsplan',
  monitoring: 'Bevakning',
  paused: 'Pausad',
  closed_paid: 'Betald',
  closed_other: 'Avslutad',
  unknown: 'Okänt läge',
}

interface CaseState {
  stage: CollectionsStage
  decisionKind: CollectionsDecisionKind | null
  closeReason: CollectionsCloseReason | null
  /** The stage (and pending decision) a pause or a dispute returns to. */
  resumeTo: CollectionsStage
  resumeDecision: CollectionsDecisionKind | null
  disputed: boolean
  collectionNoticeSent: boolean
  events: CollectionsEvent[]
  payments: Map<string, CollectionsReportedPayment>
  credits: number
}

function actionsFor(state: CaseState): CollectionsAction[] {
  switch (state.stage) {
    case 'invoice_sent':
      return ['start', 'withdraw']
    case 'registered':
      return ['pause', 'withdraw']
    case 'reminder':
    case 'collection':
      return ['pause', 'withdraw', 'dispute']
    case 'awaiting_decision':
      if (state.decisionKind === 'approve_collection_notice' || state.decisionKind === 'approve_reminder') {
        return ['approve_step', 'pause', 'withdraw']
      }
      if (state.decisionKind === 'legal_action') return ['approve_legal_action', 'decline_legal_action', 'withdraw']
      if (state.decisionKind === 'debtor_says_paid') return ['already_paid', 'confirm_not_paid']
      return ['withdraw']
    case 'paused':
      return state.disputed ? ['contest_dispute', 'withdraw'] : ['resume', 'withdraw']
    case 'enforcement':
      return ['withdraw']
    default:
      return []
  }
}

/**
 * The case as the fake provider sees it at `now`: the timeline's transitions
 * and the store's entries, applied in time order. A timeline transition only
 * fires from the stage it expects, so an action taken earlier wins.
 */
export function fakeCaseAt(
  caseRef: string,
  handle: CaseHandle,
  overlay: readonly OverlayEntry[],
  now: number,
  minuteMs: number,
): CollectionsCase {
  const state: CaseState = {
    stage: handle.step === 'invoice' ? 'invoice_sent' : 'registered',
    decisionKind: null,
    closeReason: null,
    resumeTo: 'registered',
    resumeDecision: null,
    disputed: false,
    collectionNoticeSent: false,
    events: [],
    payments: new Map(),
    credits: 0,
  }
  let seq = 0
  const record = (at: number, kind: CollectionsEvent['kind'], label: string, amount: number | null = null) => {
    seq += 1
    state.events.push({
      eventRef: `fake:${Math.floor(at / 1000).toString(36)}:${seq}`,
      occurredAt: new Date(at).toISOString(),
      kind,
      direction: kind === 'letter' ? 'to_debtor' : 'internal',
      label,
      amount,
    })
  }
  /** Move to a stage; a letter goes out only when a reminder or collection step is newly taken, not on a resume. */
  const moveTo = (at: number, stage: CollectionsStage, decisionKind: CollectionsDecisionKind | null = null, letter = true) => {
    state.stage = stage
    state.decisionKind = stage === 'awaiting_decision' ? decisionKind : null
    if (stage === 'collection') state.collectionNoticeSent = true
    record(at, letter && (stage === 'reminder' || stage === 'collection') ? 'letter' : 'stage', STAGE_LABELS_SV[stage])
  }
  const close = (at: number, stage: 'closed_paid' | 'closed_other', reason: CollectionsCloseReason) => {
    state.closeReason = reason
    moveTo(at, stage)
  }
  const principal = () =>
    roundOre(handle.claimRemaining - [...state.payments.values()].reduce((sum, p) => sum + p.amount, 0) - state.credits)

  type Step = { at: number; apply: () => void }
  const steps: Step[] = []
  const minute = (n: number) => handle.openedAt + n * minuteMs
  if (handle.step === 'reminder') {
    steps.push({ at: minute(1), apply: () => state.stage === 'registered' && moveTo(minute(1), 'reminder') })
    steps.push({
      at: minute(5),
      apply: () => state.stage === 'reminder' && moveTo(minute(5), 'awaiting_decision', 'approve_collection_notice'),
    })
  } else if (handle.step === 'collection') {
    steps.push({ at: minute(1), apply: () => state.stage === 'registered' && moveTo(minute(1), 'collection') })
  }

  for (const entry of overlay) {
    steps.push({
      at: entry.at,
      apply: () => {
        if (state.stage === 'closed_paid' || state.stage === 'closed_other') {
          // A revert can reopen a case closed as paid by payments; nothing else acts on a closed case.
          if (entry.kind !== 'revert' || state.closeReason !== 'paid') return
        }
        switch (entry.kind) {
          case 'payment':
            state.payments.set(entry.paymentRef, {
              paymentRef: entry.paymentRef,
              amount: entry.amount,
              matchedAmount: entry.amount,
              date: entry.date,
            })
            record(entry.at, 'payment', 'Betalning registrerad', entry.amount)
            if (principal() <= 0) close(entry.at, 'closed_paid', 'paid')
            return
          case 'revert': {
            const reverted = state.payments.get(entry.paymentRef)
            if (!reverted) return
            state.payments.delete(entry.paymentRef)
            record(entry.at, 'payment', 'Betalning återförd', -reverted.amount)
            if (state.stage === 'closed_paid' && principal() > 0) {
              state.closeReason = null
              moveTo(entry.at, state.collectionNoticeSent ? 'collection' : 'reminder', null, false)
            }
            return
          }
          case 'credit':
            state.credits = roundOre(state.credits + entry.amount)
            record(entry.at, 'payment', 'Kreditfaktura registrerad', entry.amount)
            if (principal() <= 0) close(entry.at, 'closed_other', 'credited')
            return
          case 'action':
            applyAction(entry.at, entry.action, entry.step)
        }
      },
    })
  }

  function applyAction(at: number, action: CollectionsAction, step: 'reminder' | 'collection' | null) {
    switch (action) {
      case 'start':
        moveTo(at, step === 'collection' ? 'collection' : 'reminder')
        return
      case 'approve_step':
        moveTo(at, 'collection')
        return
      case 'pause':
      case 'dispute':
        state.resumeTo = state.stage
        state.resumeDecision = state.decisionKind
        state.disputed = action === 'dispute'
        moveTo(at, 'paused')
        return
      case 'resume':
      case 'contest_dispute':
      case 'confirm_not_paid':
        state.disputed = false
        moveTo(at, state.resumeTo, state.resumeDecision, false)
        return
      case 'withdraw':
        close(at, 'closed_other', 'withdrawn')
        return
      case 'already_paid':
        close(at, 'closed_paid', 'paid')
        return
      case 'approve_legal_action':
        moveTo(at, 'enforcement')
        return
      case 'decline_legal_action':
        close(at, 'closed_other', 'other')
        return
    }
  }

  // Stable order: time, then timeline before the store at the same instant.
  steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step.at <= now)
    .sort((a, b) => a.step.at - b.step.at || a.index - b.index)
    .forEach(({ step }) => step.apply())

  const isOpen = state.stage !== 'closed_paid' && state.stage !== 'closed_other'
  const outstandingPrincipal = isOpen ? Math.max(0, principal()) : 0
  const fee = isOpen && state.collectionNoticeSent ? FAKE_COLLECTION_FEE : 0
  return {
    caseRef,
    caseNumber: `F-${(fnv1a(caseRef) % 1_000_000).toString().padStart(6, '0')}`,
    invoiceRef: handle.invoiceRef,
    stage: state.stage,
    isOpen,
    closeReason: isOpen ? null : state.closeReason,
    decisionKind: state.stage === 'awaiting_decision' ? state.decisionKind : null,
    providerState: `fake_${state.stage}`,
    providerStateLabel: STAGE_LABELS_SV[state.stage],
    outstandingPrincipal,
    outstandingTotal: roundOre(outstandingPrincipal + fee),
    currency: 'SEK',
    nextActionDate: null,
    nextActionLabel: null,
    actions: actionsFor(state),
    parentCaseRef: null,
    events: state.events,
    collectedPayments: [],
    reportedPayments: [...state.payments.values()],
    documents: [],
    updatedAt: new Date(Math.min(now, Math.max(handle.openedAt, ...state.events.map((e) => Date.parse(e.occurredAt))))).toISOString(),
    raw: { fake: true },
  }
}

/** A one-page placeholder PDF the fake answers document reads with. */
export function fakePdfDocument(filename: string): CollectionsDocument {
  const pdf = Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
    'latin1',
  )
  return {
    filename,
    contentType: 'application/pdf',
    base64: pdf.toString('base64'),
    sha256: createHash('sha256').update(pdf).digest('hex'),
  }
}

function fakeHandleFor(companyId: string): string {
  return `${HANDLE_PREFIX}-connection-${companyId}`
}

export function createFakeCollectionsAdapter(options: FakeCollectionsOptions = {}): CollectionsAdapter {
  const now = () => (options.now ? options.now() : new Date()).getTime()
  const minuteMs = options.minuteMs ?? 60_000
  const store = options.store ?? processStore

  function connectionState(
    ctx: CollectionsCallContext,
    patch: Partial<CollectionsConnection> = {},
  ): CollectionsConnection {
    const onboarded = ctx.connectionHandle !== null
    return {
      state: onboarded ? 'active' : 'connecting',
      subStatus: onboarded ? null : 'not_started',
      providerStatus: onboarded ? 'fake_active' : null,
      connectionHandle: ctx.connectionHandle,
      terms: onboarded ? { version: FAKE_TERMS_VERSION, url: null, accepted: true } : null,
      signers: [],
      settings: null,
      updatedAt: new Date(now()).toISOString(),
      ...patch,
    }
  }

  function caseHandle(caseRef: string): CaseHandle {
    const handle = decodeFakeCaseRef(caseRef)
    if (!handle) throw notFound('case')
    return handle
  }

  function readCase(caseRef: string): CollectionsCase {
    return fakeCaseAt(caseRef, caseHandle(caseRef), store.cases.get(caseRef) ?? [], now(), minuteMs)
  }

  /** Append an entry once per idempotency key; a replay changes nothing. */
  function append(caseRef: string, entry: OverlayEntry): void {
    const entries = store.cases.get(caseRef) ?? []
    if (entries.some((e) => e.key === entry.key)) return
    entries.push(entry)
    store.cases.set(caseRef, entries)
  }

  return {
    route: 'fake',

    async connection(ctx) {
      return connectionState(ctx)
    },
    async onboard(ctx, input) {
      validateFakeRequest('onboard', input)
      return connectionState(ctx, {
        state: 'connecting',
        subStatus: 'awaiting_terms',
        providerStatus: 'fake_awaiting_terms',
        connectionHandle: ctx.connectionHandle ?? fakeHandleFor(ctx.companyId),
        terms: { version: FAKE_TERMS_VERSION, url: null, accepted: false },
        settings: { ...input.settings },
      })
    },
    async cancelOnboarding(ctx, input) {
      validateFakeRequest('cancelOnboarding', input)
      return connectionState(ctx, { state: 'disconnected', subStatus: null, providerStatus: 'fake_cancelled' })
    },
    async acceptTerms(ctx, input) {
      validateFakeRequest('acceptTerms', input)
      return connectionState(ctx, {
        state: 'connecting',
        subStatus: 'awaiting_signature',
        providerStatus: 'fake_awaiting_signature',
        terms: { version: input.termsVersion, url: null, accepted: true },
      })
    },
    async startSignature(_ctx, input) {
      validateFakeRequest('startSignature', input)
      // Nothing to sign: the next read of the connection answers active.
      return { signUrl: null, signers: [] }
    },
    async updateSettings(ctx, input) {
      validateFakeRequest('updateSettings', input)
      const { idempotencyKey: _key, ...settings } = input
      return connectionState(ctx, { settings })
    },
    async disconnect(ctx, input) {
      validateFakeRequest('disconnect', input)
      return connectionState(ctx, { state: 'disconnected', subStatus: null, providerStatus: 'fake_disconnected' })
    },

    async openCase(_ctx, input) {
      validateFakeRequest('openCase', input)
      let caseRef = store.opened.get(input.idempotencyKey)
      if (!caseRef) {
        caseRef = encodeFakeCaseRef({
          step: input.startStep,
          openedAt: now(),
          claimAmount: input.invoice.claimAmount,
          claimRemaining: input.invoice.claimRemaining,
          invoiceRef: input.invoice.ref,
        })
        store.opened.set(input.idempotencyKey, caseRef)
      }
      const handle = caseHandle(caseRef)
      return { acceptedAt: new Date(handle.openedAt).toISOString(), case: readCase(caseRef) }
    },
    async getCase(_ctx, ref) {
      validateFakeRequest('getCase', ref)
      return readCase(ref.caseRef)
    },
    async caseAction(_ctx, input) {
      validateFakeRequest('caseAction', input)
      const current = readCase(input.caseRef)
      const replay = (store.cases.get(input.caseRef) ?? []).some((e) => e.key === input.idempotencyKey)
      if (!replay && !current.actions.includes(input.action)) {
        throw new CollectionsError(`Fake collections: ${input.action} is not offered in stage ${current.stage}`, {
          code: 'CONNECTOR_COLLECTIONS_ACTION_UNAVAILABLE',
          retryable: false,
        })
      }
      append(input.caseRef, { kind: 'action', key: input.idempotencyKey, at: now(), action: input.action, step: input.step })
      return readCase(input.caseRef)
    },
    async caseDocument(_ctx, input) {
      validateFakeRequest('caseDocument', input)
      caseHandle(input.caseRef)
      return fakePdfDocument(`${input.documentRef}.pdf`)
    },

    async registerPayment(_ctx, input) {
      validateFakeRequest('registerPayment', input)
      const before = readCase(input.caseRef)
      const ignoredAmount = roundOre(Math.max(0, input.amount - before.outstandingPrincipal))
      append(input.caseRef, {
        kind: 'payment',
        key: input.idempotencyKey,
        at: now(),
        paymentRef: input.paymentRef,
        amount: roundOre(input.amount - ignoredAmount),
        date: input.date,
      })
      return { accepted: true, providerRef: `fake-payment-${input.paymentRef}`, ignoredAmount }
    },
    async revertPayment(_ctx, input) {
      validateFakeRequest('revertPayment', input)
      caseHandle(input.caseRef)
      append(input.caseRef, { kind: 'revert', key: input.idempotencyKey, at: now(), paymentRef: input.paymentRef })
      return { accepted: true, providerRef: `fake-revert-${input.paymentRef}`, ignoredAmount: 0 }
    },
    async registerCreditNote(_ctx, input) {
      validateFakeRequest('registerCreditNote', input)
      caseHandle(input.caseRef)
      append(input.caseRef, {
        kind: 'credit',
        key: input.idempotencyKey,
        at: now(),
        creditRef: input.creditRef,
        amount: input.amount,
        date: input.date,
      })
      return { accepted: true, providerRef: `fake-credit-${input.creditRef}`, ignoredAmount: 0 }
    },

    async changes(input) {
      validateFakeRequest('changes', input)
      // No feed: the ledger re-reads fake cases itself (on-demand refresh and the daily safety net).
      return { changes: [], next: null }
    },

    async settlements(_ctx, input) {
      validateFakeRequest('settlements', input)
      // The fake debtor never pays the agency, so there is never a payout.
      return []
    },
    async settlement() {
      throw notFound('settlement')
    },
    async settlementDocument() {
      throw notFound('settlement')
    },
    async markSettlementBooked() {
      throw notFound('settlement')
    },
  }
}
