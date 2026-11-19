/**
 * A company that already sends through Kivra via another service: Kivra
 * answers the sender registration 409, Accounted asks for access to the
 * existing sender, and sending switches on when Kivra accepts, from the
 * admin's switch or the cron. Kivra's flow: POST /v2/tenant answers 409,
 * POST /v2/tenant/request_access, then GET /v2/tenant/request_access/{key}
 * until it is accepted or rejected.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DigitalMailboxConnection } from '../connections'
import { DigitalMailboxApiError } from '../http'
import type { SenderRegistration } from '../types'

const getConnection = vi.hoisted(() => vi.fn())
const upsertConnection = vi.hoisted(() => vi.fn())
const listPendingSenderConnections = vi.hoisted(() => vi.fn())
const getDigitalMailboxProviders = vi.hoisted(() => vi.fn())

vi.mock('../connections', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../connections')>()),
  getConnection,
  upsertConnection,
  listPendingSenderConnections,
}))
vi.mock('../providers', () => ({ getDigitalMailboxProviders, isDigitalMailboxEnabled: () => true }))

import { activateSending, checkPendingSenderRequests, deactivateSending } from '../connect'
import { summariseConnection } from '../connections'

const COMPANY = '11111111-1111-4111-8111-111111111111'
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as never

const registerSender = vi.fn<(company: { orgNumber: string; name: string }) => Promise<SenderRegistration>>()
const checkSenderRequest = vi.fn<(ref: string) => Promise<SenderRegistration>>()

function row(overrides: Partial<DigitalMailboxConnection> = {}): DigitalMailboxConnection {
  return {
    id: 'conn-kivra',
    company_id: COMPANY,
    provider: 'kivra',
    receive_state: 'active',
    account_ref: 'ck1',
    mailbox_ref: null,
    receive_since: null,
    receive_connected_by: null,
    receive_connected_at: null,
    receive_ended_at: null,
    last_synced_at: null,
    send_state: 'off',
    tenant_ref: null,
    send_activated_by: null,
    send_activated_at: null,
    last_error: null,
    last_error_at: null,
    provider_meta: { failing_since: null },
    created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-01T00:00:00Z',
    ...overrides,
  }
}

const pendingRow = (by = 'admin-1') =>
  row({
    provider_meta: {
      failing_since: null,
      sender_request: { ref: 'req-1', status: 'pending', requested_at: '2026-11-19T13:00:00Z', requested_by: by },
    },
  })

/** company_settings for the company: a limited company with its organisationsnummer. */
const service = {
  from: () => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => ({
        data: { company_name: 'Säljare AB', org_number: '442005-9208', address_line1: null, postal_code: null, city: null, is_sandbox: false },
        error: null,
      }),
    }
    return chain
  },
} as unknown as SupabaseClient

/** The row upsertConnection would write: the existing row with the patch on top. */
function writesOnto(existing: DigitalMailboxConnection | null) {
  upsertConnection.mockImplementation(async (_s, companyId, provider, patch) => ({
    ...(existing ?? row()),
    company_id: companyId,
    provider,
    ...patch,
  }))
}

beforeEach(() => {
  vi.clearAllMocks()
  getDigitalMailboxProviders.mockReturnValue({ kivra: { sender: { registerSender, checkSenderRequest } }, billo: null })
})

