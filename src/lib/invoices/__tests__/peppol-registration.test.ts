import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  PEPPOL_BIS_BILLING_CREDIT_NOTE_DOCUMENT_TYPE_ID,
  PEPPOL_PENDING_STALE_MS,
  PEPPOL_RECEIVING_DOCUMENT_TYPES,
  canRetryPeppolRegistration,
  deregisterCompanyFromPeppolReceiving,
  describePeppolParticipantEligibility,
  isStalePeppolPending,
  preparePeppolParticipant,
  registerCompanyForPeppolReceiving,
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
    expect(preparePeppolParticipant({ ...settings, org_number: '198001011234' })).toEqual({ ok: false, code: 'PEPPOL_REGISTRATION_ORG_NUMBER_REQUIRED' })
    expect(preparePeppolParticipant({ ...settings, org_number: '8001011234' })).toEqual({ ok: false, code: 'PEPPOL_REGISTRATION_PERSONAL_NUMBER' })
    expect(preparePeppolParticipant({ ...settings, company_name: ' ' })).toEqual({ ok: false, code: 'PEPPOL_REGISTRATION_COMPANY_NAME_REQUIRED' })
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
