import { describe, it, expect, vi, beforeEach } from 'vitest'

const capture = vi.fn()
let client: { capture: typeof capture } | null = { capture }
vi.mock('@/lib/analytics/posthog-server', () => ({ getPostHogServer: () => client }))

import { captureArkivEvent } from '../events'

beforeEach(() => {
  capture.mockReset()
  client = { capture }
})

describe('captureArkivEvent', () => {
  it('sends the event as the person when one acted, grouped on the company', () => {
    captureArkivEvent('arkiv_missing_resolved', { companyId: 'co-1', userId: 'user-1', rule: 'loan', note: 'not_exists' })
    expect(capture).toHaveBeenCalledWith({
      distinctId: 'user-1',
      event: 'arkiv_missing_resolved',
      properties: { rule: 'loan', note: 'not_exists', company_id: 'co-1' },
      groups: { company: 'co-1' },
    })
  })

  it('falls back to the company as the actor, and never throws', () => {
    captureArkivEvent('arkiv_document_landed', { companyId: 'co-1', doc_type: 'agreement.loan' })
    expect(capture.mock.calls[0][0]).toMatchObject({ distinctId: 'company:co-1' })
    capture.mockImplementation(() => {
      throw new Error('down')
    })
    expect(() => captureArkivEvent('arkiv_document_asked', { companyId: 'co-1' })).not.toThrow()
    client = null
    expect(() => captureArkivEvent('arkiv_document_asked', { companyId: 'co-1' })).not.toThrow()
  })
})
