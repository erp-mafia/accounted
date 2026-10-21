import { describe, expect, it } from 'vitest'
import { portalRows, purchasesAtPortal } from '../portals'
import type { MissingPurchase } from '../missing'

const OPENAI = { vendor: 'OpenAI', url: 'https://platform.openai.com/settings/organization/billing', note: null }
const ADOBE = { vendor: 'Adobe', url: 'https://account.adobe.com/plans', note: null }
const GOOGLE = { vendor: 'Google Workspace', url: 'https://admin.google.com', note: 'Under Fakturering.' }

function purchase(id: string, portal: MissingPurchase['portal']): MissingPurchase {
  return { id, date: '2026-10-12', description: null, merchant_name: null, amount: -100, currency: 'SEK', amount_sek: -100, portal }
}

const none = new Set<string>()

describe('portalRows', () => {
  it('one row per supplier with a known portal, purchases without one left out', () => {
    const rows = portalRows(
      [purchase('a', OPENAI), purchase('b', null), purchase('c', ADOBE), purchase('d', OPENAI)],
      none,
    )
    expect(rows.map((r) => r.vendor)).toEqual(['OpenAI', 'Adobe'])
    expect(rows[0]).toEqual({ vendor: 'OpenAI', url: OPENAI.url, logoUrl: null, missing: 2, needsYou: 2, status: 'missing' })
  })

  it("wears the supplier's stored icon off the first of its purchases that has one", () => {
    const telia = { vendor: 'Telia', url: 'https://minasidor.telia.se/foretag', note: null, id: 'p-telia' }
    const rows = portalRows(
      [purchase('a', telia), { ...purchase('b', telia), logo_url: 'https://db.example/logos/telia.png' }],
      none,
    )
    expect(rows).toEqual([
      { vendor: 'Telia', url: telia.url, logoUrl: 'https://db.example/logos/telia.png', missing: 2, needsYou: 2, status: 'missing' },
    ])
  })

  it('most purchases without underlag first, then by name, whatever order they came in', () => {
    const rows = portalRows(
      [purchase('a', GOOGLE), purchase('b', ADOBE), purchase('c', OPENAI), purchase('d', OPENAI), purchase('e', GOOGLE), purchase('f', OPENAI)],
      none,
    )
    expect(rows.map((r) => [r.vendor, r.missing])).toEqual([
      ['OpenAI', 3],
      ['Google Workspace', 2],
      ['Adobe', 1],
    ])
    const reversed = portalRows(
      [purchase('f', OPENAI), purchase('e', GOOGLE), purchase('d', OPENAI), purchase('c', OPENAI), purchase('b', ADOBE), purchase('a', GOOGLE)],
      none,
    )
    expect(reversed).toEqual(rows)
  })

  it('a supplier whose purchases are all on their way is quiet; one waiting purchase makes it missing', () => {
    const onTheWay = new Set(['a', 'b'])
    const rows = portalRows([purchase('a', GOOGLE), purchase('b', OPENAI), purchase('c', OPENAI)], onTheWay)
    expect(rows.find((r) => r.vendor === 'Google Workspace')).toMatchObject({ missing: 1, needsYou: 0, status: 'on_the_way' })
    expect(rows.find((r) => r.vendor === 'OpenAI')).toMatchObject({ missing: 2, needsYou: 1, status: 'missing' })
  })

  it('nothing to list when no purchase has a portal', () => {
    expect(portalRows([purchase('a', null)], none)).toEqual([])
    expect(portalRows([], none)).toEqual([])
  })
})

describe('purchasesAtPortal', () => {
  it('Saknar underlag for one supplier, in the order given', () => {
    const list = [purchase('a', OPENAI), purchase('b', ADOBE), purchase('c', null), purchase('d', OPENAI)]
    expect(purchasesAtPortal(list, 'OpenAI').map((p) => p.id)).toEqual(['a', 'd'])
    expect(purchasesAtPortal(list, 'Telia')).toEqual([])
  })
})
