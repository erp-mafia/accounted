import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: vi.fn(() => ({ tag: 'service' })) }))
vi.mock('@/lib/documents/jobs/queue', () => ({ enqueueDocumentJob: vi.fn() }))

import { eventBus } from '@/lib/events/bus'
import { enqueueDocumentJob } from '@/lib/documents/jobs/queue'
import { registerDocumentReadHandler } from '../document-read-handler'

const upload = (documentCompanyId: string | null) =>
  eventBus.emit({
    type: 'document.uploaded',
    payload: { document: { id: 'doc-1', company_id: documentCompanyId } as never, userId: 'user-1', companyId: 'co-1' },
  })

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  registerDocumentReadHandler()
})

describe('document read handler', () => {
  it('queues a read job for the uploaded document, falling back to the event company', async () => {
    ;(enqueueDocumentJob as ReturnType<typeof vi.fn>).mockResolvedValue(true)
    await upload('co-2')
    expect(enqueueDocumentJob).toHaveBeenLastCalledWith({ tag: 'service' }, 'co-2', 'doc-1', 'read')
    await upload(null)
    expect(enqueueDocumentJob).toHaveBeenLastCalledWith({ tag: 'service' }, 'co-1', 'doc-1', 'read')
  })

  it('never fails the upload when queueing fails', async () => {
    ;(enqueueDocumentJob as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('database unavailable'))
    await expect(upload('co-1')).resolves.toBeUndefined()
  })
})
