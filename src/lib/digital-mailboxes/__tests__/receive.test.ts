import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DigitalMailboxConnection } from '../connections'
import type { MailboxReceiver } from '../types'

const fileInboxDelivery = vi.hoisted(() => vi.fn())
const registryGet = vi.hoisted(() => vi.fn())
const recordArrival = vi.hoisted(() => vi.fn())
const recordDocumentArrival = vi.hoisted(() => vi.fn())
const linkArrivalOutputs = vi.hoisted(() => vi.fn())
const uploadDocument = vi.hoisted(() => vi.fn())

vi.mock('@/lib/extensions/registry', () => ({ extensionRegistry: { get: registryGet } }))
vi.mock('@/lib/intake/arrivals', () => ({
  recordArrival,
  recordDocumentArrival,
  linkArrivalOutputs,
  sanitiseArrivalJson: (v: unknown) => v,
}))
vi.mock('@/lib/core/documents/document-service', () => ({ uploadDocument }))

import { deliverMailboxDocument, InboxUnavailableError, resolveInboxOwner, syncConnection } from '../receive'

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as never

/**
 * A chainable stub of the few service-role reads and writes receive.ts makes:
 * arrivals lookups answer from `knownArrivals`, company_members from
 * `members`, connection updates are recorded.
 */
function serviceStub(opts: { knownArrivals?: Set<string>; members?: Array<{ user_id: string; role: string }> } = {}) {
  const known = opts.knownArrivals ?? new Set<string>()
  const members = opts.members ?? [{ user_id: 'owner-1', role: 'owner' }]
  const updates: Array<Record<string, unknown>> = []
  const from = (table: string) => {
    const filters: Record<string, unknown> = {}
    const chain: Record<string, unknown> = {}
    const self = () => chain
    chain.select = self
    chain.order = self
    chain.limit = self
    chain.eq = (col: string, val: unknown) => {
      filters[col] = val
      return chain
    }
    chain.update = (patch: Record<string, unknown>) => {
      updates.push(patch)
      return chain
    }
    chain.maybeSingle = async () => {
      if (table === 'arrivals') return { data: known.has(String(filters.source_ref)) ? { id: 'a' } : null, error: null }
      if (table === 'company_members') {
        const hit = members.find((m) => (filters.user_id ? m.user_id === filters.user_id : m.role === filters.role))
        return { data: hit ? { user_id: hit.user_id } : null, error: null }
      }
      return { data: null, error: null }
    }
    // Awaiting an update chain.
    chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null })
    return chain
  }
  return { client: { from } as unknown as SupabaseClient, updates }
}

const connection: DigitalMailboxConnection = {
  id: 'conn-1',
  company_id: '11111111-1111-4111-8111-111111111111',
  provider: 'kivra',
  receive_state: 'active',
  account_ref: 'ck1',
  mailbox_ref: null,
  receive_since: '2026-09-01T00:00:00Z',
  receive_connected_by: 'user-1',
  receive_connected_at: '2026-10-01T00:00:00Z',
  receive_ended_at: null,
  last_synced_at: null,
  send_state: 'off',
  tenant_ref: null,
  send_activated_by: null,
  send_activated_at: null,
  last_error: null,
  last_error_at: null,
  provider_meta: {},
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
}

const pdf = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer

function receiver(overrides: Partial<MailboxReceiver> = {}): MailboxReceiver {
  return {
    listDocuments: vi.fn(async () => []),
    getDocument: vi.fn(async (_account, ref: string) => ({
      document: {
        ref,
        receivedAt: '2026-10-10T00:00:00Z',
        subject: `Faktura ${ref}`,
        senderName: 'Leverantör AB',
        senderOrgNumber: '4420059216',
        kind: 'invoice' as const,
        meta: { type: 'invoice' },
      },
      files: [
        { name: `${ref}.pdf`, contentType: 'application/pdf', bytes: pdf('%PDF main') },
        { name: `${ref}-spec.pdf`, contentType: 'application/pdf', bytes: pdf('%PDF spec') },
      ],
    })),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  registryGet.mockResolvedValue({ services: { fileInboxDelivery } })
  fileInboxDelivery.mockResolvedValue({ document_id: 'doc-1', inbox_item_id: 'item-1', deduplicated: false })
  recordDocumentArrival.mockResolvedValue({ arrival: { id: 'arr-1', company_id: connection.company_id }, created: true })
  uploadDocument.mockResolvedValue({ id: 'doc-2' })
})

