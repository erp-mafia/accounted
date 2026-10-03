import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  CATALOGUE_CAPABILITIES,
  CATALOGUE_FEATURE_SCHEMAS,
  CATALOGUE_OPERATIONS,
  CATALOGUE_PATH,
  COLLECTIONS_BASE_PATH,
  COLLECTIONS_MAX_DOCUMENT_CHARS,
  COLLECTIONS_OPERATIONS,
  COLLECTIONS_START_ACTIONS,
  COLLECTIONS_START_OPERATIONS,
  CONNECTOR_ERROR_CODES,
  CONNECTOR_HEADERS,
  CONTRACT_VERSION,
  DELIVERY_BASE_PATH,
  DELIVERY_OPERATIONS,
  catalogueEntrySchema,
  catalogueResponseSchema,
  collectionsActionSchema,
  collectionsCaseActionRequestSchema,
  collectionsCaseSchema,
  collectionsChangesRequestSchema,
  collectionsConnectionSchema,
  collectionsDebtorSchema,
  collectionsDocumentInputSchema,
  collectionsOnboardingRequestSchema,
  collectionsOpenCaseRequestSchema,
  collectionsSettingsUpdateRequestSchema,
  collectionsSignatureStartRequestSchema,
  collectionsTermsAcceptRequestSchema,
  providerProfileSchema,
} from '../index'
import {
  CATALOGUE_FIXTURES,
  COLLECTIONS_FIXTURES,
  DELIVERY_FIXTURES,
  businessDebtor,
  catalogueResponse,
  collectionsCase,
  collectionsFeatures,
  connection,
  deliveryFeatures,
  documentInput,
  onboardingRequest,
  openCaseRequest,
  privateDebtor,
  providerProfile,
} from './fixtures'

type OperationTable = Record<string, { method: string; path: string; company: boolean; request: { safeParse: (v: unknown) => { success: boolean } }; response: { safeParse: (v: unknown) => { success: boolean } } }>

const FAMILIES: Array<[string, OperationTable, Record<string, { request: unknown; response: unknown }>]> = [
  ['catalogue', CATALOGUE_OPERATIONS, CATALOGUE_FIXTURES],
  ['collections', COLLECTIONS_OPERATIONS, COLLECTIONS_FIXTURES],
  ['delivery', DELIVERY_OPERATIONS, DELIVERY_FIXTURES],
]

const openCase = (patch: Record<string, unknown>) => collectionsOpenCaseRequestSchema.safeParse({ ...openCaseRequest, ...patch })
const withInvoice = (patch: Record<string, unknown>) => openCase({ invoice: { ...openCaseRequest.invoice, ...patch } })

