import { describe, expect, it } from 'vitest'
import { focusAfterChange } from '../focus'
import {
  bandByMonth,
  dragCarriesFiles,
  looksLikeCardPurchase,
  MAX_MISSING_ACTIONS,
  missingDecision,
  orderMissing,
  purchaseBankText,
  purchaseName,
  splitDroppedFiles,
  splitMissing,
  underlagRoute,
  type MissingPurchase,
  type RouteContext,
  purchaseDisplay,
} from '../missing'

function purchase(overrides: Partial<MissingPurchase> = {}): MissingPurchase {
  return {
    id: 'tx-1',
    date: '2026-10-12',
    description: 'Bankgiro 123-4567',
    merchant_name: null,
    amount: -499,
    currency: 'SEK',
    amount_sek: -499,
    portal: null,
    ...overrides,
  }
}

const PORTAL = { vendor: 'OpenAI', url: 'https://platform.openai.com/settings/organization/billing', note: null }
const CONTEXT: RouteContext = { intakeAddress: 'inbox@example.test', whatsappLinked: true }

describe('orderMissing and bandByMonth', () => {
  it('lists the newest first and keeps a day in id order, so a refetch never reshuffles it', () => {
    const rows = [
      purchase({ id: 'b', date: '2026-10-01' }),
      purchase({ id: 'c', date: '2026-10-12' }),
      purchase({ id: 'a', date: '2026-10-12' }),
      purchase({ id: 'd', date: '2026-09-30' }),
    ]
    expect(orderMissing(rows).map((p) => p.id)).toEqual(['a', 'c', 'b', 'd'])
    expect(orderMissing([...rows].reverse()).map((p) => p.id)).toEqual(['a', 'c', 'b', 'd'])
  })

  it('does not change the list it was given', () => {
    const rows = [purchase({ id: 'b', date: '2026-09-01' }), purchase({ id: 'a', date: '2026-10-01' })]
    orderMissing(rows)
    expect(rows.map((p) => p.id)).toEqual(['b', 'a'])
  })

  it('bands the ordered list by month, newest month first', () => {
    const ordered = orderMissing([
      purchase({ id: 'a', date: '2026-10-12' }),
      purchase({ id: 'b', date: '2026-10-01' }),
      purchase({ id: 'c', date: '2026-09-30' }),
      purchase({ id: 'd', date: '2025-10-30' }),
    ])
    expect(bandByMonth(ordered).map((b) => [b.month, b.purchases.map((p) => p.id)])).toEqual([
      ['2026-10', ['a', 'b']],
      ['2026-09', ['c']],
      ['2025-10', ['d']],
    ])
    expect(bandByMonth([])).toEqual([])
  })

  it('splits the ordered list into what needs you and what is on its way, keeping the order in each', () => {
    const ordered = orderMissing([
      purchase({ id: 'a', date: '2026-10-12' }),
      purchase({ id: 'b', date: '2026-10-11' }),
      purchase({ id: 'c', date: '2026-10-10' }),
      purchase({ id: 'd', date: '2026-10-09' }),
    ])
    const { needsYou, onTheWay } = splitMissing(ordered, new Set(['b', 'd']))
    expect(needsYou.map((p) => p.id)).toEqual(['a', 'c'])
    expect(onTheWay.map((p) => p.id)).toEqual(['b', 'd'])
    expect(splitMissing(ordered, new Map()).needsYou).toHaveLength(4)
  })
})

