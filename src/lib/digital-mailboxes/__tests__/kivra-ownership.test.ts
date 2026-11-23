import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRowsMockSupabase } from '@/tests/helpers'

const findCompanyKey = vi.hoisted(() => vi.fn())

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn(), createClient: vi.fn() }))
vi.mock('../providers', () => ({
  getDigitalMailboxProviders: () => ({
    kivra: { receiver: { findCompanyKey }, config: { onboardingUrl: 'https://example.test/kivra', webhookSecret: 'whsec' } },
    billo: null,
  }),
  isDigitalMailboxEnabled: () => true,
}))

import { activatePendingKivra, connectKivraReceive, onKivraIntegrationCreated } from '../connect'
import type { DigitalMailboxConnection } from '../connections'
import type { KivraProvider } from '../kivra'

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as never

const ORG = '4420059208'
const COMPANY = 'company-1'
const OTHER = 'company-2'
const ADMIN = 'user-admin'
const LINKED = '2026-09-01T10:00:00Z'
const READ = '2026-11-01T10:00:00Z'

type Row = Record<string, unknown>

function settings(companyId: string, orgNumber: string, extra: Row = {}): Row {
  return {
    company_id: companyId,
    company_name: `Bolag ${companyId}`,
    org_number: orgNumber,
    address_line1: null,
    postal_code: null,
    city: null,
    is_sandbox: false,
    'companies.archived_at': null,
    ...extra,
  }
}

/** A proven BankID login whose register roles were read after it was linked. */
function bankId(userId: string, positionTypes: string[], orgNumber = ORG, extra: { email_verified_at?: string | null; updated_at?: string } = {}) {
  return {
    identity: { user_id: userId, email_verified_at: 'email_verified_at' in extra ? extra.email_verified_at : LINKED, linked_at: LINKED },
    enrichment: {
      user_id: userId,
      updated_at: extra.updated_at ?? READ,
      company_roles: [{ companyRegistrationNumber: orgNumber, positionTypes, positionDescriptions: [], positionEnd: null }],
    },
  }
}

function pendingRow(companyId: string, connectedBy: string | null): Row {
  return {
    id: `conn-${companyId}`,
    company_id: companyId,
    provider: 'kivra',
    receive_state: 'pending',
    account_ref: null,
    receive_since: '2026-10-01T00:00:00Z',
    receive_connected_at: '2026-10-31T00:00:00Z',
    receive_connected_by: connectedBy,
  }
}

function world(opts: {
  settings: Row[]
  bankIds?: Array<ReturnType<typeof bankId>>
  members?: Array<{ company_id: string; user_id: string }>
  connections?: Row[]
}) {
  const writes: { table: string; method: string; row: unknown }[] = []
  const mock = createRowsMockSupabase(
    {
      company_settings: opts.settings,
      digital_mailbox_connections: opts.connections ?? [],
      bankid_identities: (opts.bankIds ?? []).map((b) => b.identity),
      bankid_enrichment: (opts.bankIds ?? []).map((b) => b.enrichment),
      company_members: opts.members ?? [],
    },
    writes,
  )
  const connectionWrites = () => writes.filter((w) => w.table === 'digital_mailbox_connections')
  return { service: mock.supabase as unknown as SupabaseClient, connectionWrites }
}

const kivra = { receiver: { findCompanyKey } } as unknown as KivraProvider

beforeEach(() => {
  vi.clearAllMocks()
  findCompanyKey.mockResolvedValue('ck-company')
})

