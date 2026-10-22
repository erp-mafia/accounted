import { createHmac } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const providers = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))
const connect = vi.hoisted(() => ({ onKivraIntegrationCreated: vi.fn(), onKivraIntegrationDeleted: vi.fn() }))
const findReceivingConnection = vi.hoisted(() => vi.fn())
const deliver = vi.hoisted(() => ({ deliverMailboxDocument: vi.fn(), resolveInboxOwner: vi.fn() }))
const afterTasks = vi.hoisted(() => [] as Array<() => Promise<void>>)

vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: (task: () => Promise<void>) => afterTasks.push(task),
}))
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: () => ({}) }))
vi.mock('@/lib/digital-mailboxes/providers', () => ({ getDigitalMailboxProviders: () => providers.value }))
vi.mock('@/lib/digital-mailboxes/connect', () => connect)
vi.mock('@/lib/digital-mailboxes/connections', () => ({ findReceivingConnection }))
vi.mock('@/lib/digital-mailboxes/receive', () => deliver)

import { POST } from '../route'

const SECRET = 'kivra-shared-secret'

function signed(body: unknown, opts: { secret?: string; t?: number } = {}) {
  const payload = JSON.stringify(body)
  const t = opts.t ?? Math.floor(Date.now() / 1000)
  const sig = createHmac('sha256', opts.secret ?? SECRET).update(`${t}:${payload}`).digest('hex')
  return new Request('http://localhost/api/webhooks/kivra', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-kivra-timestamp': String(t), 'x-kivra-signature': `v1=${sig}` },
    body: payload,
  })
}

describe('POST /api/webhooks/kivra', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    afterTasks.length = 0
    providers.value = { kivra: { receiver: {}, config: { webhookSecret: SECRET } } }
  })

  it('answers 503 when Kivra is not configured', async () => {
    providers.value = {}
    const response = await POST(signed({ id: 'event_1', event_type: 'content.created', data: { company_key: 'ck' } }))
    expect(response.status).toBe(503)
  })

  it('refuses a delivery signed with another secret', async () => {
    const response = await POST(signed({ id: 'event_1', event_type: 'content.created', data: { company_key: 'ck' } }, { secret: 'other' }))
    expect(response.status).toBe(401)
    expect(findReceivingConnection).not.toHaveBeenCalled()
  })

  it('binds the company on integration.created', async () => {
    connect.onKivraIntegrationCreated.mockResolvedValue('company-1')
    const response = await POST(signed({ id: 'event_2', event_type: 'integration.created', data: { company_key: 'ck', vat_number: 'SE442005920801' } }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: { bound: true } })
    expect(connect.onKivraIntegrationCreated).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ companyKey: 'ck', vatNumber: 'SE442005920801' }), expect.anything())
  })

  it('answers content.created at once and files the content after the response', async () => {
    const connection = { company_id: 'company-1', receive_state: 'active' }
    findReceivingConnection.mockResolvedValue(connection)
    deliver.resolveInboxOwner.mockResolvedValue('owner-1')
    deliver.deliverMailboxDocument.mockResolvedValue('filed')
    const response = await POST(signed({ id: 'event_3', event_type: 'content.created', data: { company_key: 'ck', content_key: 'cc', vat_number: 'SE442005920801' } }))
    expect(response.status).toBe(200)
    expect(deliver.deliverMailboxDocument).not.toHaveBeenCalled()
    await afterTasks[0]!()
    expect(deliver.deliverMailboxDocument).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ connection, ref: 'cc', ownerId: 'owner-1' }))
  })

  it('acknowledges content for a company that is not connected without filing anything', async () => {
    findReceivingConnection.mockResolvedValue(null)
    const response = await POST(signed({ id: 'event_4', event_type: 'content.created', data: { company_key: 'ck', content_key: 'cc' } }))
    expect(await response.json()).toEqual({ data: { routed: false } })
    expect(afterTasks).toHaveLength(0)
  })
})
