import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  PEPPOL_BIS_BILLING_CREDIT_NOTE_DOCUMENT_TYPE_ID,
  PEPPOL_PENDING_STALE_MS,
  PEPPOL_PUBLISHED_ELSEWHERE_MAX_ATTEMPTS,
  PEPPOL_PUBLISHED_ELSEWHERE_RETRY_MS,
  PEPPOL_RECEIVING_DOCUMENT_TYPES,
  canRetryPeppolRegistration,
  deregisterCompanyFromPeppolReceiving,
  describePeppolParticipantEligibility,
  isPublishedElsewhereRetryDue,
  isStalePeppolPending,
  preparePeppolParticipant,
  registerCompanyForPeppolReceiving,
  registerGrantedPeppolReceivers,
  isWithdrawnBeforeAccessReturned,
  withdrawRevokedPeppolRegistrations,
} from '@/lib/invoices/peppol-registration'
import { PEPPOL_BIS_BILLING_INVOICE_DOCUMENT_TYPE_ID } from '@/lib/invoices/peppol-bis-billing'
import { PeppolTransportError, type PeppolTransport } from '@/lib/invoices/peppol-transport'

const { supabase: mockService, enqueue, reset, calls } = createQueuedMockSupabase()
const service = mockService as unknown as SupabaseClient

const settings = {
  org_number: '559538-6219',
  company_name: 'Arcim Technology AB',
  vat_number: 'SE559538621901',
  city: 'Stockholm',
  country: 'SE',
}

