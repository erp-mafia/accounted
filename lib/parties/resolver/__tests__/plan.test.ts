import { describe, expect, it } from 'vitest'
import { preclean } from '../preclean'
import { bandFor, planAlias } from '../plan'
import type { ModelReading } from '../model-reading'

function reading(over: Partial<ModelReading> = {}): ModelReading {
  return {
    i: 1,
    pick: null,
    counterpart: 'Squarespace',
    kind: 'merchant',
    rail: null,
    country: null,
    what: 'Webbplatsbyggare',
    confidence: 'high',
    grounded: true,
    model: 'haiku',
    ...over,
  }
}

describe('bandFor', () => {
  it('maps confidence to the three bands', () => {
    expect(bandFor(0.95)).toBe('link')
    expect(bandFor(0.8)).toBe('link')
    expect(bandFor(0.79)).toBe('tentative')
    expect(bandFor(0.6)).toBe('tentative')
    expect(bandFor(0.59)).toBe('nil')
  })
})

describe('planAlias', () => {
  it('names nothing for salary and category text, whatever the model says', () => {
    const d = planAlias({ pre: preclean('Lön Jakob Juni Överföring via internet'), model: reading({ counterpart: 'Jakob', kind: 'person' }) })
    expect(d.band).toBe('nil')
    expect(d.kind).toBe('payroll')
    expect(d.displayName).toBeNull()
  })

  it('links a text the company booked before to its own party, after a document and before the directory', () => {
    const pre = preclean('Webhallen Oktober')
    const ledger = { partyId: 'p-web', name: 'Webhallen Sverige AB', confirmed: true }
    const d = planAlias({ pre, ledger, directory: { name: 'Webhallen', kind: 'merchant', confidence: 0.95 } })
    expect(d).toMatchObject({ partyId: 'p-web', displayName: 'Webhallen Sverige AB', source: 'ledger', band: 'link', confidence: 0.96 })
    const doc = planAlias({ pre, ledger, document: { supplierName: 'Webhallen Sverige AB', partyId: 'p-web' } })
    expect(doc.source).toBe('document')
    const suggested = planAlias({ pre, ledger: { ...ledger, confirmed: false } })
    expect(suggested).toMatchObject({ partyId: 'p-web', source: 'ledger', confidence: 0.9, band: 'link' })
  })

  it('keeps a salary line off a suggested party, but not off a confirmed one', () => {
    const pre = preclean('Lön Jakob Juni Överföring via internet')
    expect(planAlias({ pre, ledger: { partyId: 'p-j', name: 'Lön Jakob', confirmed: false } })).toMatchObject({ band: 'nil', partyId: null })
    expect(planAlias({ pre, ledger: { partyId: 'p-j', name: 'Jakob Wennberg', confirmed: true } })).toMatchObject({ partyId: 'p-j', source: 'ledger' })
  })

  it('lets a document outrank the directory and the model', () => {
    const d = planAlias({
      pre: preclean('Hotel at Booking.com K3667 Kortköp/uttag'),
      document: { supplierName: 'Hotel Skeppsholmen AB', partyId: 'p-1' },
      directory: { name: 'Booking.com', kind: 'merchant', confidence: 0.95 },
      model: reading({ counterpart: 'Booking.com' }),
    })
    expect(d).toMatchObject({ source: 'document', displayName: 'Hotel Skeppsholmen AB', partyId: 'p-1', band: 'link', kind: 'invoice_supplier' })
  })

  it('takes the directory before the model and marks a giro hit as an anchor', () => {
    const viaDirectory = planAlias({ pre: preclean('SQSP  WORKSP'), directory: { name: 'Squarespace', kind: 'merchant', confidence: 0.95, what: 'Webbplatsbyggare, SaaS' }, model: reading({ counterpart: 'Something Else' }) })
    expect(viaDirectory).toMatchObject({ source: 'directory', displayName: 'Squarespace', band: 'link', what: 'Webbplatsbyggare, SaaS' })
    const viaGiro = planAlias({ pre: preclean('1655958320228 DBT.5050-1055 SKATTEVERK 144 240 1655958320228 350 Polytop AB'), directory: { name: 'Skatteverket', kind: 'authority', confidence: 0.98, viaGiro: true } })
    expect(viaGiro).toMatchObject({ source: 'anchor', displayName: 'Skatteverket', kind: 'authority', confidence: 0.98 })
  })

  it('lets a brand in the directory beat the category label, and a giro beat the payroll label', () => {
    const sj = planAlias({ pre: preclean('SJ biljetter Överföring via internet'), directory: { name: 'SJ', kind: 'merchant', confidence: 0.95 } })
    expect(sj).toMatchObject({ displayName: 'SJ', band: 'link', source: 'directory' })
    const skatt = planAlias({ pre: preclean('Skatt lön Juni BG 0000050501055 Bg-bet. via internet'), directory: { name: 'Skatteverket', kind: 'authority', confidence: 0.98, viaGiro: true } })
    expect(skatt).toMatchObject({ displayName: 'Skatteverket', source: 'anchor', band: 'link' })
    const lon = planAlias({ pre: preclean('Lön Jakob Juni Överföring via internet') })
    expect(lon).toMatchObject({ kind: 'payroll', band: 'nil' })
  })

  it('takes a giro number the register already knows before anything else', () => {
    const d = planAlias({ pre: preclean('TIC identity BG 0000005786439 Bg-bet. via internet'), identity: { partyId: 'p-tic', name: 'The Intelligence Company AB (publ)' }, directory: { name: 'Other', kind: 'merchant', confidence: 0.95 } })
    expect(d).toMatchObject({ partyId: 'p-tic', displayName: 'The Intelligence Company AB (publ)', confidence: 0.98, source: 'anchor' })
  })

  it('anchors on a legal-form name without a model', () => {
    const d = planAlias({ pre: preclean('Kortköp 260828 KRONANS APOTEK AB') })
    expect(d.source).toBe('anchor')
    expect(d.displayName).toMatch(/kronans apotek ab/i)
    expect(d.band).toBe('link')
  })

  it('grades a model reading by its confidence and the verify verdict', () => {
    const pre = preclean('SQSP  WORKSP')
    expect(planAlias({ pre, model: reading({ confidence: 'high' }) })).toMatchObject({ source: 'model', band: 'link', confidence: 0.85, needsVerify: false })
    const medium = planAlias({ pre, model: reading({ confidence: 'medium' }) })
    expect(medium).toMatchObject({ band: 'tentative', confidence: 0.65, needsVerify: true })
    expect(planAlias({ pre, model: reading({ confidence: 'medium' }), verify: 'yes' })).toMatchObject({ band: 'link', confidence: 0.8, verified: true })
    expect(planAlias({ pre, model: reading({ confidence: 'medium' }), verify: 'no' })).toMatchObject({ band: 'nil', verified: true })
    expect(planAlias({ pre, model: reading({ confidence: 'low' }) })).toMatchObject({ band: 'nil', displayName: 'Squarespace' })
  })

  it('resolves a pick to the register party and lifts it to the link band', () => {
    const candidatesById = new Map([['p1', { partyId: 'party-anthropic', name: 'Anthropic' }]])
    const d = planAlias({ pre: preclean('Anthropic, PBC'), model: reading({ pick: 'p1', counterpart: 'Anthropic', confidence: 'medium' }), candidatesById })
    expect(d).toMatchObject({ partyId: 'party-anthropic', displayName: 'Anthropic', band: 'link' })
  })

  it('falls back to the rail when only the rail was named', () => {
    const d = planAlias({ pre: preclean('SHOPIFY* 54983') })
    expect(d.band).toBe('nil')
    const zettle = planAlias({ pre: preclean('ZETTLE_*12345') })
    expect(zettle).toMatchObject({ displayName: 'Zettle', kind: 'rail', band: 'link' })
  })

  it('leaves a bare reference number unnamed', () => {
    const d = planAlias({ pre: preclean('100004087691') })
    expect(d).toMatchObject({ band: 'nil', displayName: null })
  })
})
