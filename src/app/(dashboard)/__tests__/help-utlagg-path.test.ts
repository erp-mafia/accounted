/**
 * PH 201: "Var hittar jag var jag kan lägga in utlägg?" The Utlägg menu row
 * stays hidden until a company's first claim exists (the founder's gate,
 * lib/navigation/nav-gates.ts), so a new company finds an utlägg only
 * through the inbox, the help page or ⌘K. The help page's "Eget utlägg"
 * told people to tick "Jag har betalat detta privat", a checkbox that "Vem
 * betalade?" replaced, and ⌘K found nothing for "utlägg". Components are
 * not rendered in this suite (vitest runs in `node`), so the wiring is
 * pinned on the source: every button the help text names must exist under
 * that name, and the palette's inbox entry must answer "utlägg" and "kvitto".
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import sv from '@/messages/sv.json'
import { resolveExpenseLiabilityAccount } from '@/lib/expenses/payer'
import { INBOX_SEARCH_KEYWORDS } from '@/lib/inkorg/flag'

const helpPage = fs.readFileSync(path.resolve(__dirname, '../help/page.tsx'), 'utf8')
const palette = fs.readFileSync(path.resolve(__dirname, '../../../components/common/CommandPalette.tsx'), 'utf8')

function glossaryDefinition(term: string): string {
  const start = helpPage.indexOf(`term: '${term}'`)
  expect(start).toBeGreaterThan(-1)
  const match = helpPage.slice(start).match(/definition:\s*'([^']*)'/)
  expect(match).not.toBeNull()
  return match![1]
}

/** The palette's matcher: every typed token must occur in label, hint or keywords. */
function paletteFinds(hay: string, query: string): boolean {
  const text = hay.toLowerCase()
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((token) => text.includes(token))
}

describe('the help page answers "utlägg" with the path that exists', () => {
  const definition = glossaryDefinition('Eget utlägg')

  it('no longer names the removed "paid privately" checkbox', () => {
    expect(helpPage).not.toContain('Jag har betalat detta privat')
  })

  it('names each button by the label it has today', () => {
    const labels = [
      sv.nav.inkorg,
      sv.inbox_workspace.payer_question,
      sv.inkorg.action_expense,
      sv.inbox_workspace.payer_owner,
      sv.inbox_workspace.payer_employee,
      sv.nav.v2_purchases,
      sv.nav.supplier_invoices,
      sv.supplier_invoices.register_invoice,
      sv.nav.v2_todo,
      sv.tx_inbox_card.match_expense_btn,
      sv.nav.expenses,
    ]
    for (const label of labels) expect(definition).toContain(label)
  })

  it('states the accounts the booking uses: 2893 for an aktiebolag, 2018 for an enskild firma', () => {
    expect(definition).toContain(`(${resolveExpenseLiabilityAccount('aktiebolag', 'owner')})`)
    expect(definition).toContain(`(${resolveExpenseLiabilityAccount('enskild_firma', 'owner')})`)
    expect(definition).toContain('egen insättning')
  })

  it('is found by the words people search with', () => {
    for (const query of ['utlägg', 'kvitto', 'privat']) {
      expect(`Eget utlägg ${definition}`.toLowerCase()).toContain(query)
    }
  })
})

describe('⌘K finds the inbox, where an utlägg starts', () => {
  it('both inbox entries (the workspace and the new Inkorg) carry the shared vocabulary', () => {
    expect(palette.match(/keywords: INBOX_SEARCH_KEYWORDS/g)?.length).toBe(2)
  })

  it('answers "utlägg", "kvitto" and the old inbox names', () => {
    for (const query of ['utlägg', 'kvitto', 'eget utlägg', 'betalat privat', 'underlag', 'dokumentinkorg']) {
      expect(paletteFinds(INBOX_SEARCH_KEYWORDS, query)).toBe(true)
    }
  })
})
