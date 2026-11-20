/**
 * journal-entries.cancel-draft: the staged way out of a DRAFT verifikat for an
 * agent (agent feedback seq 978933: year_end_readiness reported a draft and no
 * MCP tool could clear it). The rules live in cancelDraftJournalEntry, shared
 * with v1 DELETE /journal-entries/{id}; these tests pin them through the
 * operation: only drafts, never past a lock, the engine as the only writer,
 * and no staged no-op for a draft that is already cancelled.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bookkeeping/engine')>()
  return { ...actual, cancelDraftEntry: vi.fn() }
})

import { cancelDraftEntry } from '@/lib/bookkeeping/engine'
import { CannotCancelNonDraftError } from '@/lib/bookkeeping/errors'
import { createLogger } from '@/lib/logger'
import { journalEntriesCancelDraft } from '../journal-entries'
import type { OperationContext } from '../types'

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ENTRY_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PERIOD_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

const DRAFT = {
  id: ENTRY_ID,
  fiscal_period_id: PERIOD_ID,
  voucher_series: 'A',
  voucher_number: 0,
  entry_date: '2026-05-12',
  description: 'Bankavgift maj',
  status: 'draft',
  source_type: 'manual',
  source_id: null,
  notes: null,
  reverses_id: null,
  reversed_by_id: null,
  correction_of_id: null,
  created_at: '2026-05-12T08:00:00Z',
  updated_at: '2026-05-12T08:00:00Z',
}
const OPEN_PERIOD = { id: PERIOD_ID, is_closed: false, locked_at: null }
const NO_LOCK_DATE = { bookkeeping_locked_through: null }
/** The draft's current-version documents: none. */
const NO_DOCUMENTS = { data: [], count: 0 }

function setup() {
  const mock = createQueuedMockSupabase()
  const ctx: OperationContext = {
    supabase: mock.supabase as never,
    companyId: COMPANY_ID,
    userId: 'user-1',
    log: createLogger('test'),
  }
  return { ...mock, ctx }
}

const run = (ctx: OperationContext, dryRun: boolean, journal_entry_id = ENTRY_ID) =>
  journalEntriesCancelDraft.run(ctx, { journal_entry_id }, { dryRun })

beforeEach(() => {
  vi.clearAllMocks()
})

describe('journal-entries.cancel-draft: contract', () => {
  it('is a low-risk bookkeeping:write that stages over MCP as cancel_draft_entry', () => {
    expect(journalEntriesCancelDraft.kind).toBe('write')
    expect(journalEntriesCancelDraft.scope).toBe('bookkeeping:write')
    expect(journalEntriesCancelDraft.risk).toBe('low')
    expect(journalEntriesCancelDraft.mcp?.name).toBe('gnubok_cancel_draft_entry')
    expect(journalEntriesCancelDraft.mcp?.stage?.pendingType).toBe('cancel_draft_entry')
    // Search-only: reachable through gnubok_stage_tool, no tools/list cost.
    expect(journalEntriesCancelDraft.mcp?.visibility).toBeUndefined()
  })

  it('refuses an id that is not a UUID (validation, 400)', () => {
    const parsed = journalEntriesCancelDraft.input.safeParse({ journal_entry_id: 'not-a-uuid' })
    expect(parsed.success).toBe(false)
  })
})

