import { describe, expect, it } from 'vitest'
import {
  PICTURE_ROWS,
  WIKI_VIEWS,
  isPictureRow,
  knowledgeItemId,
  knowledgeItemParam,
  legacyKnowledgeHref,
  parseWikiView,
  pictureAgentHref,
  pictureAgentOf,
  pictureHrefOfView,
  pictureRowHref,
  pictureRowOf,
  wikiPlace,
  wikiViewHref,
  withoutPictureRow,
} from '../wiki-views'

describe('wiki views', () => {
  it('lands on the context view and puts every other view in the URL', () => {
    expect(wikiViewHref('context')).toBe('/wiki')
    expect(wikiViewHref('map')).toBe('/wiki?view=map')
    expect(parseWikiView(null)).toBe('context')
    expect(parseWikiView('memory')).toBe('memory')
    expect(parseWikiView('knowledge')).toBe('context')
  })

  it('sends each old "Vad din agent vet" link to its wiki view', () => {
    expect(legacyKnowledgeHref(undefined)).toBe('/wiki')
    expect(legacyKnowledgeHref('knowledge')).toBe('/wiki?view=map')
    expect(legacyKnowledgeHref('facts')).toBe('/wiki?view=facts')
    expect(legacyKnowledgeHref('memory')).toBe('/wiki?view=memory')
    expect(legacyKnowledgeHref('skills')).toBe('/wiki?view=skills')
    expect(legacyKnowledgeHref('nonsense')).toBe('/wiki')
    // Said outright, a company without the picture gets the same answers.
    for (const view of [undefined, 'knowledge', 'facts', 'memory', 'skills', 'nonsense']) {
      expect(legacyKnowledgeHref(view, { picture: false })).toBe(legacyKnowledgeHref(view))
    }
  })

  it('sends each old link to where the view is for a company with the picture', () => {
    const picture = { picture: true }
    expect(legacyKnowledgeHref(undefined, picture)).toBe('/wiki')
    expect(legacyKnowledgeHref('knowledge', picture)).toBe('/rules')
    expect(legacyKnowledgeHref('facts', picture)).toBe('/wiki?view=facts')
    expect(legacyKnowledgeHref('memory', picture)).toBe('/wiki?view=memory')
    expect(legacyKnowledgeHref('skills', picture)).toBe('/wiki?view=knowledge')
    expect(legacyKnowledgeHref('nonsense', picture)).toBe('/wiki')
  })
})

describe('the rows of the picture in an address', () => {
  it('names each row by its own name, and Kunskap by the wiki view that lists the knowledge too', () => {
    expect(PICTURE_ROWS).toEqual(['context', 'checks', 'memory', 'knowledge'])
    for (const row of PICTURE_ROWS) {
      expect(isPictureRow(row)).toBe(true)
      expect(pictureRowOf(row)).toBe(row)
    }
    expect(pictureRowOf('skills')).toBe('knowledge')
    for (const other of [null, undefined, '', 'map', 'facts', 'nonsense', 'toString', '__proto__']) {
      expect(pictureRowOf(other), String(other)).toBeNull()
    }
    expect(isPictureRow('skills')).toBe(false)
  })

  it('writes the address of a row, and of one knowledge item under Kunskap', () => {
    expect(pictureRowHref('context')).toBe('/wiki?view=context')
    expect(pictureRowHref('checks')).toBe('/wiki?view=checks')
    expect(pictureRowHref('memory')).toBe('/wiki?view=memory')
    expect(pictureRowHref('knowledge')).toBe('/wiki?view=knowledge')
    expect(pictureRowHref('knowledge', 'horizontal.swedish-vat')).toBe('/wiki?view=knowledge&item=horizontal.swedish-vat')
    // Only Kunskap has items.
    expect(pictureRowHref('memory', 'horizontal.swedish-vat')).toBe('/wiki?view=memory')
    expect(pictureRowHref('knowledge', null)).toBe('/wiki?view=knowledge')
  })

  it('spells a knowledge item with a dot for the slash, and reads it back', () => {
    expect(knowledgeItemParam('horizontal/swedish-vat')).toBe('horizontal.swedish-vat')
    expect(knowledgeItemId('horizontal.swedish-vat')).toBe('horizontal/swedish-vat')
    // Only the first dot is the slash: an id's own dots stay.
    expect(knowledgeItemId(knowledgeItemParam('vertical/e-handel.se'))).toBe('vertical/e-handel.se')
  })

  it('reads back the address it writes', () => {
    for (const row of PICTURE_ROWS) {
      const query = new URLSearchParams(pictureRowHref(row, 'modifier.holding-ab').split('?')[1])
      expect(wikiPlace({ view: query.get('view'), item: query.get('item') }, { picture: true, facts: false })).toEqual({
        show: 'picture',
        row,
        item: row === 'knowledge' ? 'modifier.holding-ab' : null,
      })
    }
  })
})