describe('activateSending for a company that is a Kivra sender through another service', () => {
  it('records the access request and answers it as waiting, with sending still off', async () => {
    getConnection.mockResolvedValue(row())
    writesOnto(row())
    registerSender.mockResolvedValue({ status: 'pending', requestRef: 'req-1' })

    const outcome = await activateSending(service, { companyId: COMPANY, userId: 'admin-1', provider: 'kivra', log })

    expect(outcome.ok).toBe(true)
    const patch = upsertConnection.mock.calls[0]![3]
    expect(patch.send_state).toBeUndefined()
    expect(patch.provider_meta).toEqual({
      failing_since: null,
      sender_request: { ref: 'req-1', status: 'pending', requested_at: expect.any(String), requested_by: 'admin-1' },
    })
    if (outcome.ok) {
      expect(summariseConnection(outcome.data)).toMatchObject({ send_state: 'off', send_request: 'pending' })
    }
  })

  it('asks about the waiting request instead of making a new one, and switches sending on when Kivra accepted', async () => {
    const existing = pendingRow()
    getConnection.mockResolvedValue(existing)
    writesOnto(existing)
    checkSenderRequest.mockResolvedValue({ status: 'active', tenantRef: 'tk-other' })

    const outcome = await activateSending(service, { companyId: COMPANY, userId: 'admin-2', provider: 'kivra', log })

    expect(registerSender).not.toHaveBeenCalled()
    expect(checkSenderRequest).toHaveBeenCalledWith('req-1')
    expect(outcome.ok).toBe(true)
    const patch = upsertConnection.mock.calls[0]![3]
    expect(patch).toMatchObject({ send_state: 'active', tenant_ref: 'tk-other', send_activated_by: 'admin-2' })
    expect(patch.provider_meta).toEqual({ failing_since: null })
  })

  it('keeps the time the request was first made while it waits', async () => {
    const existing = pendingRow()
    getConnection.mockResolvedValue(existing)
    writesOnto(existing)
    checkSenderRequest.mockResolvedValue({ status: 'pending', requestRef: 'req-1' })

    await activateSending(service, { companyId: COMPANY, userId: 'admin-1', provider: 'kivra', log })

    expect(upsertConnection.mock.calls[0]![3].provider_meta.sender_request.requested_at).toBe('2026-11-19T13:00:00Z')
  })

  it('refuses with the rejection, not a failure to retry, and records it for the row', async () => {
    getConnection.mockResolvedValue(pendingRow())
    writesOnto(pendingRow())
    checkSenderRequest.mockResolvedValue({ status: 'rejected', requestRef: 'req-1' })

    const outcome = await activateSending(service, { companyId: COMPANY, userId: 'admin-1', provider: 'kivra', log })

    expect(outcome).toEqual({ ok: false, code: 'DIGITAL_MAILBOX_SENDER_REQUEST_REJECTED' })
    expect(upsertConnection.mock.calls[0]![3].provider_meta.sender_request.status).toBe('rejected')
  })

  it('makes a new request after a rejection, so a company can try again', async () => {
    const existing = row({
      provider_meta: { sender_request: { ref: 'req-1', status: 'rejected', requested_at: '2026-11-19T13:00:00Z', requested_by: 'admin-1' } },
    })
    getConnection.mockResolvedValue(existing)
    writesOnto(existing)
    registerSender.mockResolvedValue({ status: 'pending', requestRef: 'req-2' })

    await activateSending(service, { companyId: COMPANY, userId: 'admin-1', provider: 'kivra', log })

    expect(checkSenderRequest).not.toHaveBeenCalled()
    expect(registerSender).toHaveBeenCalledWith({ orgNumber: '4420059208', name: 'Säljare AB' })
  })

  it('refuses a conflict Kivra would not take a request for as standing, not retryable', async () => {
    getConnection.mockResolvedValue(row())
    registerSender.mockRejectedValue(new DigitalMailboxApiError('kivra', 'conflict', 'tenant access request answered 403', 403, 'sender_elsewhere'))

    const outcome = await activateSending(service, { companyId: COMPANY, userId: 'admin-1', provider: 'kivra', log })

    expect(outcome).toMatchObject({ ok: false, code: 'DIGITAL_MAILBOX_SENDER_ELSEWHERE' })
    expect(upsertConnection).not.toHaveBeenCalled()
  })

  it('still answers Kivra being down as a failure to retry', async () => {
    getConnection.mockResolvedValue(row())
    registerSender.mockRejectedValue(new DigitalMailboxApiError('kivra', 'unavailable', 'tenant registration answered 503', 503))

    const outcome = await activateSending(service, { companyId: COMPANY, userId: 'admin-1', provider: 'kivra', log })

    expect(outcome).toMatchObject({ ok: false, code: 'DIGITAL_MAILBOX_PROVIDER_FAILED' })
  })
})

describe('deactivateSending', () => {
  it('drops a waiting request, so an acceptance later does not switch sending on', async () => {
    getConnection.mockResolvedValue(pendingRow())
    writesOnto(pendingRow())

    const connection = await deactivateSending(service, { companyId: COMPANY, provider: 'kivra' })

    expect(upsertConnection.mock.calls[0]![3]).toEqual({ provider_meta: { failing_since: null } })
    expect(summariseConnection(connection!).send_request).toBeNull()
  })
})

describe('checkPendingSenderRequests (cron)', () => {
  it('switches sending on for an accepted request, in the name of the admin who asked', async () => {
    listPendingSenderConnections.mockResolvedValue([pendingRow('admin-1')])
    writesOnto(pendingRow('admin-1'))
    checkSenderRequest.mockResolvedValue({ status: 'active', tenantRef: 'tk-other' })

    const summary = await checkPendingSenderRequests(service, { log })

    expect(summary).toEqual({ checked: 1, activated: 1, rejected: 0, errors: [] })
    expect(upsertConnection.mock.calls[0]![3]).toMatchObject({ send_state: 'active', tenant_ref: 'tk-other', send_activated_by: 'admin-1' })
  })

  it('leaves a request Kivra has not decided untouched, and keeps going past one that fails', async () => {
    const other = { ...pendingRow(), id: 'conn-2', company_id: '22222222-2222-4222-8222-222222222222' }
    listPendingSenderConnections.mockResolvedValue([pendingRow(), other])
    checkSenderRequest
      .mockRejectedValueOnce(new DigitalMailboxApiError('kivra', 'unavailable', 'tenant access request status answered 503', 503))
      .mockResolvedValueOnce({ status: 'pending', requestRef: 'req-1' })

    const summary = await checkPendingSenderRequests(service, { log })

    expect(summary.checked).toBe(2)
    expect(summary.activated).toBe(0)
    expect(summary.errors).toHaveLength(1)
    expect(upsertConnection).not.toHaveBeenCalled()
  })

  it('does not read the database when no provider can follow a request up', async () => {
    getDigitalMailboxProviders.mockReturnValue({ kivra: { sender: { registerSender } }, billo: null })

    await expect(checkPendingSenderRequests(service, { log })).resolves.toEqual({ checked: 0, activated: 0, rejected: 0, errors: [] })
    expect(listPendingSenderConnections).not.toHaveBeenCalled()
  })
})