describe('connectKivraReceive: the admin must be a firmatecknare of the org number', () => {
  it('refuses an admin with no BankID login, before anything is written or Kivra is asked', async () => {
    const { service, connectionWrites } = world({ settings: [settings(COMPANY, ORG)] })

    const outcome = await connectKivraReceive(service, { companyId: COMPANY, userId: ADMIN, log })

    expect(outcome).toEqual({ ok: false, code: 'DIGITAL_MAILBOX_SIGNATORY_BANKID_REQUIRED' })
    expect(connectionWrites()).toEqual([])
    expect(findCompanyKey).not.toHaveBeenCalled()
  })

  it('refuses a BankID login whose address was never confirmed', async () => {
    const { service } = world({ settings: [settings(COMPANY, ORG)], bankIds: [bankId(ADMIN, ['LE'], ORG, { email_verified_at: null })] })
    await expect(connectKivraReceive(service, { companyId: COMPANY, userId: ADMIN, log })).resolves.toEqual({
      ok: false,
      code: 'DIGITAL_MAILBOX_SIGNATORY_BANKID_REQUIRED',
    })
  })

  it('does not count register roles read before the BankID identity was linked', async () => {
    const { service } = world({ settings: [settings(COMPANY, ORG)], bankIds: [bankId(ADMIN, ['LE'], ORG, { updated_at: '2026-08-01T00:00:00Z' })] })
    await expect(connectKivraReceive(service, { companyId: COMPANY, userId: ADMIN, log })).resolves.toEqual({
      ok: false,
      code: 'DIGITAL_MAILBOX_SIGNATORY_BANKID_REQUIRED',
    })
  })

  it('refuses an admin the register lists for another company only', async () => {
    const { service, connectionWrites } = world({ settings: [settings(COMPANY, ORG)], bankIds: [bankId(ADMIN, ['LE', 'VD'], '5560125790')] })

    const outcome = await connectKivraReceive(service, { companyId: COMPANY, userId: ADMIN, log })

    expect(outcome).toEqual({ ok: false, code: 'DIGITAL_MAILBOX_NOT_SIGNATORY' })
    expect(connectionWrites()).toEqual([])
  })

  it('refuses a styrelsesuppleant or a revisor: neither signs for the company', async () => {
    const { service } = world({ settings: [settings(COMPANY, ORG)], bankIds: [bankId(ADMIN, ['SU', 'REV'])] })
    await expect(connectKivraReceive(service, { companyId: COMPANY, userId: ADMIN, log })).resolves.toEqual({
      ok: false,
      code: 'DIGITAL_MAILBOX_NOT_SIGNATORY',
    })
  })

  it('refuses when another live company holds the same org number, in whatever form it is stored', async () => {
    const { service, connectionWrites } = world({
      settings: [settings(COMPANY, ORG), settings(OTHER, '16442005-9208')],
      bankIds: [bankId(ADMIN, ['LE'])],
    })

    const outcome = await connectKivraReceive(service, { companyId: COMPANY, userId: ADMIN, log })

    expect(outcome).toEqual({ ok: false, code: 'DIGITAL_MAILBOX_ORG_NUMBER_SHARED' })
    expect(connectionWrites()).toEqual([])
    expect(findCompanyKey).not.toHaveBeenCalled()
  })

  it('connects a firmatecknare when the other holders are archived or the demo company', async () => {
    const { service, connectionWrites } = world({
      settings: [
        settings(COMPANY, '442005-9208'),
        settings(OTHER, ORG, { 'companies.archived_at': '2026-10-01T00:00:00Z' }),
        settings('company-demo', ORG, { is_sandbox: true }),
      ],
      bankIds: [bankId(ADMIN, ['VD'])],
    })

    const outcome = await connectKivraReceive(service, { companyId: COMPANY, userId: ADMIN, log })

    expect(outcome.ok).toBe(true)
    expect(findCompanyKey).toHaveBeenCalledWith(ORG)
    expect(connectionWrites().map((w) => w.row)).toEqual([
      expect.objectContaining({ company_id: COMPANY, receive_state: 'pending', receive_connected_by: ADMIN }),
      expect.objectContaining({ company_id: COMPANY, receive_state: 'active', account_ref: 'ck-company' }),
    ])
  })
})