function makeTransport(overrides: Partial<PeppolTransport> = {}): PeppolTransport {
  return {
    provider: 'qvalia',
    tenantId: 'SE5595386219',
    lookupRecipient: vi.fn(),
    submit: vi.fn(),
    verifyWebhook: vi.fn(),
    retrieveEvidence: vi.fn(),
    registerRecipient: vi.fn().mockResolvedValue({
      status: 'registered',
      participant: { scheme: '0007', identifier: '5595386219' },
      providerAccountReference: 'SE5595386219',
      raw: {},
    }),
    unregisterRecipient: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function transportFailure(code: string | null, retryable: boolean, detail: string | null = 'hosted detail') {
  return new PeppolTransportError('Connector: hosted refusal', { retryable, code, detail })
}

const registeredRow = {
  id: 'reg-1',
  company_id: 'company-1',
  user_id: 'user-1',
  provider: 'qvalia',
  provider_account_reference: 'SE5595386219',
  participant_scheme: '0007',
  participant_identifier: '5595386219',
  status: 'registered',
  business_card: {},
  document_types: PEPPOL_RECEIVING_DOCUMENT_TYPES,
  registered_at: '2026-08-21T16:00:00.000Z',
  deregistered_at: null,
  last_error: null,
  last_error_code: null,
  created_at: '2026-08-21T15:59:00.000Z',
  updated_at: '2026-08-21T16:00:00.000Z',
}

const register = (transport: PeppolTransport, overrides: Partial<typeof settings> = {}) =>
  registerCompanyForPeppolReceiving({
    service, companyId: 'company-1', userId: 'user-1', transport, settings: { ...settings, ...overrides },
  })

const updates = () => calls.filter((c) => c.method === 'update').map((c) => c.args[0] as Record<string, unknown>)
const inserts = () => calls.filter((c) => c.method === 'insert').map((c) => c.args[0] as Record<string, unknown>)

describe('preparePeppolParticipant', () => {
  it('derives 0007 + organisation number and the business card', () => {
    expect(preparePeppolParticipant(settings)).toEqual({
      ok: true,
      participant: { scheme: '0007', identifier: '5595386219' },
      businessCard: {
        companyName: 'Arcim Technology AB',
        countryCode: 'SE',
        geographicalInformation: 'Stockholm',
        vatNumber: 'SE559538621901',
        orgNumber: '5595386219',
      },
    })
    expect(preparePeppolParticipant({ ...settings, org_number: '16559538-6219' })).toMatchObject({
      ok: true,
      participant: { identifier: '5595386219' },
    })
  })

  it('refuses missing numbers, personnummer and missing names', () => {
    expect(preparePeppolParticipant({ ...settings, org_number: null })).toEqual({ ok: false, code: 'PEPPOL_REGISTRATION_ORG_NUMBER_REQUIRED' })
    expect(preparePeppolParticipant({ ...settings, org_number: '198001011234' })).toEqual({ ok: false, code: 'PEPPOL_REGISTRATION_PERSONAL_NUMBER' })
    expect(preparePeppolParticipant({ ...settings, org_number: '20050101-1234' })).toEqual({ ok: false, code: 'PEPPOL_REGISTRATION_PERSONAL_NUMBER' })
    expect(preparePeppolParticipant({ ...settings, org_number: '555953862191' })).toEqual({ ok: false, code: 'PEPPOL_REGISTRATION_ORG_NUMBER_REQUIRED' })
    expect(preparePeppolParticipant({ ...settings, org_number: '8001011234' })).toEqual({ ok: false, code: 'PEPPOL_REGISTRATION_PERSONAL_NUMBER' })
    expect(preparePeppolParticipant({ ...settings, company_name: ' ' })).toEqual({ ok: false, code: 'PEPPOL_REGISTRATION_COMPANY_NAME_REQUIRED' })
  })

  it('refuses a form whose org number is the owner\'s personnummer, whatever the stored number looks like', () => {
    expect(preparePeppolParticipant({ ...settings, entity_type: 'enskild_firma' }))
      .toEqual({ ok: false, code: 'PEPPOL_REGISTRATION_PERSONAL_NUMBER' })
    expect(preparePeppolParticipant({ ...settings, org_number: '198001011234', entity_type: 'enskild_firma' }))
      .toEqual({ ok: false, code: 'PEPPOL_REGISTRATION_PERSONAL_NUMBER' })
    expect(preparePeppolParticipant({ ...settings, entity_type: 'aktiebolag' })).toMatchObject({ ok: true })
    expect(preparePeppolParticipant({ ...settings, entity_type: 'ideell_forening', org_number: '802400-1234' })).toMatchObject({ ok: true })
  })

  it('describes eligibility as ok/code for the settings page', () => {
    expect(describePeppolParticipantEligibility(settings)).toEqual({ ok: true, code: null })
    expect(describePeppolParticipantEligibility({ ...settings, org_number: '8001011234' }))
      .toEqual({ ok: false, code: 'PEPPOL_REGISTRATION_PERSONAL_NUMBER' })
  })
})

describe('isStalePeppolPending', () => {
  it('flags only pending rows older than the stale window', () => {
    const now = Date.parse('2026-09-10T12:00:00.000Z')
    const fresh = new Date(now - PEPPOL_PENDING_STALE_MS + 1000).toISOString()
    const old = new Date(now - PEPPOL_PENDING_STALE_MS - 1000).toISOString()
    expect(isStalePeppolPending({ status: 'pending', updated_at: fresh }, now)).toBe(false)
    expect(isStalePeppolPending({ status: 'pending', updated_at: old }, now)).toBe(true)
    expect(isStalePeppolPending({ status: 'registered', updated_at: old }, now)).toBe(false)
    expect(isStalePeppolPending({ status: 'pending', updated_at: 'not a date' }, now)).toBe(false)
  })
})

describe('canRetryPeppolRegistration', () => {
  const now = Date.parse('2026-09-10T12:00:00.000Z')
  const staleAt = new Date(now - PEPPOL_PENDING_STALE_MS - 1000).toISOString()
  const freshAt = new Date(now - 1000).toISOString()
  const row = (status: string, last_error_code: string | null, updated_at = freshAt) =>
    ({ status: status as 'failed', last_error_code, updated_at })

  it('offers a retry for failed attempts and failed withdrawals whose code is retryable', () => {
    expect(canRetryPeppolRegistration(row('failed', 'PEPPOL_REGISTRATION_FAILED'), now)).toBe(true)
    expect(canRetryPeppolRegistration(row('failed', 'CONNECTOR_RATE_LIMITED'), now)).toBe(true)
    expect(canRetryPeppolRegistration(row('failed', null), now)).toBe(true)
    expect(canRetryPeppolRegistration(row('failed', 'NOT_IN_REGISTRY'), now)).toBe(true)
    expect(canRetryPeppolRegistration(row('pending', null, staleAt), now)).toBe(true)
    expect(canRetryPeppolRegistration(row('registered', 'CONNECTOR_UPSTREAM_ERROR'), now)).toBe(true)
  })

  it('offers a retry when the id was published at another access point: it clears once that one withdraws it (crm#1556)', () => {
    expect(canRetryPeppolRegistration(row('failed', 'CONNECTOR_PEPPOL_PARTICIPANT_PUBLISHED_ELSEWHERE'), now)).toBe(true)
  })

  it('never offers a retry next to a permanent verdict or on a healthy row', () => {
    expect(canRetryPeppolRegistration(row('failed', 'PEPPOL_REGISTRATION_REJECTED'), now)).toBe(false)
    expect(canRetryPeppolRegistration(row('failed', 'CONNECTOR_PEPPOL_PARTICIPANT_TAKEN'), now)).toBe(false)
    expect(canRetryPeppolRegistration(row('failed', 'PEPPOL_REGISTRATION_CAP_REACHED'), now)).toBe(false)
    expect(canRetryPeppolRegistration(row('registered', null), now)).toBe(false)
    expect(canRetryPeppolRegistration(row('pending', null), now)).toBe(false)
    expect(canRetryPeppolRegistration(row('deregistered', 'CONNECTOR_NOT_OWNED'), now)).toBe(false)
  })
})

describe('registerCompanyForPeppolReceiving', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
  })

  it('advertises Invoice and CreditNote for BIS Billing 3', () => {
    expect(PEPPOL_RECEIVING_DOCUMENT_TYPES.map((t) => t.documentTypeId)).toEqual([
      PEPPOL_BIS_BILLING_INVOICE_DOCUMENT_TYPE_ID,
      PEPPOL_BIS_BILLING_CREDIT_NOTE_DOCUMENT_TYPE_ID,
    ])
  })

  it('writes pending, publishes through the transport, then finalizes as registered', async () => {
    const transport = makeTransport()
    enqueue({ data: [], error: null })                        // existing registrations
    enqueue({ data: { id: 'reg-1' }, error: null })           // insert pending
    enqueue({ data: registeredRow, error: null })             // finalize update

    const result = await register(transport)

    expect(result).toEqual({ ok: true, registration: registeredRow })
    expect(transport.registerRecipient).toHaveBeenCalledWith({
      participant: { scheme: '0007', identifier: '5595386219' },
      businessCard: expect.objectContaining({ companyName: 'Arcim Technology AB', orgNumber: '5595386219' }),
      documentTypes: PEPPOL_RECEIVING_DOCUMENT_TYPES,
      tenantReference: 'company-1',
    })
    expect(inserts()[0]).toMatchObject({ status: 'pending', participant_identifier: '5595386219', company_id: 'company-1' })
    expect(updates().at(-1)).toMatchObject({
      status: 'registered', provider_account_reference: 'SE5595386219', last_error: null, last_error_code: null,
    })
  })

  it('persists the FAILED verdict for a retryable upstream error and reports the hosted detail and code', async () => {
    const transport = makeTransport({
      registerRecipient: vi.fn().mockRejectedValue(transportFailure('CONNECTOR_UPSTREAM_ERROR', true, 'Something went wrong with the request')),
    })
    enqueue({ data: [], error: null })
    enqueue({ data: { id: 'reg-1' }, error: null })
    enqueue({ data: null, error: null })                      // failure update

    expect(await register(transport)).toEqual({
      ok: false,
      code: 'PEPPOL_REGISTRATION_FAILED',
      detail: 'Something went wrong with the request',
      reason: 'CONNECTOR_UPSTREAM_ERROR',
    })
    const failed = updates().at(-1)
    // UPSTREAM_ERROR wraps whatever the access point said: the verdict is stored, not the wrapper.
    expect(failed).toMatchObject({ status: 'failed', last_error_code: 'PEPPOL_REGISTRATION_FAILED' })
    // The raw text is kept for ops but is never the contract: only its presence is pinned.
    expect(typeof failed?.last_error).toBe('string')
  })

  it('persists REJECTED for a permanent refusal wrapped in CONNECTOR_UPSTREAM_ERROR', async () => {
    const transport = makeTransport({
      registerRecipient: vi.fn().mockRejectedValue(transportFailure('CONNECTOR_UPSTREAM_ERROR', false, 'participant refused')),
    })
    enqueue({ data: [], error: null })
    enqueue({ data: { id: 'reg-1' }, error: null })
    enqueue({ data: null, error: null })

    expect(await register(transport)).toEqual({
      ok: false, code: 'PEPPOL_REGISTRATION_REJECTED', detail: 'participant refused', reason: 'CONNECTOR_UPSTREAM_ERROR',
    })
    expect(updates().at(-1)).toMatchObject({ status: 'failed', last_error_code: 'PEPPOL_REGISTRATION_REJECTED' })
  })

  it('persists the verdict for a hosted code the registry does not know', async () => {
    const transport = makeTransport({
      registerRecipient: vi.fn().mockRejectedValue(transportFailure('CONNECTOR_SOMETHING_NEW', true, null)),
    })
    enqueue({ data: [], error: null })
    enqueue({ data: { id: 'reg-1' }, error: null })
    enqueue({ data: null, error: null })

    expect(await register(transport)).toMatchObject({ ok: false, code: 'PEPPOL_REGISTRATION_FAILED', reason: 'CONNECTOR_SOMETHING_NEW' })
    expect(updates().at(-1)).toMatchObject({ last_error_code: 'PEPPOL_REGISTRATION_FAILED' })
  })

  it.each([
    'CONNECTOR_PEPPOL_PARTICIPANT_NOT_ALLOWED',
    'CONNECTOR_PEPPOL_PARTICIPANT_TAKEN',
    'CONNECTOR_PEPPOL_PARTICIPANT_PUBLISHED_ELSEWHERE',
    'CONNECTOR_QUOTA_EXCEEDED',
  ])('maps the permanent hosted code %s to REJECTED even when the envelope says retryable', async (code) => {
    const transport = makeTransport({
      registerRecipient: vi.fn().mockRejectedValue(transportFailure(code, true)),
    })
    enqueue({ data: [], error: null })
    enqueue({ data: { id: 'reg-1' }, error: null })
    enqueue({ data: null, error: null })

    expect(await register(transport)).toEqual({
      ok: false, code: 'PEPPOL_REGISTRATION_REJECTED', detail: 'hosted detail', reason: code,
    })
    expect(updates().at(-1)).toMatchObject({ status: 'failed', last_error_code: code })
  })

  it.each([
    'CONNECTOR_PEPPOL_REGISTRATION_IN_PROGRESS',
    'CONNECTOR_RATE_LIMITED',
    'CONNECTOR_UPSTREAM_UNCONFIGURED',
    'CONNECTOR_LEDGER_FAILED',
    'CONNECTOR_UNREACHABLE',
    'HTTP_404',
  ])('maps the transient hosted code %s to FAILED even when the envelope says not retryable', async (code) => {
    const transport = makeTransport({
      registerRecipient: vi.fn().mockRejectedValue(transportFailure(code, false, null)),
    })
    enqueue({ data: [], error: null })
    enqueue({ data: { id: 'reg-1' }, error: null })
    enqueue({ data: null, error: null })

    expect(await register(transport)).toEqual({ ok: false, code: 'PEPPOL_REGISTRATION_FAILED', detail: null, reason: code })
    // Registry-known transient codes are stored as themselves; a bare HTTP
    // status and codes without registry text store the verdict.
    const storedAsItself = ['CONNECTOR_PEPPOL_REGISTRATION_IN_PROGRESS', 'CONNECTOR_RATE_LIMITED', 'CONNECTOR_UNREACHABLE']
    expect(updates().at(-1)).toMatchObject({
      status: 'failed', last_error_code: storedAsItself.includes(code) ? code : 'PEPPOL_REGISTRATION_FAILED',
    })
  })

  it('maps a non-retryable transport error without a known code to REJECTED', async () => {
    const transport = makeTransport({
      registerRecipient: vi.fn().mockRejectedValue(transportFailure('HTTP_400', false, null)),
    })
    enqueue({ data: [], error: null })
    enqueue({ data: { id: 'reg-1' }, error: null })
    enqueue({ data: null, error: null })

    expect(await register(transport)).toEqual({
      ok: false, code: 'PEPPOL_REGISTRATION_REJECTED', detail: null, reason: 'HTTP_400',
    })
    expect(updates().at(-1)).toMatchObject({ status: 'failed', last_error_code: 'PEPPOL_REGISTRATION_REJECTED' })
  })

  it('answers in-progress instead of throwing when a concurrent attempt already holds the live row', async () => {
    const transport = makeTransport()
    enqueue({ data: [], error: null })
    enqueue({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "peppol_registrations_live_company"' } })

    expect(await register(transport)).toEqual({
      ok: false, code: 'PEPPOL_REGISTRATION_FAILED', detail: null, reason: 'CONNECTOR_PEPPOL_REGISTRATION_IN_PROGRESS',
    })
    expect(transport.registerRecipient).not.toHaveBeenCalled()
    expect(updates()).toHaveLength(0)
  })

  it.each([
    'PEPPOL_REGISTRATION_CAP_REACHED',
    'PEPPOL_RECEIVING_UNSUPPORTED',
  ])('passes the hosted code %s through as its own result code', async (code) => {
    const transport = makeTransport({
      registerRecipient: vi.fn().mockRejectedValue(transportFailure(code, false)),
    })
    enqueue({ data: [], error: null })
    enqueue({ data: { id: 'reg-1' }, error: null })
    enqueue({ data: null, error: null })

    expect(await register(transport)).toEqual({ ok: false, code })
    expect(updates().at(-1)).toMatchObject({ status: 'failed', last_error_code: code })
  })

  it('records a non-transport failure under the result code', async () => {
    const transport = makeTransport({
      registerRecipient: vi.fn().mockRejectedValue(new Error('boom')),
    })
    enqueue({ data: [], error: null })
    enqueue({ data: { id: 'reg-1' }, error: null })
    enqueue({ data: null, error: null })

    expect(await register(transport)).toEqual({
      ok: false, code: 'PEPPOL_REGISTRATION_FAILED', detail: null, reason: 'PEPPOL_REGISTRATION_FAILED',
    })
    expect(updates().at(-1)).toMatchObject({ status: 'failed', last_error: 'boom', last_error_code: 'PEPPOL_REGISTRATION_FAILED' })
  })

  it('retries after a failed row by inserting a new one', async () => {
    const transport = makeTransport()
    enqueue({ data: [{ ...registeredRow, status: 'failed', registered_at: null, last_error_code: 'CONNECTOR_UPSTREAM_ERROR' }], error: null })
    enqueue({ data: { id: 'reg-2' }, error: null })           // insert pending
    enqueue({ data: { ...registeredRow, id: 'reg-2' }, error: null })

    const result = await register(transport)
    expect(result.ok).toBe(true)
    expect(inserts()).toHaveLength(1)
    expect(transport.registerRecipient).toHaveBeenCalledTimes(1)
  })

  it('reuses a fresh pending row without inserting', async () => {
    const transport = makeTransport()
    enqueue({ data: [{ ...registeredRow, status: 'pending', registered_at: null, updated_at: new Date().toISOString() }], error: null })
    enqueue({ data: registeredRow, error: null })             // finalize update

    expect((await register(transport)).ok).toBe(true)
    expect(inserts()).toHaveLength(0)
    expect(updates()).toHaveLength(1)
    expect(updates()[0]).toMatchObject({ status: 'registered' })
  })

  it('retires a stale pending row as failed and runs a fresh attempt', async () => {
    const transport = makeTransport()
    const staleAt = new Date(Date.now() - PEPPOL_PENDING_STALE_MS - 60_000).toISOString()
    enqueue({ data: [{ ...registeredRow, status: 'pending', registered_at: null, updated_at: staleAt }], error: null })
    enqueue({ data: null, error: null })                      // retire stale row
    enqueue({ data: { id: 'reg-2' }, error: null })           // insert pending
    enqueue({ data: { ...registeredRow, id: 'reg-2' }, error: null })

    const result = await register(transport)
    expect(result).toEqual({ ok: true, registration: { ...registeredRow, id: 'reg-2' } })
    expect(updates()[0]).toMatchObject({ status: 'failed', last_error_code: 'PEPPOL_REGISTRATION_FAILED' })
    expect(inserts()).toHaveLength(1)
    expect(updates().at(-1)).toMatchObject({ status: 'registered' })
  })

  it('checks the cap before touching a stale pending row, and does not count that row against its own company', async () => {
    process.env.PEPPOL_RECEIVING_MAX_REGISTRATIONS = '10'
    try {
      const transport = makeTransport()
      const staleAt = new Date(Date.now() - PEPPOL_PENDING_STALE_MS - 60_000).toISOString()
      const staleRow = { ...registeredRow, status: 'pending', registered_at: null, updated_at: staleAt }
      enqueue({ data: [staleRow], error: null })
      enqueue({ data: null, error: null, count: 11 })          // others already past the cap
      expect(await register(transport)).toEqual({ ok: false, code: 'PEPPOL_REGISTRATION_CAP_REACHED' })
      expect(updates()).toHaveLength(0)                        // the stale row is left as it was
      expect(transport.registerRecipient).not.toHaveBeenCalled()

      reset()
      enqueue({ data: [staleRow], error: null })
      enqueue({ data: null, error: null, count: 10 })          // at the cap, but one of them is this company's stale row
      enqueue({ data: null, error: null })                     // retire
      enqueue({ data: { id: 'reg-2' }, error: null })          // insert
      enqueue({ data: { ...registeredRow, id: 'reg-2' }, error: null })
      expect((await register(transport)).ok).toBe(true)
      expect(updates()[0]).toMatchObject({ status: 'failed' })
    } finally {
      delete process.env.PEPPOL_RECEIVING_MAX_REGISTRATIONS
    }
  })

  it('refuses the registration past the contracted cap, and lets an already-registered company through', async () => {
    process.env.PEPPOL_RECEIVING_MAX_REGISTRATIONS = '10'
    try {
      const transport = makeTransport()
      enqueue({ data: [], error: null })                       // no registration for this company
      enqueue({ data: null, error: null, count: 10 })          // live count at the cap
      expect(await register(transport)).toEqual({ ok: false, code: 'PEPPOL_REGISTRATION_CAP_REACHED' })
      expect(transport.registerRecipient).not.toHaveBeenCalled()

      // A company that already holds a live row re-registers without consuming a slot.
      reset()
      enqueue({ data: [registeredRow], error: null })          // live row exists
      enqueue({ data: registeredRow, error: null })            // finalize update
      expect((await register(transport)).ok).toBe(true)
    } finally {
      delete process.env.PEPPOL_RECEIVING_MAX_REGISTRATIONS
    }
  })

  it('stops before the network on a personnummer and on a send-only transport', async () => {
    const transport = makeTransport()
    expect(await register(transport, { org_number: '8001011234' })).toEqual({ ok: false, code: 'PEPPOL_REGISTRATION_PERSONAL_NUMBER' })
    expect(transport.registerRecipient).not.toHaveBeenCalled()

    const sendOnly = makeTransport({ registerRecipient: undefined })
    expect(await register(sendOnly)).toEqual({ ok: false, code: 'PEPPOL_RECEIVING_UNSUPPORTED' })
  })
})

describe('deregisterCompanyFromPeppolReceiving', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
  })

  const deregister = (transport: PeppolTransport) =>
    deregisterCompanyFromPeppolReceiving({ service, companyId: 'company-1', transport })

  it('withdraws the live identifier and marks the row deregistered', async () => {
    const transport = makeTransport()
    enqueue({ data: [registeredRow], error: null })
    enqueue({ data: { ...registeredRow, status: 'deregistered', deregistered_at: '2026-08-21T17:00:00.000Z' }, error: null })
    const result = await deregister(transport)
    expect(result.ok).toBe(true)
    expect(transport.unregisterRecipient).toHaveBeenCalledWith({ scheme: '0007', identifier: '5595386219' })
    expect(updates()[0]).toMatchObject({ status: 'deregistered', last_error: null, last_error_code: null })
  })

  it('reports not found when nothing is live', async () => {
    enqueue({ data: [{ ...registeredRow, status: 'deregistered' }], error: null })
    expect(await deregister(makeTransport())).toEqual({ ok: false, code: 'PEPPOL_REGISTRATION_NOT_FOUND' })
  })

  it('closes the local row when the hosted side answers CONNECTOR_NOT_OWNED', async () => {
    const transport = makeTransport({
      unregisterRecipient: vi.fn().mockRejectedValue(transportFailure('CONNECTOR_NOT_OWNED', false, 'not registered by this key')),
    })
    const closed = { ...registeredRow, status: 'deregistered', deregistered_at: '2026-09-10T12:00:00.000Z', last_error_code: 'CONNECTOR_NOT_OWNED' }
    enqueue({ data: [registeredRow], error: null })
    enqueue({ data: closed, error: null })

    expect(await deregister(transport)).toEqual({ ok: true, registration: closed })
    expect(updates()[0]).toMatchObject({ status: 'deregistered', deregistered_at: expect.any(String), last_error_code: 'CONNECTOR_NOT_OWNED' })
  })

  it('keeps the row live on a bare HTTP_404: the connector URL did not reach the hosted route', async () => {
    const transport = makeTransport({
      unregisterRecipient: vi.fn().mockRejectedValue(transportFailure('HTTP_404', false, null)),
    })
    enqueue({ data: [registeredRow], error: null })
    enqueue({ data: null, error: null })

    expect(await deregister(transport)).toEqual({ ok: false, code: 'PEPPOL_REGISTRATION_FAILED', detail: null, reason: 'HTTP_404' })
    expect(updates()[0]).toEqual({ last_error: expect.any(String), last_error_code: 'PEPPOL_REGISTRATION_FAILED' })
  })

  it('keeps the row live with the code on it when the hosted side fails, REJECTED or FAILED by retryability', async () => {
    enqueue({ data: [registeredRow], error: null })
    enqueue({ data: null, error: null })
    expect(await deregister(makeTransport({
      unregisterRecipient: vi.fn().mockRejectedValue(transportFailure('CONNECTOR_UPSTREAM_ERROR', true, 'smp down')),
    }))).toEqual({ ok: false, code: 'PEPPOL_REGISTRATION_FAILED', detail: 'smp down', reason: 'CONNECTOR_UPSTREAM_ERROR' })
    expect(updates()[0]).toEqual({ last_error: expect.any(String), last_error_code: 'PEPPOL_REGISTRATION_FAILED' })

    reset()
    enqueue({ data: [registeredRow], error: null })
    enqueue({ data: null, error: null })
    expect(await deregister(makeTransport({
      unregisterRecipient: vi.fn().mockRejectedValue(transportFailure('CONNECTOR_PEPPOL_PARTICIPANT_NOT_ALLOWED', false)),
    }))).toEqual({
      ok: false, code: 'PEPPOL_REGISTRATION_REJECTED', detail: 'hosted detail', reason: 'CONNECTOR_PEPPOL_PARTICIPANT_NOT_ALLOWED',
    })
    expect(updates()[0]).toMatchObject({ last_error_code: 'CONNECTOR_PEPPOL_PARTICIPANT_NOT_ALLOWED' })
  })
})

