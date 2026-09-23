import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ConversationRow } from '../conversation-display'
import {
  createRevisionGuard,
  patchConversation,
  removeRow,
  restoreRow,
  runOptimisticPatch,
  setPinned,
  setTitle,
} from '../conversation-mutations'

/**
 * These exercise the REAL transforms and the real write coordinator, not copies
 * of them: deleting the rollback or the response check makes this suite fail.
 *
 * What is being protected: the /chat sidebar used to fire pin, archive and
 * rename blind, so a failed archive removed a row that still existed on the
 * server and a failed rename showed a title the server never saved, both until
 * the next reload.
 */

const row = (over: Partial<ConversationRow> = {}): ConversationRow => ({
  id: 'c1',
  intent_id: 'general.help',
  context_ref: null,
  title: 'Juli mot juni',
  pinned: false,
  archived: false,
  last_message_at: '2026-07-26T10:00:00Z',
  last_message_preview: 'Juli gick 12 procent bättre',
  created_at: '2026-07-26T09:00:00Z',
  ...over,
})

/** Minimal stand-in for React's setState updater contract. */
function fakeState(initial: ConversationRow[]) {
  let current = initial
  return {
    set: (updater: (prev: ConversationRow[]) => ConversationRow[]) => {
      current = updater(current)
    },
    get list() {
      return current
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
  // restoreAllMocks does not undo vi.stubGlobal, so the stubbed fetch would
  // otherwise outlive this file.
  vi.unstubAllGlobals()
})

describe('restoreRow', () => {
  it('puts an archived row back into the CURRENT list, keeping later changes', () => {
    const a = row({ id: 'a', last_message_at: '2026-07-26T12:00:00Z' })
    const b = row({ id: 'b', last_message_at: '2026-07-26T11:00:00Z' })
    // While the archive of `a` was in flight, the user renamed `b`.
    const currentAfterOtherEdit = [{ ...b, title: 'Nytt namn' }]

    const restored = restoreRow(currentAfterOtherEdit, a)

    expect(restored.map((c) => c.id)).toEqual(['a', 'b'])
    // The concurrent rename must survive: restoring a stale snapshot of the
    // whole list would have thrown it away.
    expect(restored.find((c) => c.id === 'b')!.title).toBe('Nytt namn')
  })

  it('re-inserts by the server ordering: pinned first, then most recent', () => {
    const pinned = row({ id: 'p', pinned: true })
    const newer = row({ id: 'n', last_message_at: '2026-07-26T12:00:00Z' })
    const older = row({ id: 'o', last_message_at: '2026-07-20T12:00:00Z' })

    expect(restoreRow([newer, older], pinned).map((c) => c.id)).toEqual(['p', 'n', 'o'])
    expect(
      restoreRow([pinned, older], row({ id: 'mid', last_message_at: '2026-07-25T12:00:00Z' })).map(
        (c) => c.id,
      ),
    ).toEqual(['p', 'mid', 'o'])
  })

  it('is a no-op when the row is already present', () => {
    const list = [row({ id: 'a' })]
    expect(restoreRow(list, row({ id: 'a' }))).toBe(list)
  })
})

describe('runOptimisticPatch', () => {
  it('applies immediately and keeps the change when the server accepts it', async () => {
    const state = fakeState([row({ id: 'c1' })])
    const ok = await runOptimisticPatch({
      id: 'c1',
      body: { pinned: true },
      apply: (l) => setPinned(l, 'c1', true),
      revert: (l) => setPinned(l, 'c1', false),
      setList: state.set,
      guard: createRevisionGuard(),
      onError: () => {},
      patch: async () => true,
    })

    expect(ok).toBe(true)
    expect(state.list[0]!.pinned).toBe(true)
  })

  it('reverts and reports when the server refuses', async () => {
    const state = fakeState([row({ id: 'c1', title: 'Original' })])
    const onError = vi.fn()

    const ok = await runOptimisticPatch({
      id: 'c1',
      body: { title: 'Nytt' },
      apply: (l) => setTitle(l, 'c1', 'Nytt'),
      revert: (l) => setTitle(l, 'c1', 'Original'),
      setList: state.set,
      guard: createRevisionGuard(),
      onError,
      patch: async () => false,
    })

    expect(ok).toBe(false)
    expect(state.list[0]!.title).toBe('Original')
    expect(onError).toHaveBeenCalledOnce()
  })

  it('does not roll back over a newer write to the same row', async () => {
    // Double-click on pin: the first request fails AFTER the second has already
    // set the newer value. Reverting here would clobber it.
    const state = fakeState([row({ id: 'c1', pinned: false })])
    const guard = createRevisionGuard()
    const onError = vi.fn()

    let releaseFirst: (v: boolean) => void = () => {}
    const first = runOptimisticPatch({
      id: 'c1',
      body: { pinned: true },
      apply: (l) => setPinned(l, 'c1', true),
      revert: (l) => setPinned(l, 'c1', false),
      setList: state.set,
      guard,
      onError,
      patch: () => new Promise<boolean>((resolve) => (releaseFirst = resolve)),
    })

    // Second write lands and succeeds while the first is still in flight.
    await runOptimisticPatch({
      id: 'c1',
      body: { pinned: false },
      apply: (l) => setPinned(l, 'c1', false),
      revert: (l) => setPinned(l, 'c1', true),
      setList: state.set,
      guard,
      onError,
      patch: async () => true,
    })

    releaseFirst(false)
    await first

    // The newer write owns the row: its value stands and no error is shown for
    // a change the user already superseded.
    expect(state.list[0]!.pinned).toBe(false)
    expect(onError).not.toHaveBeenCalled()
  })

  it('still rolls back a stale write to a DIFFERENT row', async () => {
    const state = fakeState([row({ id: 'a', pinned: false }), row({ id: 'b', pinned: false })])
    const guard = createRevisionGuard()
    const onError = vi.fn()

    await runOptimisticPatch({
      id: 'b',
      body: { pinned: true },
      apply: (l) => setPinned(l, 'b', true),
      revert: (l) => setPinned(l, 'b', false),
      setList: state.set,
      guard,
      onError,
      patch: async () => true,
    })
    await runOptimisticPatch({
      id: 'a',
      body: { pinned: true },
      apply: (l) => setPinned(l, 'a', true),
      revert: (l) => setPinned(l, 'a', false),
      setList: state.set,
      guard,
      onError,
      patch: async () => false,
    })

    expect(state.list.find((c) => c.id === 'a')!.pinned).toBe(false)
    expect(state.list.find((c) => c.id === 'b')!.pinned).toBe(true)
    expect(onError).toHaveBeenCalledOnce()
  })

  it('restores an archived row into the list as it stands when the request fails', async () => {
    const archived = row({ id: 'a', last_message_at: '2026-07-26T12:00:00Z' })
    const other = row({ id: 'b', last_message_at: '2026-07-26T11:00:00Z' })
    const state = fakeState([archived, other])

    await runOptimisticPatch({
      id: 'a',
      body: { archived: true },
      apply: (l) => removeRow(l, 'a'),
      revert: (l) => restoreRow(l, archived),
      setList: state.set,
      guard: createRevisionGuard(),
      onError: () => {},
      patch: async () => false,
    })

    expect(state.list.map((c) => c.id)).toEqual(['a', 'b'])
  })
})

describe('patchConversation', () => {
  it('reports failure for a non-2xx instead of assuming success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }))
    expect(await patchConversation('c1', { pinned: true })).toBe(false)
  })

  it('reports failure when the request throws (offline)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    // Must not reject: an unhandled rejection was the old behaviour.
    expect(await patchConversation('c1', { pinned: true })).toBe(false)
  })

  it('sends the PATCH to the conversation endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)

    await patchConversation('c1', { archived: true })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/agent/conversations/c1',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ archived: true }) }),
    )
  })
})
