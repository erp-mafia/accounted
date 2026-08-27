/**
 * The unlinked-document predicate, and above all the mime allow-list, which is
 * the part that decides whether this surface is useful or actively harmful.
 */
import { describe, it, expect } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  fetchUnlinkedDocuments,
  UNDERLAG_MIME_TYPES,
  UNLINKED_DOCUMENT_SCAN_CAP,
} from '../unlinked-documents'

type Enqueue = (r: { data?: unknown; error?: unknown; count?: number | null }) => void

/** One empty result per referencing table, so nothing claims any candidate. */
function enqueueNoReferences(enqueue: Enqueue) {
  for (let i = 0; i < 8; i += 1) enqueue({ data: [] })
}

const doc = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  file_name: `${id}.pdf`,
  mime_type: 'application/pdf',
  file_size_bytes: 1024,
  upload_source: 'api',
  created_at: '2026-08-01T00:00:00.000Z',
  ...overrides,
})

describe('UNDERLAG_MIME_TYPES', () => {
  it('excludes application/json, which on this surface is only the PSD2 archive', () => {
    // Measured on production 2026-08-27: of the document rows referenced by
    // nothing, application/json was 11 309 of 11 309 archived PSD2 bank-API
    // responses, and 0 of 4 495 pdf/png/jpeg/heic rows were. Those archives are
    // unlinked BY DESIGN. Admitting them here would hand an agent 11 309 items
    // of work it must not do, which is worse than showing nothing at all.
    expect(UNDERLAG_MIME_TYPES).not.toContain('application/json')
  })

  it('is an allow-list, so a future machine payload format stays out by default', () => {
    // The alternative, excluding known-bad filenames, leaks every new archive
    // format until someone notices and adds another exclusion.
    for (const mime of UNDERLAG_MIME_TYPES) {
      expect(mime === 'application/pdf' || mime.startsWith('image/')).toBe(true)
    }
  })
})

describe('fetchUnlinkedDocuments', () => {
  it('costs exactly one query when the company has no candidates', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [] })
    // Deliberately NOT enqueueing the eight reference lookups: if the early
    // return regressed, the mock would starve and this test would fail.

    const result = await fetchUnlinkedDocuments(supabase as never, 'company-1')

    expect(result).toEqual({ documents: [], count: 0, capped: false })
  })

  it('returns candidates that no table references', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [doc('d-1'), doc('d-2')] })
    enqueueNoReferences(enqueue)

    const result = await fetchUnlinkedDocuments(supabase as never, 'company-1')

    expect(result.count).toBe(2)
    expect(result.documents.map((d) => d.id)).toEqual(['d-1', 'd-2'])
    expect(result.capped).toBe(false)
  })

  it('drops a candidate claimed by any one of the eight referencing tables', async () => {
    // Walk the tables one at a time: a document claimed only by the Nth table
    // must still be excluded, which is what catches a missing entry in the list.
    for (let table = 0; table < 8; table += 1) {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: [doc('d-claimed'), doc('d-free')] })
      for (let i = 0; i < 8; i += 1) {
        // Every referencing query selects its own column name, and the
        // implementation reads whichever key the row carries.
        enqueue({ data: i === table ? [{ document_id: 'd-claimed', document_attachment_id: 'd-claimed', xml_document_id: 'd-claimed', dokument_id: 'd-claimed', file_document_id: 'd-claimed' }] : [] })
      }

      const result = await fetchUnlinkedDocuments(supabase as never, 'company-1')

      expect(result.documents.map((d) => d.id), `table index ${table}`).toEqual(['d-free'])
    }
  })

  it('reports capped when the candidate scan hits the limit', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const many = Array.from({ length: 3 }, (_, i) => doc(`d-${i}`))
    enqueue({ data: many })
    enqueueNoReferences(enqueue)

    const result = await fetchUnlinkedDocuments(supabase as never, 'company-1', { limit: 3 })

    // count is a floor, not a total, and the caller says so in its prose.
    expect(result.capped).toBe(true)
    expect(result.count).toBe(3)
  })

  it('keeps the scan cap small enough that the eight .in() lookups stay valid URLs', () => {
    // Each candidate id is echoed back through eight .in(column, ids) queries,
    // and a UUID costs ~38 bytes in a PostgREST query string. Past a few
    // hundred the URL exceeds what the gateway accepts, the lookups fail, and
    // the "claims nothing" fallback turns every candidate into a false
    // positive. This is the constraint that sets the cap, not table size.
    const bytesPerLookup = UNLINKED_DOCUMENT_SCAN_CAP * 38
    expect(bytesPerLookup).toBeLessThan(16_000)
  })
})