describe('journal-entries.cancel-draft: run', () => {
  it('answers JOURNAL_ENTRY_NOT_FOUND for an entry outside this company (404)', async () => {
    const { ctx, enqueue } = setup()
    enqueue({ data: null })

    const outcome = await run(ctx, true)

    expect(outcome).toMatchObject({ ok: false, code: 'JOURNAL_ENTRY_NOT_FOUND' })
    expect(cancelDraftEntry).not.toHaveBeenCalled()
  })

  it('refuses a posted entry with CANNOT_CANCEL_NON_DRAFT: storno is its only way out', async () => {
    const { ctx, enqueue } = setup()
    enqueue({ data: { ...DRAFT, status: 'posted', voucher_number: 142 } })

    const outcome = await run(ctx, false)

    expect(outcome).toMatchObject({
      ok: false,
      code: 'CANNOT_CANCEL_NON_DRAFT',
      details: { currentStatus: 'posted' },
    })
    expect(cancelDraftEntry).not.toHaveBeenCalled()
  })

  it('answers PERIOD_LOCKED for a draft in a locked period, before any write', async () => {
    const { ctx, enqueueMany } = setup()
    enqueueMany([
      { data: DRAFT },
      NO_DOCUMENTS,
      { data: NO_LOCK_DATE },
      { data: { ...OPEN_PERIOD, locked_at: '2026-06-01T00:00:00Z' } },
    ])

    const outcome = await run(ctx, false)

    expect(outcome).toMatchObject({
      ok: false,
      code: 'PERIOD_LOCKED',
      details: { reason: 'period_locked_at_set', fiscal_period_id: PERIOD_ID, entry_date: DRAFT.entry_date },
    })
    expect(cancelDraftEntry).not.toHaveBeenCalled()
  })

  it('answers PERIOD_LOCKED behind the company lock date too', async () => {
    const { ctx, enqueueMany } = setup()
    enqueueMany([{ data: DRAFT }, NO_DOCUMENTS, { data: { bookkeeping_locked_through: '2026-06-30' } }])

    const outcome = await run(ctx, true)

    expect(outcome).toMatchObject({ ok: false, code: 'PERIOD_LOCKED', details: { reason: 'company_lock_date_covers' } })
  })

  it('previews the cancel on a dry run and writes nothing (the staging preview)', async () => {
    const { ctx, enqueueMany } = setup()
    enqueueMany([{ data: DRAFT }, NO_DOCUMENTS, { data: NO_LOCK_DATE }, { data: OPEN_PERIOD }])

    const outcome = await run(ctx, true)

    expect(outcome).toMatchObject({
      ok: true,
      dryRun: true,
      preview: {
        journal_entry_id: ENTRY_ID,
        status: 'cancelled',
        current_status: 'draft',
        would_release_voucher_number: false,
      },
    })
    expect(cancelDraftEntry).not.toHaveBeenCalled()
  })

  it('cancels the draft through the engine on commit and answers the cancelled header', async () => {
    const { ctx, enqueueMany, supabase } = setup()
    enqueueMany([
      { data: DRAFT },
      NO_DOCUMENTS,
      { data: NO_LOCK_DATE },
      { data: OPEN_PERIOD },
      { data: { ...DRAFT, status: 'cancelled' } },
    ])
    vi.mocked(cancelDraftEntry).mockResolvedValue({ ...DRAFT, status: 'cancelled' } as never)

    const outcome = await run(ctx, false)

    expect(cancelDraftEntry).toHaveBeenCalledWith(supabase, COMPANY_ID, 'user-1', ENTRY_ID)
    expect(outcome).toMatchObject({ ok: true, data: { id: ENTRY_ID, status: 'cancelled', voucher_number: 0 } })
  })

  it('passes the engine refusal through when the draft was committed in between', async () => {
    const { ctx, enqueueMany } = setup()
    enqueueMany([{ data: DRAFT }, NO_DOCUMENTS, { data: NO_LOCK_DATE }, { data: OPEN_PERIOD }])
    vi.mocked(cancelDraftEntry).mockRejectedValue(new CannotCancelNonDraftError('posted'))

    const outcome = await run(ctx, false)

    expect(outcome).toMatchObject({ ok: false, code: 'CANNOT_CANCEL_NON_DRAFT' })
  })

  // Review: a draft can hold underlag, and once cancelled its
  // documents can never be re-pointed (enforce_document_journal_entry_
  // immutability), so the cancel is refused and the documents are named.
  it('refuses a draft that holds documents with DRAFT_HAS_DOCUMENTS, on the staging dry run and on commit', async () => {
    const DOCS = [
      { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', file_name: 'kvitto.pdf' },
      { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', file_name: 'faktura.pdf' },
    ]
    for (const dryRun of [true, false]) {
      const { ctx, enqueueMany, findCalls } = setup()
      enqueueMany([{ data: DRAFT }, { data: DOCS, count: 2 }])

      const outcome = await run(ctx, dryRun)

      expect(outcome).toMatchObject({
        ok: false,
        code: 'DRAFT_HAS_DOCUMENTS',
        details: {
          journal_entry_id: ENTRY_ID,
          document_count: 2,
          documents: [
            { document_id: DOCS[0].id, file_name: 'kvitto.pdf' },
            { document_id: DOCS[1].id, file_name: 'faktura.pdf' },
          ],
        },
      })
      expect((outcome as { messageSv?: string }).messageSv).toMatch(/2 bilagor/)
      // Only this draft's current-version documents count.
      expect(findCalls('document_attachments', 'eq')).toEqual(
        expect.arrayContaining([
          ['company_id', COMPANY_ID],
          ['journal_entry_id', ENTRY_ID],
          ['is_current_version', true],
        ]),
      )
    }
    expect(cancelDraftEntry).not.toHaveBeenCalled()
  })

  it('stages nothing for a draft that is already cancelled, and commits it as a no-op', async () => {
    const staging = setup()
    staging.enqueue({ data: { ...DRAFT, status: 'cancelled' } })
    expect(await run(staging.ctx, true)).toMatchObject({ ok: false, code: 'JOURNAL_ENTRY_ALREADY_CANCELLED' })

    // An operation staged before a concurrent cancel still approves cleanly.
    const commit = setup()
    commit.enqueue({ data: { ...DRAFT, status: 'cancelled' } })
    expect(await run(commit.ctx, false)).toMatchObject({ ok: true, data: { id: ENTRY_ID, status: 'cancelled' } })
    expect(cancelDraftEntry).not.toHaveBeenCalled()
  })
})