describe('what /wiki shows for an address', () => {
  const withPicture = { picture: true, facts: false }
  const without = { picture: false, facts: false }

  it('is the picture with nothing open on the bare address, where the picture is on', () => {
    expect(wikiPlace({}, withPicture)).toEqual({ show: 'picture', row: null, item: null })
    expect(wikiPlace({ view: null, item: null }, withPicture)).toEqual({ show: 'picture', row: null, item: null })
    expect(wikiPlace({ view: 'nonsense' }, withPicture)).toEqual({ show: 'picture', row: null, item: null })
  })

  it('opens the row the address names: Kontext, Kontroller, Minne and Kunskap', () => {
    expect(wikiPlace({ view: 'context' }, withPicture)).toEqual({ show: 'picture', row: 'context', item: null })
    expect(wikiPlace({ view: 'checks' }, withPicture)).toEqual({ show: 'picture', row: 'checks', item: null })
    expect(wikiPlace({ view: 'memory' }, withPicture)).toEqual({ show: 'picture', row: 'memory', item: null })
    expect(wikiPlace({ view: 'knowledge' }, withPicture)).toEqual({ show: 'picture', row: 'knowledge', item: null })
    expect(wikiPlace({ view: 'skills' }, withPicture)).toEqual({ show: 'picture', row: 'knowledge', item: null })
  })

  it('opens one folder of Kunskap when the address names an item, under either spelling of the row', () => {
    expect(wikiPlace({ view: 'knowledge', item: 'horizontal.swedish-vat' }, withPicture)).toEqual({ show: 'picture', row: 'knowledge', item: 'horizontal.swedish-vat' })
    expect(wikiPlace({ view: 'skills', item: 'horizontal.swedish-vat' }, withPicture)).toEqual({ show: 'picture', row: 'knowledge', item: 'horizontal.swedish-vat' })
    // An item means nothing on another row, or with no row.
    expect(wikiPlace({ view: 'memory', item: 'horizontal.swedish-vat' }, withPicture)).toEqual({ show: 'picture', row: 'memory', item: null })
    expect(wikiPlace({ item: 'horizontal.swedish-vat' }, withPicture)).toEqual({ show: 'picture', row: null, item: null })
    expect(wikiPlace({ view: 'knowledge', item: '' }, withPicture)).toEqual({ show: 'picture', row: 'knowledge', item: null })
  })

  it('leads the map to Bokföringsregler, where its lines are', () => {
    expect(wikiPlace({ view: 'map' }, withPicture)).toEqual({ show: 'redirect', href: '/rules' })
    expect(wikiPlace({ view: 'map', item: 'horizontal.swedish-vat' }, { picture: true, facts: true })).toEqual({ show: 'redirect', href: '/rules' })
    // Only with the picture: every other company keeps the map.
    expect(wikiPlace({ view: 'map' }, without)).toEqual({ show: 'view', view: 'map' })
  })

  it('never leads a company without the picture anywhere else', () => {
    for (const view of [...WIKI_VIEWS, ...PICTURE_ROWS, 'nonsense', null, undefined]) {
      for (const facts of [false, true]) expect(wikiPlace({ view }, { picture: false, facts }).show, String(view)).toBe('view')
    }
  })

  it('keeps Fakta a view of its own where the company has it, and the picture where it has not', () => {
    expect(wikiPlace({ view: 'facts' }, { picture: true, facts: true })).toEqual({ show: 'view', view: 'facts' })
    expect(wikiPlace({ view: 'facts' }, { picture: true, facts: false })).toEqual({ show: 'picture', row: null, item: null })
  })

  it('shows a company without the picture the view it always showed, whatever else the address says', () => {
    // Every view the wiki knows: itself.
    for (const view of WIKI_VIEWS) {
      const expected = view === 'facts' ? 'context' : view
      expect(wikiPlace({ view }, without), view).toEqual({ show: 'view', view: expected })
      expect(wikiPlace({ view, item: 'horizontal.swedish-vat' }, without), view).toEqual({ show: 'view', view: expected })
    }
    expect(wikiPlace({ view: 'facts' }, { picture: false, facts: true })).toEqual({ show: 'view', view: 'facts' })
    // The picture's own row names are not wiki views: the landing, as before.
    for (const view of ['knowledge', 'checks', 'nonsense', '', null, undefined]) {
      expect(wikiPlace({ view }, without), String(view)).toEqual({ show: 'view', view: 'context' })
    }
    // For any address the answer is what parseWikiView alone gave before.
    for (const view of [...WIKI_VIEWS, ...PICTURE_ROWS, 'nonsense', null]) {
      for (const facts of [false, true]) {
        const parsed = parseWikiView(view)
        expect(wikiPlace({ view }, { picture: false, facts })).toEqual({ show: 'view', view: parsed === 'facts' && !facts ? 'context' : parsed })
      }
    }
  })
})

