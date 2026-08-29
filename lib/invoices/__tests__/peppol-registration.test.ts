import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  PEPPOL_BIS_BILLING_CREDIT_NOTE_DOCUMENT_TYPE_ID,
  PEPPOL_RECEIVING_DOCUMENT_TYPES,
  deregisterCompanyFromPeppolReceiving,
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
  created_at: '2026-08-21T15:59:00.000Z',
  updated_at: '2026-08-21T16:00:00.000Z',
}

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

    const result = await registerCompanyForPeppolReceiving({
      service, companyId: 'company-1', userId: 'user-1', transport, settings,
    })

    expect(result).toEqual({ ok: true, registration: registeredRow })
    expect(transport.registerRecipient).toHaveBeenCalledWith({
      participant: { scheme: '0007', identifier: '5595386219' },
      businessCard: expect.objectContaining({ companyName: 'Arcim Technology AB', orgNumber: '5595386219' }),
      documentTypes: PEPPOL_RECEIVING_DOCUMENT_TYPES,
    })
    const inserted = calls.find((c) => c.method === 'insert')
    expect(inserted?.args[0]).toMatchObject({ status: 'pending', participant_identifier: '5595386219', company_id: 'company-1' })
    const finalized = calls.filter((c) => c.method === 'update').at(-1)
    expect(finalized?.args[0]).toMatchObject({ status: 'registered', provider_account_reference: 'SE5595386219', last_error: null })
  })

  it('records a failed registration with the provider reason and reports it', async () => {
    const transport = makeTransport({
      registerRecipient: vi.fn().mockRejectedValue(new PeppolTransportError('Qvalia answered 500', { retryable: true, detail: 'smp down' })),
    })
    enqueue({ data: [], error: null })
    enqueue({ data: { id: 'reg-1' }, error: null })
    enqueue({ data: null, error: null })                      // failure update

    const result = await registerCompanyForPeppolReceiving({
      service, companyId: 'company-1', userId: 'user-1', transport, settings,
    })
    expect(result).toEqual({ ok: false, code: 'PEPPOL_REGISTRATION_FAILED', detail: 'smp down' })
    const failed = calls.filter((c) => c.method === 'update').at(-1)
    expect(failed?.args[0]).toMatchObject({ status: 'failed', last_error: 'Qvalia answered 500: smp down' })
  })

  it('refuses the registration past the contracted cap, and lets an already-registered company through', async () => {
    process.env.PEPPOL_RECEIVING_MAX_REGISTRATIONS = '10'
    try {
      const transport = makeTransport()
      enqueue({ data: [], error: null })                       // no registration for this company
      enqueue({ data: null, error: null, count: 10 })          // live count at the cap
      expect(await registerCompanyForPeppolReceiving({
        service, companyId: 'company-1', userId: 'user-1', transport, settings,
      })).toEqual({ ok: false, code: 'PEPPOL_REGISTRATION_CAP_REACHED' })
      expect(transport.registerRecipient).not.toHaveBeenCalled()

      // A company that already holds a live row re-registers without consuming a slot.
      reset()
      enqueue({ data: [{ ...registeredRow, status: 'failed', registered_at: null }], error: null })
      enqueue({ data: registeredRow, error: null })
      // failed is not live, so the cap applies: count below cap lets it in
      reset()
      enqueue({ data: [registeredRow], error: null })          // live row exists
      enqueue({ data: registeredRow, error: null })            // finalize update
      expect((await registerCompanyForPeppolReceiving({
        service, companyId: 'company-1', userId: 'user-1', transport, settings,
      })).ok).toBe(true)
    } finally {
      delete process.env.PEPPOL_RECEIVING_MAX_REGISTRATIONS
    }
  })

  it('stops before the network on a personnummer and on a send-only transport', async () => {
    const transport = makeTransport()
    expect(await registerCompanyForPeppolReceiving({
      service, companyId: 'company-1', userId: 'user-1', transport, settings: { ...settings, org_number: '8001011234' },
    })).toEqual({ ok: false, code: 'PEPPOL_REGISTRATION_PERSONAL_NUMBER' })
    expect(transport.registerRecipient).not.toHaveBeenCalled()

    const sendOnly = makeTransport({ registerRecipient: undefined })
    expect(await registerCompanyForPeppolReceiving({
      service, companyId: 'company-1', userId: 'user-1', transport: sendOnly, settings,
    })).toEqual({ ok: false, code: 'PEPPOL_RECEIVING_UNSUPPORTED' })
  })
})

describe('deregisterCompanyFromPeppolReceiving', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
  })

  it('withdraws the live identifier and marks the row deregistered', async () => {
    const transport = makeTransport()
    enqueue({ data: [registeredRow], error: null })
    enqueue({ data: { ...registeredRow, status: 'deregistered', deregistered_at: '2026-08-21T17:00:00.000Z' }, error: null })
    const result = await deregisterCompanyFromPeppolReceiving({ service, companyId: 'company-1', transport })
    expect(result.ok).toBe(true)
    expect(transport.unregisterRecipient).toHaveBeenCalledWith({ scheme: '0007', identifier: '5595386219' })
  })

  it('reports not found when nothing is live', async () => {
    enqueue({ data: [{ ...registeredRow, status: 'deregistered' }], error: null })
    expect(await deregisterCompanyFromPeppolReceiving({ service, companyId: 'company-1', transport: makeTransport() }))
      .toEqual({ ok: false, code: 'PEPPOL_REGISTRATION_NOT_FOUND' })
  })
})