describe('withdrawRevokedPeppolRegistrations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
  })

  const withdraw = (transport: PeppolTransport) => withdrawRevokedPeppolRegistrations({ service, transport })
  const live = (companyId: string, identifier: string) => ({
    ...registeredRow, id: `reg-${companyId}`, company_id: companyId, participant_identifier: identifier,
  })

  it('withdraws companies whose access is disabled or has receiving off, and nobody else', async () => {
    const transport = makeTransport()
    enqueue({ data: [{ company_id: 'c-disabled' }, { company_id: 'c-receive-off' }, { company_id: 'c-receiving' }, { company_id: 'c-no-access' }], error: null })
    enqueue({
      data: [
        { company_id: 'c-disabled', status: 'disabled', receive_enabled: true },
        { company_id: 'c-receive-off', status: 'enabled', receive_enabled: false },
        { company_id: 'c-receiving', status: 'enabled', receive_enabled: true },
      ],
      error: null,
    })
    enqueue({ data: [live('c-disabled', '5522334456')], error: null })
    enqueue({ data: { ...live('c-disabled', '5522334456'), status: 'deregistered' }, error: null })
    enqueue({ data: [live('c-receive-off', '5595386219')], error: null })
    enqueue({ data: { ...live('c-receive-off', '5595386219'), status: 'deregistered' }, error: null })

    expect(await withdraw(transport)).toEqual({ withdrawn: ['c-disabled', 'c-receive-off'], failed: [] })
    expect(transport.unregisterRecipient).toHaveBeenCalledTimes(2)
    expect(transport.unregisterRecipient).toHaveBeenCalledWith({ scheme: '0007', identifier: '5522334456' })
    expect(transport.unregisterRecipient).toHaveBeenCalledWith({ scheme: '0007', identifier: '5595386219' })
    expect(calls.find((c) => c.table === 'peppol_registrations' && c.method === 'in')?.args).toEqual(['status', ['pending', 'registered']])
    expect(updates()).toHaveLength(2)
  })

  it('records a failed withdrawal and goes on with the next company', async () => {
    const transport = makeTransport({
      unregisterRecipient: vi.fn()
        .mockRejectedValueOnce(transportFailure('CONNECTOR_UPSTREAM_ERROR', true, 'smp down'))
        .mockResolvedValueOnce(undefined),
    })
    enqueue({ data: [{ company_id: 'c-a' }, { company_id: 'c-b' }], error: null })
    enqueue({
      data: [
        { company_id: 'c-a', status: 'disabled', receive_enabled: false },
        { company_id: 'c-b', status: 'disabled', receive_enabled: false },
      ],
      error: null,
    })
    enqueue({ data: [live('c-a', '5560000001')], error: null })
    enqueue({ data: null, error: null })
    enqueue({ data: [live('c-b', '5560000002')], error: null })
    enqueue({ data: { ...live('c-b', '5560000002'), status: 'deregistered' }, error: null })

    expect(await withdraw(transport)).toEqual({
      withdrawn: ['c-b'],
      failed: [{ companyId: 'c-a', reason: 'CONNECTOR_UPSTREAM_ERROR' }],
    })
  })

  it('does nothing without live registrations or on a send-only transport', async () => {
    enqueue({ data: [], error: null })
    expect(await withdraw(makeTransport())).toEqual({ withdrawn: [], failed: [] })
    expect(calls.some((c) => c.table === 'peppol_access')).toBe(false)

    reset()
    expect(await withdraw(makeTransport({ unregisterRecipient: undefined }))).toEqual({ withdrawn: [], failed: [] })
    expect(calls).toHaveLength(0)
  })

  it('throws when the access rows cannot be read', async () => {
    enqueue({ data: [{ company_id: 'c-a' }], error: null })
    enqueue({ data: null, error: { message: 'boom' } })
    await expect(withdraw(makeTransport())).rejects.toThrow('Failed to read Peppol access: boom')
  })
})