describe('what a row says', () => {
  it('names the merchant, else the bank text, else nothing', () => {
    expect(purchaseName(purchase({ merchant_name: ' Clas Ohlson ', description: 'KORTKÖP 261012 CLAS OHLSON' }))).toBe('Clas Ohlson')
    expect(purchaseName(purchase({ merchant_name: '  ', description: 'Bankgiro 123-4567' }))).toBe('Bankgiro 123-4567')
    expect(purchaseName(purchase({ merchant_name: null, description: null }))).toBeNull()
  })

  it('adds the bank text only when it says something the name does not', () => {
    expect(purchaseBankText(purchase({ merchant_name: 'Clas Ohlson', description: 'KORTKÖP 261012 CLAS OHLSON' }))).toBe(
      'KORTKÖP 261012 CLAS OHLSON',
    )
    expect(purchaseBankText(purchase({ merchant_name: null, description: 'Bankgiro 123-4567' }))).toBeNull()
    expect(purchaseBankText(purchase({ merchant_name: 'X', description: ' ' }))).toBeNull()
  })

  it('reads the card rails off the bank text', () => {
    expect(looksLikeCardPurchase('Kortköp 260612 Prime Video-*NL5EK5W')).toBe(true)
    expect(looksLikeCardPurchase('KORTKÖP 261012 ICA NARA')).toBe(true)
    expect(looksLikeCardPurchase('Ryde Sweden AB  K8066 Kortköp/uttag')).toBe(true)
    expect(looksLikeCardPurchase('kortkop 261012 circle k')).toBe(true)
    expect(looksLikeCardPurchase('KORT 4567 ESPRESSO HOUSE')).toBe(true)
    expect(looksLikeCardPurchase('Qstar Lilla Edet 6531 K8781')).toBe(true)
    expect(looksLikeCardPurchase('Bankgiro 123-4567')).toBe(false)
    expect(looksLikeCardPurchase('Kortavgift')).toBe(false)
    expect(looksLikeCardPurchase(null)).toBe(false)
  })
})

describe('underlagRoute: where the underlag will come from', () => {
  it('is the portal whenever the directory knows one, also before the context is read', () => {
    expect(underlagRoute(purchase({ portal: PORTAL, description: 'Kortköp 261012 OPENAI' }), CONTEXT)).toEqual({ kind: 'portal', ...PORTAL })
    expect(underlagRoute(purchase({ portal: PORTAL }), null)).toEqual({ kind: 'portal', ...PORTAL })
  })

  it('knows nothing else until the context is read', () => {
    expect(underlagRoute(purchase({ description: 'KORTKÖP 261012 ICA NARA' }), null)).toEqual({ kind: 'unknown' })
  })

  it('asks for a photo of a card purchase, with WhatsApp only when a number is linked', () => {
    const card = purchase({ description: 'KORTKÖP 261012 ICA NARA' })
    expect(underlagRoute(card, CONTEXT)).toEqual({ kind: 'photo', whatsapp: true })
    expect(underlagRoute(card, { ...CONTEXT, whatsappLinked: false })).toEqual({ kind: 'photo', whatsapp: false })
  })

  it('points anything that can come by mail at the intake address', () => {
    expect(underlagRoute(purchase({ description: 'Bankgiro 123-4567' }), CONTEXT)).toEqual({
      kind: 'intake',
      address: 'inbox@example.test',
    })
  })

  it('says nothing without an address, or for what no mail ever carries (salary, tax)', () => {
    expect(underlagRoute(purchase({ description: 'Bankgiro 123-4567' }), { ...CONTEXT, intakeAddress: null })).toEqual({ kind: 'unknown' })
    expect(underlagRoute(purchase({ description: 'Preliminärskatt' }), CONTEXT)).toEqual({ kind: 'unknown' })
    expect(underlagRoute(purchase({ description: 'Löneutbetalning oktober' }), CONTEXT)).toEqual({ kind: 'unknown' })
  })
})

