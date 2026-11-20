/**
 * One valid example of every request and response in the catalogue,
 * collections and delivery families. Synthetic only: the provider is the
 * fictional "Acme Inkasso", the personal identity number is the public test
 * number 19121212-1212, and no value belongs to a real customer.
 *
 * Both sides of the contract may import these in their own tests: the
 * installation for its fake adapter, the service for its routers.
 */
import type {
  CatalogueOperation,
  CatalogueResponse,
  CollectionsCase,
  CollectionsConnection,
  CollectionsDebtor,
  CollectionsDocumentInput,
  CollectionsFeatures,
  CollectionsInvoice,
  CollectionsOnboardingRequest,
  CollectionsOpenCaseRequest,
  CollectionsOperation,
  CollectionsSettlement,
  DeliveryFeatures,
  DeliveryOperation,
  DeliverySendRequest,
  ProviderProfile,
} from '../index'

export const TEST_PERSONAL_NUMBER = '191212121212'
export const TEST_ORG_NUMBER = '5561234567'

export const providerProfile: ProviderProfile = {
  ref: 'acme-inkasso',
  displayName: 'Acme Inkasso',
  legalName: 'Acme Inkasso AB',
  orgNumber: '5569999999',
  country: 'SE',
  termsUrl: 'https://acme-inkasso.example.com/villkor',
  termsVersion: '2026-10-01',
  privacyUrl: 'https://acme-inkasso.example.com/integritet',
  dpaUrl: null,
  dpaVersion: null,
  portalUrl: 'https://portal.acme-inkasso.example.com',
  supportUrl: null,
  termsSummarySv: 'Ingen bindningstid, en månads uppsägning.',
  feeSummarySv: 'Inkassobolaget behåller lagstadgade avgifter och dröjsmålsränta.',
}

export const collectionsFeatures: CollectionsFeatures = {
  startSteps: ['reminder', 'collection'],
  withdrawFreeDays: null,
  currencies: ['SEK'],
  debtorCountries: ['SE'],
  privateDebtors: true,
  minimumAmount: 100,
  settlementIsVatInvoice: false,
  stepApprovalAction: false,
}

export const deliveryFeatures: DeliveryFeatures = {
  methods: ['post', 'kivra', 'einvoice_bank'],
  payeeModes: ['creditor'],
  followUp: 'optional',
  maxDocumentChars: 3_500_000,
}

export const catalogueResponse: CatalogueResponse = {
  entries: [
    { capability: 'collections', provider: providerProfile, features: { ...collectionsFeatures } },
    { capability: 'delivery', provider: providerProfile, features: { ...deliveryFeatures } },
  ],
  serverTime: '2026-10-04T08:00:00.000Z',
}

export const address = {
  line1: 'Exempelgatan 1',
  line2: null,
  postalCode: '111 22',
  city: 'Stockholm',
  countryCode: 'SE',
}

export const businessDebtor: CollectionsDebtor = {
  kind: 'business',
  name: 'Kund AB',
  orgNumber: TEST_ORG_NUMBER,
  personalNumber: null,
  vatNumber: 'SE556123456701',
  customerNumber: '1001',
  accountingDebtorRef: '0b8a4c62-5d0e-4c55-9d43-5b7a1f3e9a10',
  email: 'ekonomi@kund.example.com',
  phone: null,
  address,
}

export const privateDebtor: CollectionsDebtor = {
  kind: 'private',
  name: 'Tolvan Tolvansson',
  orgNumber: null,
  personalNumber: TEST_PERSONAL_NUMBER,
  vatNumber: null,
  customerNumber: '1002',
  accountingDebtorRef: '6f1d2b7e-3a8c-4f0e-8b1d-2c9e7a4b5d60',
  email: null,
  phone: null,
  address,
}

export const documentInput: CollectionsDocumentInput = {
  filename: 'faktura-1042.pdf',
  contentType: 'application/pdf',
  base64: 'JVBERi0xLjQK',
  sha256: 'a'.repeat(64),
}

export const invoice: CollectionsInvoice = {
  ref: '9c3e1f20-7b4a-4d8e-a1c2-3e4f5a6b7c8d',
  number: '1042',
  issueDate: '2026-08-01',
  dueDate: '2026-08-31',
  currency: 'SEK',
  claimAmount: 1250,
  claimVatAmount: 250,
  claimRemaining: 1000,
  reference: 'Anna Andersson',
}

export const openCaseRequest: CollectionsOpenCaseRequest = {
  idempotencyKey: '2f6b8a1c-0d3e-4f5a-9b7c-8d9e0f1a2b3c',
  invoice,
  startStep: 'reminder',
  nextActionDate: null,
  reminderFeeAgreed: true,
  lateInterest: null,
  priorPayments: [{ paymentRef: '4a5b6c7d-8e9f-4a0b-8c1d-2e3f4a5b6c7d', date: '2026-09-02', amount: 250 }],
  priorCredits: [],
  debtor: businessDebtor,
  document: documentInput,
}