describe('contract constants for the provider capabilities', () => {
  it('moves the version forward as a date', () => {
    expect(CONTRACT_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(CONTRACT_VERSION > '2026-09-29').toBe(true)
  })

  it('adds the version and connection headers without touching the existing ones', () => {
    expect(CONNECTOR_HEADERS).toEqual({
      company: 'X-Connector-Company',
      upstreamAuthorization: 'X-Connector-Upstream-Authorization',
      upstreamContentType: 'X-Connector-Upstream-Content-Type',
      contractVersion: 'X-Connect-Contract-Version',
      connection: 'X-Connector-Connection',
    })
    expect(CATALOGUE_PATH).toBe('/api/connect/catalogue')
    expect(COLLECTIONS_BASE_PATH).toBe('/api/connect/collections')
    expect(DELIVERY_BASE_PATH).toBe('/api/connect/delivery')
  })

  it('appends the new error codes and keeps every code unique', () => {
    for (const code of [
      'CONNECTOR_CONTRACT_VERSION_UNSUPPORTED',
      'CONNECTOR_IDEMPOTENCY_MISMATCH',
      'CONNECTOR_IDEMPOTENCY_IN_FLIGHT',
      'CONNECTOR_UPSTREAM_DISABLED',
      'CONNECTOR_CONNECTION_NOT_OWNED',
      'CONNECTOR_COLLECTIONS_NOT_ONBOARDED',
      'CONNECTOR_COLLECTIONS_NOT_APPROVED',
      'CONNECTOR_COLLECTIONS_CASE_NOT_OWNED',
      'CONNECTOR_COLLECTIONS_ACTION_UNAVAILABLE',
      'CONNECTOR_COLLECTIONS_DEBTOR_INVALID',
      'CONNECTOR_COLLECTIONS_DUPLICATE_CASE',
      'CONNECTOR_COLLECTIONS_AMOUNT_INVALID',
      'CONNECTOR_DELIVERY_METHOD_UNAVAILABLE',
      'CONNECTOR_DELIVERY_DOCUMENT_REJECTED',
    ]) {
      expect(CONNECTOR_ERROR_CODES).toContain(code)
    }
    expect(CONNECTOR_ERROR_CODES[0]).toBe('BAD_REQUEST')
    expect(CONNECTOR_ERROR_CODES).toContain('PEPPOL_DUPLICATE_INVOICE_NUMBER')
    expect(new Set(CONNECTOR_ERROR_CODES).size).toBe(CONNECTOR_ERROR_CODES.length)
  })
})

describe('operation tables', () => {
  it.each(FAMILIES)('%s: every operation has a method, a relative path and both schemas', (_family, table) => {
    const routes = new Set<string>()
    for (const [name, op] of Object.entries(table)) {
      expect(['GET', 'POST', 'PUT', 'DELETE'], name).toContain(op.method)
      expect(op.path === '' || op.path.startsWith('/'), name).toBe(true)
      expect(typeof op.company, name).toBe('boolean')
      expect(typeof op.request.safeParse, name).toBe('function')
      expect(typeof op.response.safeParse, name).toBe('function')
      routes.add(`${op.method} ${op.path}`)
    }
    expect(routes.size).toBe(Object.keys(table).length)
  })

  it.each(FAMILIES)('%s: every operation parses its request and response fixture', (_family, table, fixtures) => {
    expect(Object.keys(fixtures).sort()).toEqual(Object.keys(table).sort())
    for (const [name, op] of Object.entries(table)) {
      expect(op.request.safeParse(fixtures[name].request).success, `${name} request`).toBe(true)
      expect(op.response.safeParse(fixtures[name].response).success, `${name} response`).toBe(true)
    }
  })

  it('only the change feed is key-wide among the company operations', () => {
    const keyWide = Object.entries(COLLECTIONS_OPERATIONS).filter(([, op]) => !op.company).map(([name]) => name)
    expect(keyWide).toEqual(['changes'])
    expect(Object.values(DELIVERY_OPERATIONS).every((op) => op.company)).toBe(true)
    expect(CATALOGUE_OPERATIONS.list.company).toBe(false)
  })

  it('splits start work from obligations: the start lists are subsets, cancelling is never a start', () => {
    const operations = Object.keys(COLLECTIONS_OPERATIONS)
    for (const op of COLLECTIONS_START_OPERATIONS) expect(operations).toContain(op)
    for (const action of COLLECTIONS_START_ACTIONS) expect(collectionsActionSchema.options).toContain(action)
    expect(COLLECTIONS_START_OPERATIONS).not.toContain('cancelOnboarding')
    expect(COLLECTIONS_START_OPERATIONS).not.toContain('caseAction')
    expect(COLLECTIONS_START_ACTIONS).toEqual(['start', 'approve_step'])
  })
})

describe('unknown keys', () => {
  it('are stripped from requests and responses, so neither side breaks on a newer peer', () => {
    const request = collectionsOpenCaseRequestSchema.parse({
      ...openCaseRequest,
      somethingNew: 1,
      debtor: { ...businessDebtor, birthDate: '1990-01-01' },
    })
    expect(request).not.toHaveProperty('somethingNew')
    expect(request.debtor).not.toHaveProperty('birthDate')

    const response = collectionsCaseSchema.parse({ ...collectionsCase, futureField: true })
    expect(response).not.toHaveProperty('futureField')
  })
})

describe('debtor identity', () => {
  it('refuses malformed org and personal identity numbers', () => {
    for (const orgNumber of ['556123456', '556123-4567', '55612345678', 'abcdefghij']) {
      expect(collectionsDebtorSchema.safeParse({ ...businessDebtor, orgNumber }).success, orgNumber).toBe(false)
    }
    for (const personalNumber of ['1212121212', '19121212-1212', '121212-1212', '1912121212121']) {
      expect(collectionsDebtorSchema.safeParse({ ...privateDebtor, personalNumber }).success, personalNumber).toBe(false)
    }
  })

  it('requires the org number of a Swedish business and the personal number of a Swedish private person', () => {
    expect(openCase({ debtor: { ...businessDebtor, orgNumber: null } }).success).toBe(false)
    expect(openCase({ debtor: { ...privateDebtor, personalNumber: null } }).success).toBe(false)
    expect(openCase({ debtor: privateDebtor }).success).toBe(true)
    const foreign = { ...businessDebtor, orgNumber: null, address: { ...businessDebtor.address, countryCode: 'NO' } }
    expect(openCase({ debtor: foreign }).success).toBe(true)
  })

  it('takes country codes in upper case only', () => {
    expect(openCase({ debtor: { ...businessDebtor, address: { ...businessDebtor.address, countryCode: 'se' } } }).success).toBe(false)
  })
})

describe('document', () => {
  it('accepts a PDF up to the size cap and refuses anything larger', () => {
    const atCap = 'A'.repeat(COLLECTIONS_MAX_DOCUMENT_CHARS)
    expect(collectionsDocumentInputSchema.safeParse({ ...documentInput, base64: atCap }).success).toBe(true)
    expect(collectionsDocumentInputSchema.safeParse({ ...documentInput, base64: `${atCap}AAAA` }).success).toBe(false)
  })

  it('refuses another content type, a non-base64 body and a sha256 that is not lower-case hex', () => {
    expect(collectionsDocumentInputSchema.safeParse({ ...documentInput, contentType: 'image/png' }).success).toBe(false)
    expect(collectionsDocumentInputSchema.safeParse({ ...documentInput, base64: 'not base64!' }).success).toBe(false)
    expect(collectionsDocumentInputSchema.safeParse({ ...documentInput, base64: '' }).success).toBe(false)
    expect(collectionsDocumentInputSchema.safeParse({ ...documentInput, sha256: 'A'.repeat(64) }).success).toBe(false)
  })
})

describe('amounts and dates the installation sends', () => {
  it('accepts amounts rounded to two decimals and refuses float drift and a third decimal', () => {
    expect(withInvoice({ claimAmount: 1234.5, claimRemaining: 1234.5 }).success).toBe(true)
    expect(withInvoice({ claimAmount: 1234.56, claimRemaining: 0.01 }).success).toBe(true)
    expect(withInvoice({ claimAmount: 0.1 + 0.2, claimRemaining: 0.1 }).success).toBe(false)
    expect(withInvoice({ claimAmount: 10.075, claimRemaining: 10 }).success).toBe(false)
    expect(openCase({ priorPayments: [{ paymentRef: 'p', date: '2026-09-02', amount: 33.333 }] }).success).toBe(false)
  })

  it('refuses a claim that is zero, negative, smaller than what remains or than its VAT', () => {
    expect(withInvoice({ claimAmount: 0 }).success).toBe(false)
    expect(withInvoice({ claimRemaining: -5 }).success).toBe(false)
    expect(withInvoice({ claimRemaining: 1250.01 }).success).toBe(false)
    expect(withInvoice({ claimVatAmount: 1250.01 }).success).toBe(false)
  })

  it('refuses dates that do not exist, are not YYYY-MM-DD, or a due date before the issue date', () => {
    expect(withInvoice({ dueDate: '2026-02-30' }).success).toBe(false)
    expect(withInvoice({ issueDate: '2026-08-01T00:00:00Z' }).success).toBe(false)
    expect(withInvoice({ dueDate: '2026-07-31' }).success).toBe(false)
    expect(withInvoice({ dueDate: '2026-08-01' }).success).toBe(true)
  })

  it('takes request timestamps as ISO 8601 with an offset', () => {
    const terms = COLLECTIONS_FIXTURES.acceptTerms.request
    expect(collectionsTermsAcceptRequestSchema.safeParse(terms).success).toBe(true)
    expect(collectionsTermsAcceptRequestSchema.safeParse({ ...terms, acceptedAt: '2026-10-04' }).success).toBe(false)
    expect(collectionsTermsAcceptRequestSchema.safeParse({ ...terms, acceptedAt: '2026-10-04T08:00:00' }).success).toBe(false)
  })
})

describe('late interest', () => {
  const lateInterest = { annualPercent: 12, fromDate: '2026-08-31', agreedSince: '2026-01-01' }

  it('accepts an agreed rate on a business debtor', () => {
    expect(openCase({ lateInterest }).success).toBe(true)
  })

  it('refuses a rate for a private debtor, a rate agreed after the invoice and interest before the due date', () => {
    expect(openCase({ lateInterest, debtor: privateDebtor }).success).toBe(false)
    expect(openCase({ lateInterest: { ...lateInterest, agreedSince: '2026-08-02' } }).success).toBe(false)
    expect(openCase({ lateInterest: { ...lateInterest, fromDate: '2026-08-30' } }).success).toBe(false)
  })
})

describe('open case', () => {
  it('starts a handover at the reminder or the collection step only', () => {
    expect(openCase({ startStep: 'collection' }).success).toBe(true)
    expect(openCase({ startStep: 'invoice' }).success).toBe(false)
  })

  it('takes SEK only in this version', () => {
    expect(withInvoice({ currency: 'EUR' }).success).toBe(false)
  })
})

describe('onboarding', () => {
  it('needs the owner personal number for a sole trader and refuses one for a company', () => {
    const soleTrader = { ...onboardingRequest.creditor, kind: 'sole_trader', personalNumber: '191212121212' }
    expect(collectionsOnboardingRequestSchema.safeParse({ ...onboardingRequest, creditor: soleTrader }).success).toBe(true)
    expect(collectionsOnboardingRequestSchema.safeParse({ ...onboardingRequest, creditor: { ...soleTrader, personalNumber: null } }).success).toBe(false)
    expect(
      collectionsOnboardingRequestSchema.safeParse({ ...onboardingRequest, creditor: { ...onboardingRequest.creditor, personalNumber: '191212121212' } }).success,
    ).toBe(false)
  })

  it('needs a description for every yes in the know-your-customer answers', () => {
    const kyc = onboardingRequest.kyc
    for (const [flag, description] of [
      ['pep', 'pepDescription'],
      ['sanctions', 'sanctionsDescription'],
      ['invoicesAbroad', 'invoicesAbroadDescription'],
    ] as const) {
      expect(collectionsOnboardingRequestSchema.safeParse({ ...onboardingRequest, kyc: { ...kyc, [flag]: true } }).success, flag).toBe(false)
      expect(collectionsOnboardingRequestSchema.safeParse({ ...onboardingRequest, kyc: { ...kyc, [flag]: true, [description]: '  ' } }).success, flag).toBe(false)
      expect(collectionsOnboardingRequestSchema.safeParse({ ...onboardingRequest, kyc: { ...kyc, [flag]: true, [description]: 'Se bilaga' } }).success, flag).toBe(true)
    }
  })

  it('locks both approvals on whenever settings are written', () => {
    const settings = COLLECTIONS_FIXTURES.updateSettings.request
    expect(collectionsSettingsUpdateRequestSchema.safeParse({ ...settings, approveBeforeLegalAction: false }).success).toBe(false)
    expect(collectionsSettingsUpdateRequestSchema.safeParse({ ...settings, approveBeforeCollectionNotice: false }).success).toBe(false)
    expect(
      collectionsOnboardingRequestSchema.safeParse({ ...onboardingRequest, settings: { ...onboardingRequest.settings, approveBeforeCollectionNotice: false } }).success,
    ).toBe(false)
  })

  it('reports settings as the provider holds them, so a setting changed there is visible instead of unparseable', () => {
    const changed = { ...connection, settings: { ...connection.settings, approveBeforeCollectionNotice: false } }
    const parsed = collectionsConnectionSchema.safeParse(changed)
    expect(parsed.success).toBe(true)
    expect(parsed.data?.settings?.approveBeforeCollectionNotice).toBe(false)
  })

  it('redirects the signer to an http(s) page and refuses any other scheme', () => {
    const request = COLLECTIONS_FIXTURES.startSignature.request
    expect(collectionsSignatureStartRequestSchema.safeParse({ ...request, redirectUrl: 'http://localhost:3000/settings/collections' }).success).toBe(true)
    expect(collectionsSignatureStartRequestSchema.safeParse({ ...request, redirectUrl: 'javascript:alert(1)' }).success).toBe(false)
  })
})

describe('case actions', () => {
  const action = COLLECTIONS_FIXTURES.caseAction.request

  it('takes a step with start and with nothing else', () => {
    expect(collectionsCaseActionRequestSchema.safeParse({ ...action, action: 'start', step: 'reminder' }).success).toBe(true)
    expect(collectionsCaseActionRequestSchema.safeParse({ ...action, action: 'start', step: null }).success).toBe(false)
    expect(collectionsCaseActionRequestSchema.safeParse({ ...action, action: 'pause', step: 'reminder' }).success).toBe(false)
    expect(collectionsCaseActionRequestSchema.safeParse({ ...action, action: 'approve_step' }).success).toBe(true)
  })

  it('refuses an action the contract does not name', () => {
    expect(collectionsCaseActionRequestSchema.safeParse({ ...action, action: 'anonymize' }).success).toBe(false)
  })
})

describe('change feed', () => {
  it('uses decimal sequence numbers so the caller can re-read with an overlap', () => {
    expect(collectionsChangesRequestSchema.safeParse({ after: null }).success).toBe(true)
    expect(collectionsChangesRequestSchema.safeParse({ after: '0' }).success).toBe(true)
    expect(collectionsChangesRequestSchema.safeParse({ after: 'abc' }).success).toBe(false)
    expect(collectionsChangesRequestSchema.safeParse({ after: '-1' }).success).toBe(false)
    expect(collectionsChangesRequestSchema.safeParse({ after: '1', limit: 501 }).success).toBe(false)
  })
})

describe('catalogue', () => {
  it('parses the features of each known capability with its own schema', () => {
    const response = catalogueResponseSchema.parse(catalogueResponse)
    const known = new Set<string>(CATALOGUE_CAPABILITIES)
    for (const entry of response.entries) {
      expect(known.has(entry.capability)).toBe(true)
      const schema = CATALOGUE_FEATURE_SCHEMAS[entry.capability as keyof typeof CATALOGUE_FEATURE_SCHEMAS]
      expect(schema.safeParse(entry.features).success, entry.capability).toBe(true)
    }
  })

  it('still parses an entry for a capability the caller does not know, so a newer service never breaks the listing', () => {
    const future = { capability: 'payments', provider: providerProfile, features: { anything: 1 } }
    expect(catalogueEntrySchema.safeParse(future).success).toBe(true)
    expect(catalogueResponseSchema.safeParse({ ...catalogueResponse, entries: [...catalogueResponse.entries, future] }).success).toBe(true)
    expect(Object.keys(CATALOGUE_FEATURE_SCHEMAS)).not.toContain('payments')
  })

  it('takes only https links to a domain, so no other scheme ever reaches a page', () => {
    for (const termsUrl of ['http://acme-inkasso.example.com/villkor', 'javascript:alert(1)', 'data:text/html,x', 'https://10.0.0.1/villkor']) {
      expect(providerProfileSchema.safeParse({ ...providerProfile, termsUrl }).success, termsUrl).toBe(false)
    }
    expect(providerProfileSchema.safeParse({ ...providerProfile, portalUrl: null }).success).toBe(true)
  })

  it('refuses a malformed feature set', () => {
    expect(CATALOGUE_FEATURE_SCHEMAS.collections.safeParse({ ...collectionsFeatures, startSteps: ['invoice'] }).success).toBe(false)
    expect(CATALOGUE_FEATURE_SCHEMAS.collections.safeParse({ ...collectionsFeatures, currencies: ['sek'] }).success).toBe(false)
    expect(CATALOGUE_FEATURE_SCHEMAS.delivery.safeParse({ ...deliveryFeatures, followUp: 'sometimes' }).success).toBe(false)
  })
})

describe('the package source', () => {
  it('names no host but its own: provider hosts reach an installation only through the catalogue', () => {
    const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
    const hosts = [...source.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1].toLowerCase())
    expect(hosts.length).toBeGreaterThan(0)
    for (const host of hosts) expect(host === 'accounted.se' || host.endsWith('.accounted.se'), host).toBe(true)
  })
})