describe('missingDecision: one question, at most three answers', () => {
  const claude = { clients: ['claude' as const] }
  const none = { clients: [] }

  it('leads a portal purchase with the portal, then the AI, then the file', () => {
    expect(missingDecision(purchase({ portal: PORTAL }), CONTEXT, claude).actions).toEqual(['open_portal', 'fetch_with_ai', 'choose_file'])
  })

  it('leads every other purchase with the file, then the AI', () => {
    expect(missingDecision(purchase({ description: 'KORTKÖP 261012 ICA' }), CONTEXT, claude).actions).toEqual(['choose_file', 'fetch_with_ai'])
    expect(missingDecision(purchase(), CONTEXT, claude).actions).toEqual(['choose_file', 'fetch_with_ai'])
  })

  it('connects Claude in the same place when no AI is connected', () => {
    expect(missingDecision(purchase({ portal: PORTAL }), CONTEXT, none).actions).toEqual(['open_portal', 'connect_ai', 'choose_file'])
    expect(missingDecision(purchase(), CONTEXT, none).actions).toEqual(['choose_file', 'connect_ai'])
  })

  it('leaves the AI out while the hand-off is unknown, and where no mail holds a receipt', () => {
    expect(missingDecision(purchase({ portal: PORTAL }), CONTEXT, null).actions).toEqual(['open_portal', 'choose_file'])
    expect(missingDecision(purchase({ description: 'Preliminärskatt' }), CONTEXT, claude).actions).toEqual(['choose_file'])
  })

  it('never offers more than three', () => {
    for (const handoff of [claude, none, null]) {
      for (const p of [purchase(), purchase({ portal: PORTAL }), purchase({ description: 'Kortköp 1 ICA' })]) {
        expect(missingDecision(p, CONTEXT, handoff).actions.length).toBeLessThanOrEqual(MAX_MISSING_ACTIONS)
      }
    }
  })

  it('carries the route the evidence line reads', () => {
    expect(missingDecision(purchase({ description: 'KORTKÖP 1 ICA' }), CONTEXT, claude).route).toEqual({ kind: 'photo', whatsapp: true })
  })
})

describe('next row: a purchase that got its underlag leaves and the next opens', () => {
  it('opens the next older purchase, or the newer one when it was the oldest', () => {
    const ids = orderMissing([
      purchase({ id: 'a', date: '2026-10-12' }),
      purchase({ id: 'b', date: '2026-10-05' }),
      purchase({ id: 'c', date: '2026-09-30' }),
    ]).map((p) => p.id)
    expect(focusAfterChange(ids, ['a', 'c'], 'b')).toBe('c')
    expect(focusAfterChange(ids, ['a', 'b'], 'c')).toBe('b')
    expect(focusAfterChange(ids, [], 'a')).toBeNull()
  })
})

describe('files', () => {
  it('recognises a drag that carries files', () => {
    expect(dragCarriesFiles(['Files'])).toBe(true)
    expect(dragCarriesFiles(['text/plain', 'Files'])).toBe(true)
    expect(dragCarriesFiles(['text/uri-list'])).toBe(false)
    expect(dragCarriesFiles(null)).toBe(false)
  })

  it('makes the first dropped file the underlag and files the rest', () => {
    expect(splitDroppedFiles(['a.pdf', 'b.pdf', 'c.pdf'])).toEqual({ underlag: 'a.pdf', extras: ['b.pdf', 'c.pdf'] })
    expect(splitDroppedFiles(['a.pdf'])).toEqual({ underlag: 'a.pdf', extras: [] })
    expect(splitDroppedFiles([])).toEqual({ underlag: null, extras: [] })
  })
})

describe('purchaseDisplay', () => {
  it('names a purchase by the bank merchant name, with the bank text under it', () => {
    expect(purchaseDisplay({ merchant_name: 'Telia', description: 'TELIA SVERIGE AB' })).toEqual({ name: 'Telia', vendor: 'telia', bankText: 'TELIA SVERIGE AB' })
  })

  it('names it by the vendor its text names when the bank gives no merchant name', () => {
    expect(purchaseDisplay({ merchant_name: null, description: 'OPENAI *CHATGPT SUBSCR' })).toEqual({ name: 'OpenAI', vendor: 'openai', bankText: 'OPENAI *CHATGPT SUBSCR' })
  })

  it('keeps the bank text as the name when nobody is known, and says it once', () => {
    expect(purchaseDisplay({ merchant_name: null, description: 'KAFE SOLROS 12' })).toEqual({ name: 'Kafe Solros 12', vendor: null, bankText: null })
    expect(purchaseDisplay({ merchant_name: null, description: null })).toEqual({ name: null, vendor: null, bankText: null })
  })

  it("sets a bank merchant name in capitals as a person reads it, and keeps the bank's text as written", () => {
    expect(purchaseDisplay({ merchant_name: 'BYGGHANDELN SOLNA', description: 'BYGGHANDELN SOLNA 0412' })).toEqual({ name: 'Bygghandeln Solna', vendor: null, bankText: 'BYGGHANDELN SOLNA 0412' })
  })
})