describe('where each wiki view is for a company with the picture', () => {
  it('names the row, Bokföringsregler or the view itself', () => {
    expect(pictureHrefOfView('context')).toBe('/wiki')
    expect(pictureHrefOfView('map')).toBe('/rules')
    expect(pictureHrefOfView('facts')).toBe('/wiki?view=facts')
    expect(pictureHrefOfView('memory')).toBe('/wiki?view=memory')
    expect(pictureHrefOfView('skills')).toBe('/wiki?view=knowledge')
  })

  it('names a place /wiki shows without leading on: no address of its own is a redirect', () => {
    for (const view of WIKI_VIEWS) {
      const href = pictureHrefOfView(view)
      if (!href.startsWith('/wiki')) continue
      const query = new URLSearchParams(href.split('?')[1] ?? '')
      for (const facts of [false, true]) {
        expect(wikiPlace({ view: query.get('view'), item: query.get('item') }, { picture: true, facts }).show, href).not.toBe('redirect')
      }
    }
  })
})

describe('the agent cards of the picture in an address', () => {
  it('writes the address of an open card, and reads it back', () => {
    expect(pictureAgentHref('claude')).toBe('/wiki?agent=claude')
    for (const card of ['claude', 'mcp', 'key:0d6f6f0e-0000-4000-8000-000000000001', 'account:0d6f6f0e-0000-4000-8000-000000000002']) {
      const query = new URLSearchParams(pictureAgentHref(card).split('?')[1])
      expect(pictureAgentOf({ view: query.get('view'), agent: query.get('agent') })).toBe(card)
    }
  })

  it('names no card when the address names a row: a row and a card are not open at once', () => {
    for (const view of [...PICTURE_ROWS, 'skills']) expect(pictureAgentOf({ view, agent: 'claude' }), view).toBeNull()
    // A view that names no row leaves the card named.
    for (const view of [null, undefined, '', 'nonsense']) expect(pictureAgentOf({ view, agent: 'claude' }), String(view)).toBe('claude')
  })

  it('names no card for an address without one', () => {
    for (const agent of [null, undefined, '']) expect(pictureAgentOf({ agent }), String(agent)).toBeNull()
    expect(pictureAgentOf({})).toBeNull()
  })

  it('changes nothing of what view and item mean', () => {
    for (const picture of [true, false]) {
      for (const view of [...WIKI_VIEWS, ...PICTURE_ROWS, 'nonsense', null]) {
        const address = { view, item: 'horizontal.swedish-vat' }
        // wikiPlace reads no card: with one in the address it answers what it answers without.
        expect(wikiPlace({ ...address, agent: 'claude' } as typeof address, { picture, facts: true })).toEqual(wikiPlace(address, { picture, facts: true }))
      }
    }
  })
})

describe('closing a row takes it out of the address', () => {
  it('drops the row and its item, and keeps the rest', () => {
    expect(withoutPictureRow('/wiki?view=memory')).toBe('/wiki')
    expect(withoutPictureRow('/wiki?view=knowledge&item=horizontal.swedish-vat')).toBe('/wiki')
    expect(withoutPictureRow('/wiki?ctx=byra&view=checks#top')).toBe('/wiki?ctx=byra#top')
    expect(withoutPictureRow('/wiki')).toBe('/wiki')
    expect(withoutPictureRow('/wiki#top')).toBe('/wiki#top')
  })

  it('drops the item alone when a folder is closed and its row stays open', () => {
    expect(withoutPictureRow('/wiki?view=knowledge&item=horizontal.swedish-vat', { keepRow: true })).toBe('/wiki?view=knowledge')
    expect(withoutPictureRow('/wiki?view=knowledge', { keepRow: true })).toBe('/wiki?view=knowledge')
    expect(withoutPictureRow('/wiki', { keepRow: true })).toBe('/wiki')
  })

  it('drops the agent card when its panel is closed, and keeps the rest', () => {
    expect(withoutPictureRow('/wiki?agent=claude')).toBe('/wiki')
    expect(withoutPictureRow('/wiki?ctx=byra&agent=key%3A0d6f6f0e-0000-4000-8000-000000000001#top')).toBe('/wiki?ctx=byra#top')
    // Closing a folder leaves its row open, and touches nothing else.
    expect(withoutPictureRow('/wiki?view=knowledge&item=horizontal.swedish-vat&agent=claude', { keepRow: true })).toBe('/wiki?view=knowledge&agent=claude')
  })

  it('leaves an address that names no row as it is, so nothing is written for a row opened from the card', () => {
    for (const address of ['/wiki', '/wiki#x', '/wiki?ctx=byra']) expect(withoutPictureRow(address)).toBe(address)
  })
})