describe('isPublishedElsewhereRetryDue', () => {
  const now = Date.parse('2026-11-03T12:00:00.000Z')
  const dayAgo = new Date(now - PEPPOL_PUBLISHED_ELSEWHERE_RETRY_MS).toISOString()
  const hourAgo = new Date(now - 60 * 60 * 1000).toISOString()
  const elsewhere = (updatedAt: string) => ({
    status: 'failed' as const, updated_at: updatedAt, last_error_code: 'CONNECTOR_PEPPOL_PARTICIPANT_PUBLISHED_ELSEWHERE',
  })

  it('is due a day after the latest attempt was published elsewhere, and not before', () => {
    expect(isPublishedElsewhereRetryDue([elsewhere(dayAgo)], now)).toBe(true)
    expect(isPublishedElsewhereRetryDue([elsewhere(hourAgo)], now)).toBe(false)
  })

  it('stops after the capped number of such attempts', () => {
    const atCap = Array.from({ length: PEPPOL_PUBLISHED_ELSEWHERE_MAX_ATTEMPTS }, () => elsewhere(dayAgo))
    expect(isPublishedElsewhereRetryDue(atCap.slice(1), now)).toBe(true)
    expect(isPublishedElsewhereRetryDue(atCap, now)).toBe(false)
  })

  it('looks at the latest attempt only, ignores a crashed pending row, and never retries past a live row', () => {
    const staleAt = new Date(now - PEPPOL_PENDING_STALE_MS - 60_000).toISOString()
    const otherFailure = { status: 'failed' as const, updated_at: dayAgo, last_error_code: 'CONNECTOR_PEPPOL_PARTICIPANT_TAKEN' }
    const older = new Date(now - 2 * PEPPOL_PUBLISHED_ELSEWHERE_RETRY_MS).toISOString()
    expect(isPublishedElsewhereRetryDue([elsewhere(older), otherFailure], now)).toBe(false)
    expect(isPublishedElsewhereRetryDue([elsewhere(dayAgo), { status: 'pending', updated_at: staleAt, last_error_code: null }], now)).toBe(true)
    expect(isPublishedElsewhereRetryDue([elsewhere(dayAgo), { status: 'pending', updated_at: new Date(now - 1000).toISOString(), last_error_code: null }], now)).toBe(false)
    expect(isPublishedElsewhereRetryDue([{ status: 'deregistered', updated_at: dayAgo, last_error_code: null }], now)).toBe(false)
    expect(isPublishedElsewhereRetryDue([], now)).toBe(false)
  })
})