describe('onKivraIntegrationCreated: Kivra activation binds only a proven, single holder', () => {
  const event = { companyKey: 'ck-company', vatNumber: `SE${ORG}01` }

  it('binds nobody when two live companies hold the org number, whoever started connecting', async () => {
    const { service, connectionWrites } = world({
      settings: [settings(COMPANY, ORG), settings(OTHER, '442005-9208')],
      bankIds: [bankId('user-other', ['LE'])],
      members: [{ company_id: OTHER, user_id: 'user-other' }],
      connections: [pendingRow(OTHER, 'user-other')],
    })

    await expect(onKivraIntegrationCreated(service, event, log)).resolves.toBeNull()
    expect(connectionWrites()).toEqual([])
  })

  it('binds nobody when the waiting row was started by someone who is not a firmatecknare', async () => {
    const { service, connectionWrites } = world({
      settings: [settings(COMPANY, ORG)],
      bankIds: [bankId('user-ceo', ['VD']), bankId(ADMIN, ['SU'])],
      members: [{ company_id: COMPANY, user_id: 'user-ceo' }, { company_id: COMPANY, user_id: ADMIN }],
      connections: [pendingRow(COMPANY, ADMIN)],
    })

    await expect(onKivraIntegrationCreated(service, event, log)).resolves.toBeNull()
    expect(connectionWrites()).toEqual([])
  })

  it('binds the waiting row a firmatecknare started', async () => {
    const { service, connectionWrites } = world({
      settings: [settings(COMPANY, ORG)],
      bankIds: [bankId(ADMIN, ['LE'])],
      connections: [pendingRow(COMPANY, ADMIN)],
    })

    await expect(onKivraIntegrationCreated(service, event, log)).resolves.toBe(COMPANY)
    expect(connectionWrites().map((w) => w.row)).toEqual([
      expect.objectContaining({ company_id: COMPANY, receive_state: 'active', account_ref: 'ck-company' }),
    ])
  })

  it('binds an activation begun at Kivra when a member of the one holder is a firmatecknare', async () => {
    const { service, connectionWrites } = world({
      settings: [settings(COMPANY, ORG)],
      bankIds: [bankId('user-ceo', ['OF'])],
      members: [{ company_id: COMPANY, user_id: 'user-bookkeeper' }, { company_id: COMPANY, user_id: 'user-ceo' }],
    })

    await expect(onKivraIntegrationCreated(service, event, log)).resolves.toBe(COMPANY)
    expect(connectionWrites().at(-1)?.row).toMatchObject({ company_id: COMPANY, receive_state: 'active', account_ref: 'ck-company' })
  })

  it('binds nobody for an activation begun at Kivra when no member proves the number', async () => {
    const { service, connectionWrites } = world({
      settings: [settings(COMPANY, ORG)],
      members: [{ company_id: COMPANY, user_id: 'user-bookkeeper' }],
    })

    await expect(onKivraIntegrationCreated(service, event, log)).resolves.toBeNull()
    expect(connectionWrites()).toEqual([])
  })

  it('leaves a company that already reads the inbox as it is', async () => {
    const { service, connectionWrites } = world({
      settings: [settings(COMPANY, ORG), settings(OTHER, ORG)],
      connections: [{ ...pendingRow(COMPANY, null), receive_state: 'active', account_ref: 'ck-company' }],
    })

    await expect(onKivraIntegrationCreated(service, event, log)).resolves.toBe(COMPANY)
    expect(connectionWrites()).toEqual([])
  })
})

describe('activatePendingKivra: a waiting row activates only for a proven, single holder', () => {
  it('holds back a row whose connector is not a firmatecknare, unchanged and without asking Kivra', async () => {
    const row = pendingRow(COMPANY, ADMIN) as unknown as DigitalMailboxConnection
    const { service, connectionWrites } = world({ settings: [settings(COMPANY, ORG)], connections: [row as unknown as Row] })

    const outcome = await activatePendingKivra(service, kivra, row, ORG, log)

    expect(outcome).toEqual({ ok: false, code: 'DIGITAL_MAILBOX_SIGNATORY_BANKID_REQUIRED' })
    expect(findCompanyKey).not.toHaveBeenCalled()
    expect(connectionWrites()).toEqual([])
  })

  it('activates the row of a firmatecknare once Kivra lists the company', async () => {
    const row = pendingRow(COMPANY, ADMIN) as unknown as DigitalMailboxConnection
    const { service } = world({ settings: [settings(COMPANY, ORG)], bankIds: [bankId(ADMIN, ['EFT'])], connections: [row as unknown as Row] })

    const outcome = await activatePendingKivra(service, kivra, row, ORG, log)

    expect(outcome).toEqual({ ok: true, data: expect.objectContaining({ receive_state: 'active', account_ref: 'ck-company' }) })
  })

  it('answers no row while Kivra does not list the company yet', async () => {
    findCompanyKey.mockResolvedValue(null)
    const row = pendingRow(COMPANY, ADMIN) as unknown as DigitalMailboxConnection
    const { service } = world({ settings: [settings(COMPANY, ORG)], bankIds: [bankId(ADMIN, ['LE'])], connections: [row as unknown as Row] })

    await expect(activatePendingKivra(service, kivra, row, ORG, log)).resolves.toEqual({ ok: true, data: null })
  })
})
