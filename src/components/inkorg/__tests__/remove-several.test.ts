/**
 * Removing several items from the Inkorg at once. Components are not rendered
 * in this suite (vitest runs in `node`), so the request helper is tested with
 * a stubbed fetch, and the copy and the wiring are pinned on the message
 * files and the component sources.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import { MAX_INBOX_ITEMS_PER_REMOVAL } from '@/lib/inkorg/remove-items'
import { REMOVE_ITEMS_URL, removeInboxItems } from '../remove-items-client'

const read = (file: string) => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8')

const answer = (ids: string[]) =>
  new Response(JSON.stringify({ data: { results: ids.map((id) => ({ id, removed: true })) } }), { status: 200, headers: { 'content-type': 'application/json' } })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('removeInboxItems', () => {
  it('sends the selection as one request', async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => answer(['a', 'b']))
    vi.stubGlobal('fetch', fetchMock)

    const result = await removeInboxItems(['a', 'b'], 'sv')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(REMOVE_ITEMS_URL)
    const init = fetchMock.mock.calls[0][1] as { method: string; body: string }
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ inbox_item_ids: ['a', 'b'] })
    expect(result).toEqual({ results: [{ id: 'a', removed: true }, { id: 'b', removed: true }], failure: null })
  })

  it('sends a selection over the bound in parts, and stops at a request that fails, keeping what was answered', async () => {
    const ids = Array.from({ length: MAX_INBOX_ITEMS_PER_REMOVAL * 2 + 1 }, (_, n) => `id-${n}`)
    const fetchMock = vi
      .fn(async (..._args: unknown[]) => answer([]))
      .mockImplementationOnce(async (..._args: unknown[]) => answer(ids.slice(0, MAX_INBOX_ITEMS_PER_REMOVAL)))
      .mockImplementationOnce(
        async (..._args: unknown[]) =>
          new Response(JSON.stringify({ error: { code: 'UNKNOWN_ERROR', message: 'Något gick fel. Försök igen.' } }), { status: 500, headers: { 'content-type': 'application/json' } }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const result = await removeInboxItems(ids, 'sv')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.results).toHaveLength(MAX_INBOX_ITEMS_PER_REMOVAL)
    expect(result.failure).toBe('Något gick fel. Försök igen.')
  })

  it('never throws when the request does not reach the server', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    expect(await removeInboxItems(['a'], 'sv')).toEqual({ results: [], failure: '' })
  })
})

describe('Inkorg: remove several, copy and wiring', () => {
  const keys = [
    'bulk_selected',
    'bulk_select_all',
    'bulk_clear',
    'bulk_select_row',
    'bulk_drop_confirm_title',
    'bulk_drop_confirm_body',
    'bulk_drop_done',
    'bulk_drop_refused_line',
    'bulk_drop_untried',
  ] as const

  it('every string exists in Swedish and English', () => {
    for (const key of keys) {
      expect(sv.inkorg[key]).toBeTruthy()
      expect(en.inkorg[key]).toBeTruthy()
    }
  })

  it('the confirm says how many and that it cannot be undone, as the single removal does', () => {
    expect(sv.inkorg.bulk_drop_confirm_title).toContain('{count')
    expect(sv.inkorg.bulk_drop_confirm_title).toContain('ur Inkorgen?')
    expect(sv.inkorg.bulk_drop_confirm_body).toContain('Det går inte att ångra.')
    expect(sv.inkorg.bulk_drop_confirm_body).toContain('sparas i arkivet')
    expect(en.inkorg.bulk_drop_confirm_body).toContain('This cannot be undone.')
  })

  it('the bar is the lists\' shared bulk bar, and its action opens the confirm before any request', () => {
    const bar = read('RemoveSeveralBar.tsx')
    expect(bar).toContain('<BulkSelectionBar')
    expect(bar).toContain("{t('action_not_underlag')}")
    const body = bar.slice(bar.indexOf('async function removeSelected()'))
    const confirmAt = body.indexOf('await confirm(')
    const requestAt = body.indexOf('await removeInboxItems(')
    expect(confirmAt).toBeGreaterThan(-1)
    expect(requestAt).toBeGreaterThan(confirmAt)
  })

  it('a row can be picked only when the focus view would offer its removal, and only by someone who can write', () => {
    const page = read('InkorgPage.tsx')
    expect(page).toContain('queue.filter(offersRemoval)')
    expect(page).toMatch(/canWrite && view\.kind !== 'missing' && itemsState === 'ready' \? queue\.filter\(offersRemoval\)/)
    expect(page).toContain('useBulkSelection(removableIds)')
    const list = read('InkorgList.tsx')
    expect(list).toContain('<RowSelectCheckbox')
    expect(list).toContain('selection && selectableIds?.has(item.id) ? selection.toggle : undefined')
  })
})