describe('isWithdrawnBeforeAccessReturned', () => {
  const withdrawn = { status: 'deregistered' as const, updated_at: '2026-11-01T00:00:00.000Z', last_error_code: null }

  it('republishes an id withdrawn when the plan ended, once access is back', () => {
    expect(isWithdrawnBeforeAccessReturned([withdrawn], '2026-11-20T00:00:00.000Z')).toBe(true)
  })

  it('never undoes a withdrawal made while access was on, or with no access time', () => {
    expect(isWithdrawnBeforeAccessReturned([withdrawn], '2026-10-01T00:00:00.000Z')).toBe(false)
    expect(isWithdrawnBeforeAccessReturned([withdrawn], null)).toBe(false)
  })

  it('leaves a live or failed latest attempt to the other rules', () => {
    const live = { status: 'registered' as const, updated_at: '2026-10-01T00:00:00.000Z', last_error_code: null }
    const failed = { status: 'failed' as const, updated_at: '2026-11-02T00:00:00.000Z', last_error_code: 'X' }
    expect(isWithdrawnBeforeAccessReturned([withdrawn, live], '2026-11-20T00:00:00.000Z')).toBe(false)
    expect(isWithdrawnBeforeAccessReturned([withdrawn, failed], '2026-11-20T00:00:00.000Z')).toBe(false)
  })
})

