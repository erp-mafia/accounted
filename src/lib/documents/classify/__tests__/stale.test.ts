import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const enqueueDocumentJob = vi.fn()
vi.mock('@/lib/documents/jobs/queue', () => ({ enqueueDocumentJob: (...args: unknown[]) => enqueueDocumentJob(...args) }))

import { requeueStaleVerdicts } from '../stale'
import { CLASSIFY_RULES, isStaleVerdict } from '../rules'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()

const verdict = (id: string, over: Partial<{ doc_type: string; rules_version: string | null; created_at: string }> = {}) => ({
  document_id: id,
  company_id: 'company-1',
  doc_type: 'customer_invoice',
  rules_version: null,
  created_at: '2026-09-21T20:00:00Z',
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  enqueueDocumentJob.mockResolvedValue(true)
})

describe('isStaleVerdict', () => {
  it('is stale when made under another version, or unversioned from before the rule for its type changed', () => {
    expect(isStaleVerdict(verdict('a'))).toBe(true)
    expect(isStaleVerdict(verdict('b', { rules_version: '2026-09-20' }))).toBe(true)
    expect(isStaleVerdict(verdict('c', { rules_version: CLASSIFY_RULES.version }))).toBe(false)
    // Unversioned but made after the rule for customer invoices last changed: the current rule made it.
    expect(isStaleVerdict(verdict('d', { created_at: '2026-09-27T12:00:00Z' }))).toBe(false)
    // A type no rule change touched is never stale, however old.
    expect(isStaleVerdict(verdict('e', { doc_type: 'agreement.loan', created_at: '2026-09-01T00:00:00Z' }))).toBe(false)
    expect(isStaleVerdict(verdict('f', { doc_type: 'decision.skatteverket', created_at: '2026-09-25T10:00:00Z' }))).toBe(true)
    expect(isStaleVerdict(verdict('g', { doc_type: 'decision.skatteverket', created_at: '2026-09-25T20:00:00Z' }))).toBe(false)
  })
})

describe('requeueStaleVerdicts', () => {
  it('queues the oldest stale verdicts up to the limit, leaving out busy or failed jobs and documents with no pages', async () => {
    enqueue({
      data: [
        verdict('doc-old'),
        verdict('doc-failed'),
        verdict('doc-unread'),
        verdict('doc-fresh', { created_at: '2026-09-27T12:00:00Z' }),
        verdict('doc-also-old'),
        verdict('doc-over-limit'),
      ],
    })
    // The other two rule changes have nothing stale.
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ data: [{ document_id: 'doc-failed', status: 'failed' }, { document_id: 'doc-old', status: 'done' }] })
    enqueue({
      data: [
        { id: 'doc-old', pages_read_at: '2026-09-21', admission_state: 'admitted' },
        { id: 'doc-failed', pages_read_at: '2026-09-21', admission_state: 'admitted' },
        { id: 'doc-unread', pages_read_at: null, admission_state: 'admitted' },
        { id: 'doc-also-old', pages_read_at: '2026-09-21', admission_state: 'held' },
        { id: 'doc-over-limit', pages_read_at: '2026-09-21', admission_state: 'admitted' },
      ],
    })
    const out = await requeueStaleVerdicts(supabase as never, 2)
    expect(out).toEqual({ candidates: 5, queued: 2, skipped: 2 })
    expect(enqueueDocumentJob.mock.calls.map((c) => c[2])).toEqual(['doc-old', 'doc-also-old'])
    expect(enqueueDocumentJob.mock.calls.every((c) => c[3] === 'classify')).toBe(true)
    // One query per rule change, each for its own types with its own cut-off.
    expect(findCalls('document_classifications', 'in').map((c) => c[1])).toEqual([['customer_invoice'], ['decision.skatteverket'], ['other']])
    expect(String(findCalls('document_classifications', 'or')[0][0])).toContain('created_at.lt.2026-09-27T09:03:00Z')
  })

  it('does nothing when no verdict is stale', async () => {
    enqueue({ data: [verdict('doc-fresh', { rules_version: CLASSIFY_RULES.version })] })
    enqueue({ data: [] })
    enqueue({ data: [] })
    const out = await requeueStaleVerdicts(supabase as never, 10)
    expect(out).toEqual({ candidates: 0, queued: 0, skipped: 0 })
    expect(enqueueDocumentJob).not.toHaveBeenCalled()
  })
})