export const collectionsCase: CollectionsCase = {
  caseRef: '2f6b8a1c-0d3e-4f5a-9b7c-8d9e0f1a2b3c',
  caseNumber: 'A-1001',
  invoiceRef: invoice.ref,
  stage: 'reminder',
  isOpen: true,
  closeReason: null,
  decisionKind: null,
  providerState: 'ReminderStage',
  providerStateLabel: 'Påminnelse skickad',
  outstandingPrincipal: 1000,
  outstandingTotal: 1060,
  currency: 'SEK',
  nextActionDate: '2026-10-14',
  nextActionLabel: 'Inkassokrav',
  actions: ['pause', 'withdraw', 'dispute'],
  parentCaseRef: null,
  events: [
    { eventRef: 'ev-1', occurredAt: '2026-09-30T09:00:00Z', kind: 'letter', direction: 'to_debtor', label: 'Påminnelse skickad', amount: null },
  ],
  collectedPayments: [],
  reportedPayments: [{ paymentRef: '4a5b6c7d-8e9f-4a0b-8c1d-2e3f4a5b6c7d', amount: 250, matchedAmount: 250, date: '2026-09-02' }],
  documents: [{ documentRef: 'doc-1', type: 'letter_to_debtor', createdAt: '2026-09-30T09:00:00Z', filename: 'paminnelse.pdf' }],
  updatedAt: '2026-09-30T09:00:00Z',
  raw: { state: 'ReminderStage' },
}

export const connection: CollectionsConnection = {
  state: 'connecting',
  subStatus: 'awaiting_signature',
  providerStatus: 'AwaitingSignature',
  connectionHandle: 'opaque-handle-1',
  terms: { version: '2026-10-01', url: 'https://acme-inkasso.example.com/villkor', accepted: true },
  signers: [],
  settings: { approveBeforeLegalAction: true, approveBeforeCollectionNotice: true, minimumAmount: 100, deliveryEnabled: false },
  updatedAt: '2026-10-04T08:00:00Z',
}

export const onboardingRequest: CollectionsOnboardingRequest = {
  idempotencyKey: '7e8f9a0b-1c2d-4e3f-8a4b-5c6d7e8f9a0b:onboard',
  consent: { termsVersion: '2026-10-01', dpaVersion: null, consentedByName: 'Anna Andersson', consentedAt: '2026-10-04T08:00:00.000Z' },
  creditor: {
    kind: 'company',
    name: 'Säljare AB',
    orgNumber: '5560000001',
    personalNumber: null,
    vatRegistered: true,
    vatNumber: 'SE556000000101',
    email: 'ekonomi@saljare.example.com',
    phone: null,
    address,
    payout: { kind: 'bankgiro', number: '123-4567' },
  },
  kyc: {
    businessDescription: 'Konsulttjänster inom redovisning',
    invoicesAbroad: false,
    invoicesAbroadDescription: null,
    pep: false,
    pepDescription: null,
    sanctions: false,
    sanctionsDescription: null,
  },
  settings: { approveBeforeLegalAction: true, approveBeforeCollectionNotice: true, minimumAmount: 100, deliveryEnabled: false },
}

export const settlement: CollectionsSettlement = {
  settlementRef: 'settlement-1',
  paymentDate: '2026-10-02',
  amount: 937.5,
  currency: 'SEK',
  statusOk: true,
  settlementDate: '2026-10-01',
  statusCode: 'OK',
  bankReference: 'REF 123',
  lines: [
    {
      kind: 'principal',
      inPayout: true,
      amount: 1000,
      taxAmount: 0,
      recipient: 'creditor',
      caseRef: collectionsCase.caseRef,
      invoiceRef: invoice.ref,
      originalInvoiceRefs: [],
      providerType: 'Capital',
      description: null,
    },
    {
      kind: 'agency_commission',
      inPayout: true,
      amount: -50,
      taxAmount: -12.5,
      recipient: 'agency',
      caseRef: collectionsCase.caseRef,
      invoiceRef: invoice.ref,
      originalInvoiceRefs: [],
      providerType: 'Commission',
      description: 'Provision',
    },
  ],
  raw: { id: 'settlement-1' },
}

export const deliverySendRequest: DeliverySendRequest = {
  idempotencyKey: '5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f',
  method: 'kivra',
  invoice: { ...invoice, claimRemaining: invoice.claimAmount },
  debtor: privateDebtor,
  document: documentInput,
  followUp: null,
}

const document = { filename: 'specifikation.pdf', contentType: 'application/pdf', base64: 'JVBERi0xLjQK', sha256: 'b'.repeat(64) }

type OperationFixture = { request: unknown; response: unknown }