describe('registerGrantedPeppolReceivers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
  })

  const registerGranted = (transport: PeppolTransport, limit?: number) =>
    registerGrantedPeppolReceivers({ service, transport, limit })
  const companySettings = (companyId: string, orgNumber: string, extra: Record<string, unknown> = {}) => ({
    ...settings, company_id: companyId, org_number: orgNumber, entity_type: 'aktiebolag', is_sandbox: false, ...extra,
  })
  const staleAt = () => new Date(Date.now() - PEPPOL_PENDING_STALE_MS - 60_000).toISOString()

  it('publishes granted companies with no registration history, retries a crashed attempt, and leaves the rest alone', async () => {
    const transport = makeTransport()
    enqueue({
      data: [
        { company_id: 'c-new', requested_by: 'user-1' },
        { company_id: 'c-registered', requested_by: null },
        { company_id: 'c-failed', requested_by: null },
        { company_id: 'c-withdrawn', requested_by: null },
        { company_id: 'c-crashed', requested_by: null },
      ],
      error: null,
    })
    enqueue({
      data: [
        { company_id: 'c-registered', status: 'registered', updated_at: '2026-10-01T00:00:00.000Z' },
        { company_id: 'c-failed', status: 'failed', updated_at: '2026-10-01T00:00:00.000Z' },
        { company_id: 'c-withdrawn', status: 'deregistered', updated_at: '2026-10-01T00:00:00.000Z' },
        { company_id: 'c-crashed', status: 'pending', updated_at: staleAt() },
      ],
      error: null,
    })
    enqueue({ data: [companySettings('c-new', '5533445564'), companySettings('c-crashed', '5595386219')], error: null })
    // c-new: no history, insert pending, finalize
    enqueue({ data: [], error: null })
    enqueue({ data: { id: 'reg-new' }, error: null })
    enqueue({ data: { ...registeredRow, id: 'reg-new', company_id: 'c-new' }, error: null })
    // c-crashed: the stale row is retired, then a fresh attempt
    enqueue({ data: [{ ...registeredRow, company_id: 'c-crashed', status: 'pending', registered_at: null, updated_at: staleAt() }], error: null })
    enqueue({ data: null, error: null })
    enqueue({ data: { id: 'reg-crashed' }, error: null })
    enqueue({ data: { ...registeredRow, id: 'reg-crashed', company_id: 'c-crashed' }, error: null })

    expect(await registerGranted(transport)).toEqual({ registered: ['c-new', 'c-crashed'], failed: [], skipped: [] })
    expect(transport.registerRecipient).toHaveBeenCalledTimes(2)
    expect(transport.registerRecipient).toHaveBeenCalledWith(expect.objectContaining({
      participant: { scheme: '0007', identifier: '5533445564' }, tenantReference: 'c-new',
    }))
    expect(inserts()[0]).toMatchObject({ company_id: 'c-new', user_id: 'user-1', status: 'pending' })
    expect(inserts()[1]).toMatchObject({ company_id: 'c-crashed', user_id: null })
    const accessFilters = calls.filter((c) => c.table === 'peppol_access' && c.method === 'eq').map((c) => c.args)
    expect(accessFilters).toEqual([['status', 'enabled'], ['receive_enabled', true]])
  })

  it('stops at the per-run limit, oldest request first, and does not count skipped companies against it', async () => {
    const transport = makeTransport()
    enqueue({
      data: [
        { company_id: 'c-sandbox', requested_by: null },
        { company_id: 'c-personnummer', requested_by: null },
        { company_id: 'c-no-settings', requested_by: null },
        { company_id: 'c-1', requested_by: null },
        { company_id: 'c-2', requested_by: null },
      ],
      error: null,
    })
    enqueue({ data: [], error: null })
    enqueue({
      data: [
        companySettings('c-sandbox', '5560000001', { is_sandbox: true }),
        companySettings('c-personnummer', '8001011234', { entity_type: 'enskild_firma' }),
        companySettings('c-1', '5560000002'),
        companySettings('c-2', '5560000003'),
      ],
      error: null,
    })
    enqueue({ data: [], error: null })
    enqueue({ data: { id: 'reg-1' }, error: null })
    enqueue({ data: { ...registeredRow, company_id: 'c-1' }, error: null })

    expect(await registerGranted(transport, 1)).toEqual({
      registered: ['c-1'],
      failed: [],
      skipped: [
        { companyId: 'c-sandbox', reason: 'PEPPOL_SANDBOX_NOT_ALLOWED' },
        { companyId: 'c-personnummer', reason: 'PEPPOL_REGISTRATION_PERSONAL_NUMBER' },
        { companyId: 'c-no-settings', reason: 'INVOICE_SEND_COMPANY_SETTINGS_MISSING' },
      ],
    })
    expect(transport.registerRecipient).toHaveBeenCalledTimes(1)
    expect(calls.find((c) => c.table === 'peppol_access' && c.method === 'order')?.args).toEqual(['requested_at', { ascending: true, nullsFirst: false }])
  })

  it('records a refusal with the transport code and goes on; stops at the contracted cap', async () => {
    const transport = makeTransport({
      registerRecipient: vi.fn()
        .mockRejectedValueOnce(transportFailure('CONNECTOR_PEPPOL_PARTICIPANT_PUBLISHED_ELSEWHERE', false))
        .mockResolvedValueOnce({ status: 'registered', participant: { scheme: '0007', identifier: '5560000002' }, providerAccountReference: null, raw: {} }),
    })
    enqueue({ data: [{ company_id: 'c-elsewhere', requested_by: null }, { company_id: 'c-ok', requested_by: null }], error: null })
    enqueue({ data: [], error: null })
    enqueue({ data: [companySettings('c-elsewhere', '5560000001'), companySettings('c-ok', '5560000002')], error: null })
    enqueue({ data: [], error: null })
    enqueue({ data: { id: 'reg-elsewhere' }, error: null })
    enqueue({ data: null, error: null })                      // failed row written
    enqueue({ data: [], error: null })
    enqueue({ data: { id: 'reg-ok' }, error: null })
    enqueue({ data: { ...registeredRow, company_id: 'c-ok' }, error: null })

    expect(await registerGranted(transport)).toEqual({
      registered: ['c-ok'],
      failed: [{ companyId: 'c-elsewhere', reason: 'CONNECTOR_PEPPOL_PARTICIPANT_PUBLISHED_ELSEWHERE' }],
      skipped: [],
    })

    reset()
    process.env.PEPPOL_RECEIVING_MAX_REGISTRATIONS = '2'
    try {
      const capped = makeTransport()
      enqueue({ data: [{ company_id: 'c-a', requested_by: null }, { company_id: 'c-b', requested_by: null }], error: null })
      enqueue({ data: [], error: null })
      enqueue({ data: [companySettings('c-a', '5560000001'), companySettings('c-b', '5560000002')], error: null })
      enqueue({ data: [], error: null })
      enqueue({ data: null, error: null, count: 2 })
      expect(await registerGranted(capped)).toEqual({
        registered: [],
        failed: [{ companyId: 'c-a', reason: 'PEPPOL_REGISTRATION_CAP_REACHED' }],
        skipped: [],
      })
      expect(capped.registerRecipient).not.toHaveBeenCalled()
    } finally {
      delete process.env.PEPPOL_RECEIVING_MAX_REGISTRATIONS
    }
  })

  it('retries a company published elsewhere a day later, after the never-attempted ones, and does not page when it is still there (crm#1556)', async () => {
    const now = Date.parse('2026-11-03T12:00:00.000Z')
    const at = (msAgo: number) => new Date(now - msAgo).toISOString()
    const day = PEPPOL_PUBLISHED_ELSEWHERE_RETRY_MS
    const elsewhere = (companyId: string, updatedAt: string) => ({
      company_id: companyId, status: 'failed', updated_at: updatedAt, last_error_code: 'CONNECTOR_PEPPOL_PARTICIPANT_PUBLISHED_ELSEWHERE',
    })
    const transport = makeTransport({
      registerRecipient: vi.fn()
        .mockResolvedValueOnce({ status: 'registered', participant: { scheme: '0007', identifier: '5560000004' }, providerAccountReference: null, raw: {} })
        .mockResolvedValueOnce({ status: 'registered', participant: { scheme: '0007', identifier: '5560000001' }, providerAccountReference: null, raw: {} })
        .mockRejectedValueOnce(transportFailure('CONNECTOR_PEPPOL_PARTICIPANT_PUBLISHED_ELSEWHERE', false)),
    })
    enqueue({
      data: [
        { company_id: 'c-moved', requested_by: null },
        { company_id: 'c-waiting', requested_by: null },
        { company_id: 'c-too-soon', requested_by: null },
        { company_id: 'c-gave-up', requested_by: null },
        { company_id: 'c-new', requested_by: null },
      ],
      error: null,
    })
    enqueue({
      data: [
        elsewhere('c-moved', at(3 * day)),
        elsewhere('c-waiting', at(day + 60_000)),
        elsewhere('c-too-soon', at(day - 60_000)),
        ...Array.from({ length: PEPPOL_PUBLISHED_ELSEWHERE_MAX_ATTEMPTS }, () => elsewhere('c-gave-up', at(2 * day))),
      ],
      error: null,
    })
    enqueue({
      data: [
        companySettings('c-moved', '5560000001'), companySettings('c-waiting', '5560000002'),
        companySettings('c-new', '5560000004'),
      ],
      error: null,
    })
    // c-new first: never attempted
    enqueue({ data: [], error: null })
    enqueue({ data: { id: 'reg-new' }, error: null })
    enqueue({ data: { ...registeredRow, company_id: 'c-new' }, error: null })
    // c-moved (oldest attempt): the old operator withdrew, a new row registers
    enqueue({ data: [{ ...registeredRow, company_id: 'c-moved', status: 'failed', updated_at: at(3 * day) }], error: null })
    enqueue({ data: { id: 'reg-moved' }, error: null })
    enqueue({ data: { ...registeredRow, company_id: 'c-moved' }, error: null })
    // c-waiting: still published elsewhere, a new failed row
    enqueue({ data: [{ ...registeredRow, company_id: 'c-waiting', status: 'failed', updated_at: at(day + 60_000) }], error: null })
    enqueue({ data: { id: 'reg-waiting' }, error: null })
    enqueue({ data: null, error: null })

    expect(await registerGrantedPeppolReceivers({ service, transport, now })).toEqual({
      registered: ['c-new', 'c-moved'],
      failed: [],
      skipped: [{ companyId: 'c-waiting', reason: 'CONNECTOR_PEPPOL_PARTICIPANT_PUBLISHED_ELSEWHERE' }],
    })
    expect(transport.registerRecipient).toHaveBeenCalledTimes(3)
    expect(inserts().map((row) => row.company_id)).toEqual(['c-new', 'c-moved', 'c-waiting'])
    expect(updates().at(-1)).toMatchObject({ status: 'failed', last_error_code: 'CONNECTOR_PEPPOL_PARTICIPANT_PUBLISHED_ELSEWHERE' })
    const settingsIds = calls.find((c) => c.table === 'company_settings' && c.method === 'in')?.args[1]
    expect(settingsIds).toEqual(['c-new', 'c-moved', 'c-waiting'])
  })

  it('counts a retry against the per-run limit', async () => {
    const now = Date.parse('2026-11-03T12:00:00.000Z')
    const transport = makeTransport()
    enqueue({ data: [{ company_id: 'c-new', requested_by: null }, { company_id: 'c-moved', requested_by: null }], error: null })
    enqueue({
      data: [{
        company_id: 'c-moved', status: 'failed', updated_at: new Date(now - 2 * PEPPOL_PUBLISHED_ELSEWHERE_RETRY_MS).toISOString(),
        last_error_code: 'CONNECTOR_PEPPOL_PARTICIPANT_PUBLISHED_ELSEWHERE',
      }],
      error: null,
    })
    enqueue({ data: [companySettings('c-new', '5560000004'), companySettings('c-moved', '5560000001')], error: null })
    enqueue({ data: [], error: null })
    enqueue({ data: { id: 'reg-new' }, error: null })
    enqueue({ data: { ...registeredRow, company_id: 'c-new' }, error: null })

    expect(await registerGrantedPeppolReceivers({ service, transport, now, limit: 1 })).toEqual({
      registered: ['c-new'], failed: [], skipped: [],
    })
    expect(transport.registerRecipient).toHaveBeenCalledTimes(1)
  })

  it('does nothing on a send-only transport or without grants, and throws when the history cannot be read', async () => {
    expect(await registerGranted(makeTransport({ registerRecipient: undefined }))).toEqual({ registered: [], failed: [], skipped: [] })
    expect(calls).toHaveLength(0)

    enqueue({ data: [], error: null })
    expect(await registerGranted(makeTransport())).toEqual({ registered: [], failed: [], skipped: [] })
    expect(calls.some((c) => c.table === 'peppol_registrations')).toBe(false)

    reset()
    enqueue({ data: [{ company_id: 'c-a', requested_by: null }], error: null })
    enqueue({ data: null, error: { message: 'boom' } })
    await expect(registerGranted(makeTransport())).rejects.toThrow('Failed to read Peppol registrations: boom')
  })
})
