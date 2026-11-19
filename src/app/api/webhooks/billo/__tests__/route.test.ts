import { createHmac } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const providers = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))
const findReceivingConnection = vi.hoisted(() => vi.fn())
const deliver = vi.hoisted(() => ({ deliverMailboxDocument: vi.fn(), resolveInboxOwner: vi.fn() }))
const afterTasks = vi.hoisted(() => [] as Array<() => Promise<void>>)

vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: (task: () => Promise<void>) => afterTasks.push(task),
}))
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: () => ({}) }))
vi.mock('@/lib/digital-mailboxes/providers', () => ({ getDigitalMailboxProviders: () => providers.value }))
vi.mock('@/lib/digital-mailboxes/connections', () => ({ findReceivingConnection }))
vi.mock('@/lib/digital-mailboxes/receive', () => deliver)

import { POST } from '../route'

const SECRET_BYTES = Buffer.from('billo-webhook-secret-material')
const SECRET = `whsec_${SECRET_BYTES.toString('base64')}`

function signed(body: unknown, opts: { eventType?: string; key?: Buffer } = {}) {
  const payload = JSON.stringify(body)
  const id = 'msg_1'
  const t = String(Math.floor(Date.now() / 1000))
  const sig = createHmac('sha256', opts.key ?? SECRET_BYTES).update(`${id}.${t}.${payload}`).digest('base64')
  return new Request('http://localhost/api/webhooks/billo', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': t,
      'webhook-signature': `v1,${sig}`,
      'x-billo-event-type': opts.eventType ?? 'PartnerDocumentReceived',
    },
    body: payload,
  })
}

describe('POST /api/webhooks/billo', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    afterTasks.length = 0
    providers.value = { billo: { receiver: {}, config: { webhookSecret: SECRET } } }
  })

  it('answers 503 when Billo is not configured', async () => {
    providers.value = {}
    expect((await POST(signed({ documentId: 'd' }))).status).toBe(503)
  })

  it('refuses a bad Standard Webhooks signature', async () => {
    expect((await POST(signed({ documentId: 'd' }, { key: Buffer.from('other') }))).status).toBe(401)
  })

  it('ignores events other than a received document', async () => {
    const response = await POST(signed({ documentId: 'd', endCustomerId: 'en' }, { eventType: 'InvoiceRead' }))
    expect(await response.json()).toEqual({ data: { ignored: true } })
    expect(findReceivingConnection).not.toHaveBeenCalled()
  })

  it('leaves the older body without an enrolment to the sweep', async () => {
    const response = await POST(signed({ document_id: 'd', event_time: 'x' }))
    expect(await response.json()).toEqual({ data: { routed: false } })
  })

  it('files a received document after the response', async () => {
    const connection = { company_id: 'company-1', receive_state: 'active' }
    findReceivingConnection.mockResolvedValue(connection)
    deliver.resolveInboxOwner.mockResolvedValue('owner-1')
    deliver.deliverMailboxDocument.mockResolvedValue('filed')
    const response = await POST(signed({ documentId: 'd', endCustomerId: 'en', clientId: 'pc', occurredAt: 'x' }))
    expect(await response.json()).toEqual({ data: { routed: true } })
    expect(findReceivingConnection).toHaveBeenCalledWith(expect.anything(), 'billo', { mailboxRef: 'en' })
    await afterTasks[0]!()
    expect(deliver.deliverMailboxDocument).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ ref: 'd', ownerId: 'owner-1' }))
  })
})