/** A valid request and response for every operation, keyed like the operation tables. */
export const CATALOGUE_FIXTURES = {
  list: { request: null, response: catalogueResponse },
} satisfies Record<CatalogueOperation, OperationFixture>

export const COLLECTIONS_FIXTURES = {
  connection: { request: {}, response: connection },
  onboard: { request: onboardingRequest, response: connection },
  cancelOnboarding: { request: { idempotencyKey: 'conn-1:cancel' }, response: { ...connection, state: 'disconnected', subStatus: null } },
  acceptTerms: {
    request: { idempotencyKey: 'conn-1:terms', termsVersion: '2026-10-01', acceptedByName: 'Anna Andersson', acceptedAt: '2026-10-04T08:05:00+02:00' },
    response: connection,
  },
  startSignature: {
    request: { idempotencyKey: 'conn-1:sign', signerEmail: 'vd@saljare.example.com', sendToSigner: false, redirectUrl: 'https://app.accounted.se/settings/collections', language: 'sv' },
    response: { signUrl: 'https://sign.acme-inkasso.example.com/s/abc', signers: ['Anna Andersson'] },
  },
  updateSettings: {
    request: { idempotencyKey: 'conn-1:settings:2', approveBeforeLegalAction: true, approveBeforeCollectionNotice: true, minimumAmount: 250, deliveryEnabled: true },
    response: connection,
  },
  disconnect: { request: { idempotencyKey: 'conn-1:disconnect' }, response: { ...connection, state: 'disconnected', subStatus: null } },
  openCase: { request: openCaseRequest, response: { acceptedAt: '2026-10-04T08:10:00Z', case: collectionsCase } },
  getCase: { request: { caseRef: collectionsCase.caseRef }, response: collectionsCase },
  caseAction: {
    request: { idempotencyKey: 'action-1', caseRef: collectionsCase.caseRef, action: 'pause', step: null, message: 'Kunden har hört av sig', until: '2026-10-20' },
    response: { ...collectionsCase, stage: 'paused' },
  },
  caseDocument: { request: { caseRef: collectionsCase.caseRef, documentRef: 'doc-1' }, response: document },
  registerPayment: {
    request: { idempotencyKey: 'forward-1', caseRef: collectionsCase.caseRef, paymentRef: 'payment-1', date: '2026-10-03', amount: 500, description: null },
    response: { accepted: true, providerRef: 'p-1', ignoredAmount: 0 },
  },
  revertPayment: {
    request: { idempotencyKey: 'forward-1:revert', caseRef: collectionsCase.caseRef, paymentRef: 'payment-1', date: '2026-10-03', amount: 500, description: 'Felmatchad' },
    response: { accepted: true, providerRef: 'p-1r', ignoredAmount: 0 },
  },
  registerCreditNote: {
    request: { idempotencyKey: 'forward-2', caseRef: collectionsCase.caseRef, creditRef: 'credit-1', date: '2026-10-03', amount: 125.5 },
    response: { accepted: true, providerRef: null, ignoredAmount: 0 },
  },
  changes: {
    request: { after: '1200', limit: 200 },
    response: {
      changes: [
        { seq: '1201', companyRef: 'company-1', kind: 'case', ref: collectionsCase.caseRef, changedAt: '2026-10-04T08:11:00Z' },
        { seq: '1202', companyRef: 'company-1', kind: 'settlement', ref: 'settlement-1', changedAt: '2026-10-04T08:12:00Z' },
      ],
      next: null,
    },
  },
  settlements: {
    request: { since: '2026-09-01' },
    response: [{ settlementRef: 'settlement-1', paymentDate: '2026-10-02', amount: 937.5, currency: 'SEK', statusOk: true }],
  },
  settlement: { request: { settlementRef: 'settlement-1' }, response: settlement },
  settlementDocument: { request: { settlementRef: 'settlement-1' }, response: document },
  settlementBooked: {
    request: { idempotencyKey: 'settlement-row-1:booked', settlementRef: 'settlement-1', internalRef: 'journal-entry-1' },
    response: null,
  },
} satisfies Record<CollectionsOperation, OperationFixture>

export const DELIVERY_FIXTURES = {
  methods: {
    request: { method: 'kivra', debtor: { kind: 'private', orgNumber: null, personalNumber: TEST_PERSONAL_NUMBER } },
    response: { method: 'kivra', reachable: true, reasonCode: null, checkedAt: '2026-10-04T08:00:00Z' },
  },
  send: {
    request: deliverySendRequest,
    response: { deliveryRef: 'delivery-1', acceptedAt: '2026-10-04T08:00:00Z', scheduledFor: null, case: null },
  },
  status: {
    request: { deliveryRef: 'delivery-1' },
    response: [{ state: 'delivered', method: 'kivra', occurredAt: '2026-10-04T09:00:00Z', detail: null }],
  },
} satisfies Record<DeliveryOperation, OperationFixture>