describe('deliverMailboxDocument', () => {
  it('files the first part as the inbox item, archives the rest under the same arrival', async () => {
    const { client } = serviceStub()
    const outcome = await deliverMailboxDocument(client, {
      connection,
      receiver: receiver(),
      ref: 'c1',
      ownerId: 'user-1',
      actor: { type: 'cron', label: 'Kivra' },
      log,
    })
    expect(outcome).toBe('filed')
    expect(fileInboxDelivery).toHaveBeenCalledWith(client, expect.objectContaining({
      userId: 'user-1',
      companyId: connection.company_id,
      kindHint: 'supplier_invoice',
      senderName: 'Leverantör AB',
      channelContext: { intake_source: 'kivra', external_ref: 'c1' },
      file: expect.objectContaining({ name: 'c1.pdf', type: 'application/pdf' }),
    }))
    expect(recordDocumentArrival).toHaveBeenCalledWith(client, expect.objectContaining({
      source: 'kivra',
      sourceRef: 'c1',
      documentId: 'doc-1',
      inboxItemId: 'item-1',
      sender: { name: 'Leverantör AB', org_number: '4420059216' },
    }))
    expect(uploadDocument).toHaveBeenCalledTimes(1)
    expect(linkArrivalOutputs).toHaveBeenCalledWith(client, { id: 'arr-1', company_id: connection.company_id }, [
      { kind: 'document', id: 'doc-2', role: 'attachment' },
    ])
  })

  it('answers already without calling the provider when an arrival records the document', async () => {
    const { client } = serviceStub({ knownArrivals: new Set(['c1']) })
    const r = receiver()
    await expect(
      deliverMailboxDocument(client, { connection, receiver: r, ref: 'c1', ownerId: 'user-1', actor: { type: 'cron' }, log }),
    ).resolves.toBe('already')
    expect(r.getDocument).not.toHaveBeenCalled()
    expect(fileInboxDelivery).not.toHaveBeenCalled()
  })

  it('records a letter with no file part as an arrival, so it is not fetched again', async () => {
    const { client } = serviceStub()
    const r = receiver({
      getDocument: vi.fn(async () => ({
        document: { ref: 'c2', receivedAt: null, subject: 'Hej', senderName: null, senderOrgNumber: null, kind: 'other' as const, meta: {} },
        files: [],
      })),
    })
    await expect(
      deliverMailboxDocument(client, { connection, receiver: r, ref: 'c2', ownerId: 'user-1', actor: { type: 'cron' }, log }),
    ).resolves.toBe('no_file')
    expect(recordArrival).toHaveBeenCalledWith(client, expect.objectContaining({ source: 'kivra', sourceRef: 'c2', sourceMeta: expect.objectContaining({ skipped: 'no_file_part' }) }))
    expect(fileInboxDelivery).not.toHaveBeenCalled()
  })

  it('refuses when the deployment has no inbox extension', async () => {
    registryGet.mockResolvedValue(undefined)
    const { client } = serviceStub()
    await expect(
      deliverMailboxDocument(client, { connection, receiver: receiver(), ref: 'c1', ownerId: 'user-1', actor: { type: 'cron' }, log }),
    ).rejects.toBeInstanceOf(InboxUnavailableError)
  })
})

describe('syncConnection', () => {
  it('files what is new, skips what is known, caps the run and records the sync', async () => {
    const { client, updates } = serviceStub({ knownArrivals: new Set(['known']) })
    const r = receiver({
      listDocuments: vi.fn(async () => [
        { ref: 'c3', receivedAt: '2026-10-12T00:00:00Z' },
        { ref: 'known', receivedAt: '2026-10-01T00:00:00Z' },
        { ref: 'c1', receivedAt: '2026-10-10T00:00:00Z' },
        { ref: 'c2', receivedAt: '2026-10-11T00:00:00Z' },
      ]),
    })
    const result = await syncConnection(client, { connection, receiver: r, actor: { type: 'cron' }, log, maxDocuments: 2 })
    expect(result).toEqual({ filed: 2, already: 1, noFile: 0, failed: 0, more: true })
    expect(r.listDocuments).toHaveBeenCalledWith({ accountRef: 'ck1', mailboxRef: null }, new Date('2026-09-01T00:00:00Z'))
    // Oldest first.
    expect((r.getDocument as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1])).toEqual(['c1', 'c2'])
    expect(updates.at(-1)).toMatchObject({ last_error: null })
    expect(updates.at(-1)?.last_synced_at).toEqual(expect.any(String))
  })

  it('counts a failing document and keeps going, with the reason on the connection', async () => {
    const { client, updates } = serviceStub()
    const r = receiver({
      listDocuments: vi.fn(async () => [
        { ref: 'bad', receivedAt: '2026-10-10T00:00:00Z' },
        { ref: 'good', receivedAt: '2026-10-11T00:00:00Z' },
      ]),
    })
    ;(r.getDocument as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('provider down'))
    const result = await syncConnection(client, { connection, receiver: r, actor: { type: 'cron' }, log })
    expect(result).toMatchObject({ filed: 1, failed: 1 })
    expect(updates.at(-1)).toMatchObject({ last_error: 'provider down' })
  })

  it('does nothing for a connection that is not active', async () => {
    const { client } = serviceStub()
    const r = receiver()
    await expect(
      syncConnection(client, { connection: { ...connection, receive_state: 'pending' }, receiver: r, actor: { type: 'cron' }, log }),
    ).resolves.toEqual({ filed: 0, already: 0, noFile: 0, failed: 0, more: false })
    expect(r.listDocuments).not.toHaveBeenCalled()
  })
})

describe('resolveInboxOwner', () => {
  it('prefers the member who connected, else the first owner', async () => {
    expect(await resolveInboxOwner(serviceStub({ members: [{ user_id: 'user-1', role: 'admin' }, { user_id: 'owner-1', role: 'owner' }] }).client, connection)).toBe('user-1')
    expect(await resolveInboxOwner(serviceStub({ members: [{ user_id: 'owner-1', role: 'owner' }] }).client, connection)).toBe('owner-1')
    expect(await resolveInboxOwner(serviceStub({ members: [] }).client, connection)).toBeNull()
  })
})
