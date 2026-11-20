/**
 * Removing several items from the Inkorg at once. Components are not rendered
 * in this suite (vitest runs in `node`), so the request helper is tested with
 * a stubbed fetch, and the copy and the wiring are pinned on the message
 * files and the component sources.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createTranslator } from 'next-intl'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import { removalCanBePutBack } from '@/lib/documents/inbox-item-state'
import { MAX_INBOX_ITEMS_PER_REMOVAL, removalUndoSentence } from '@/lib/inkorg/remove-items'
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

  // The confirm said "Det går inte att ångra" for every removal; since Senast borttagna that is true
  // only of an item whose removal keeps no copy. What it says now follows removalCanBePutBack, item
  // by item: the sentences are rendered here as the confirm renders them, from the rows a list holds.
  it('the confirm says how many, and what removalCanBePutBack allows: put back, cannot be undone, or how many of each, as the single removal does', () => {
    expect(sv.inkorg.bulk_drop_confirm_title).toContain('{count')
    expect(sv.inkorg.bulk_drop_confirm_title).toContain('ur Inkorgen?')

    type Row = Parameters<typeof removalCanBePutBack>[0]
    // Two that carry their file, and two whose removal keeps nothing to put back: no file, and a bank row has it.
    const kept: Row[] = [{ document_id: 'doc-1' }, { document_id: 'doc-2', status: 'error' }]
    const lost: Row[] = [{ document_id: null, status: 'error' }, { document_id: 'doc-3', matched_transaction_id: 'tx-1' }]
    const translator = (locale: 'sv' | 'en') =>
      createTranslator({
        locale,
        messages: locale === 'sv' ? sv : en,
        namespace: 'inkorg',
        onError: (error) => {
          throw error
        },
      }) as unknown as (key: string, values?: Record<string, number>) => string
    const bulk = (locale: 'sv' | 'en', picked: Row[]) => {
      const undo = removalUndoSentence(picked.length, picked.filter(removalCanBePutBack).length)
      return translator(locale)(undo.key, undo.values)
    }
    const single = (locale: 'sv' | 'en', item: Row) =>
      translator(locale)(removalCanBePutBack(item) ? 'drop_confirm_body_put_back' : 'drop_confirm_body')

    // None of the picked can come back: the sentence the confirm always had.
    expect(bulk('sv', lost)).toBe('Dokumenten sparas i arkivet men försvinner ur Inkorgen. Det går inte att ångra.')
    expect(bulk('en', lost)).toBe('The documents stay in the archive but leave the Inbox. This cannot be undone.')
    expect(bulk('sv', [lost[0]])).toBe('Dokumentet sparas i arkivet men försvinner ur Inkorgen. Det går inte att ångra.')

    // Every one can: Senast borttagna, and no word of "cannot be undone".
    expect(bulk('sv', kept)).toBe('Dokumenten sparas i arkivet men försvinner ur Inkorgen. Du kan lägga tillbaka dem från Senast borttagna.')
    expect(bulk('en', kept)).toBe('The documents stay in the archive but leave the Inbox. You can put them back from Recently removed.')
    expect(bulk('sv', [kept[0]])).toBe('Dokumentet sparas i arkivet men försvinner ur Inkorgen. Du kan lägga tillbaka det från Senast borttagna.')

    // A mix says how many of each, and promises nothing for all of them.
    expect(bulk('sv', [...kept, ...lost])).toBe(
      'Dokumenten försvinner ur Inkorgen. 2 kan du lägga tillbaka från Senast borttagna; 2 går inte att ångra.',
    )
    expect(bulk('sv', [...kept, lost[0]])).toBe(
      'Dokumenten försvinner ur Inkorgen. 2 kan du lägga tillbaka från Senast borttagna; 1 går inte att ångra.',
    )
    expect(bulk('en', [kept[0], ...lost])).toBe(
      'The documents leave the Inbox. You can put 1 of them back from Recently removed; 2 cannot be undone.',
    )

    // The single removal picks between the same two sentences by the same answer.
    expect(single('sv', kept[0])).toBe('Dokumentet sparas i arkivet men försvinner ur Inkorgen. Du kan lägga tillbaka det från Senast borttagna.')
    expect(single('sv', lost[0])).toBe('Dokumentet sparas i arkivet men försvinner ur Inkorgen. Det går inte att ångra.')
    expect(single('sv', lost[1])).toBe(single('sv', lost[0]))
    expect(single('en', kept[0])).toBe('The document stays in the archive but leaves the Inbox. You can put it back from Recently removed.')
    expect(single('en', lost[0])).toBe('The document stays in the archive but leaves the Inbox. This cannot be undone.')
  })

  // A removal is put back only when the item kept a copy and nothing has its document
  // (removalCanBePutBack): the confirm promises Senast borttagna, and the toast offers Ångra,
  // for those and no others. An item without a file used to be promised both, and Ångra answered 404.
  it('promises a way back in its own sentences, in both languages, and keeps "cannot be undone" for the rest', () => {
    for (const key of ['drop_confirm_body_put_back', 'bulk_drop_confirm_body_put_back', 'bulk_drop_confirm_body_mixed', 'drop_done'] as const) {
      expect(sv.inkorg[key]).toBeTruthy()
      expect(en.inkorg[key]).toBeTruthy()
    }
    for (const key of ['drop_confirm_body_put_back', 'bulk_drop_confirm_body_put_back'] as const) {
      expect(sv.inkorg[key]).toContain('Senast borttagna')
      expect(sv.inkorg[key]).not.toContain('går inte att ångra')
      expect(en.inkorg[key]).toContain('Recently removed')
      expect(en.inkorg[key]).not.toContain('cannot be undone')
    }
    expect(sv.inkorg.drop_confirm_body).toContain('Det går inte att ångra.')
    expect(sv.inkorg.drop_confirm_body).not.toContain('Senast borttagna')
    expect(en.inkorg.drop_confirm_body).toContain('This cannot be undone.')
    expect(sv.inkorg.bulk_drop_confirm_body).not.toContain('Senast borttagna')
    // The mix says how many of each.
    for (const messages of [sv, en]) {
      expect(messages.inkorg.bulk_drop_confirm_body_mixed).toContain('{putBack')
      expect(messages.inkorg.bulk_drop_confirm_body_mixed).toContain('{final')
    }
  })

  it('the bar, the single removal and the workspace all ask removalCanBePutBack before they promise or offer Ångra', () => {
    const page = read('InkorgPage.tsx')
    // The single removal's toast, with its Ångra, only for an item that can come back.
    expect(page).toMatch(/if \(outcome\.dropped && removalCanBePutBack\(item\)\) toast\(\{ title: t\('drop_done'\), action: undoRemoval\(\[id\]\) \}\)/)
    expect(page).toContain('queue.filter(removalCanBePutBack)')
    expect(page).toMatch(/<RemoveSeveralBar[^>]*putBackIds=\{putBackIds\}/)

    const bar = read('RemoveSeveralBar.tsx')
    expect(bar).toContain('removalUndoSentence(ids.length, putBack.size)')
    expect(bar).toMatch(/const undoable = summary\.removedIds\.filter\(\(id\) => putBack\.has\(id\)\)/)
    expect(bar).toMatch(/action: undoable\.length > 0 \? undoRemoval\(undoable\) : undefined/)

    const decision = read('FocusDecision.tsx')
    expect(decision).toMatch(/description: removalCanBePutBack\(item\) \? t\('drop_confirm_body_put_back'\) : t\('drop_confirm_body'\)/)

    const workspace = read('../extensions/general/InvoiceInboxWorkspace.tsx')
    expect(workspace.match(/removalCanBePutBack\(/g)?.length).toBe(2)
    // Its own reading of "a bank row has it" is gone: one answer.
    expect(workspace).not.toContain('wasMatched')
    expect(workspace).not.toMatch(/!it\.matched_transaction_id\)\s*\n\s*\.map/)
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
