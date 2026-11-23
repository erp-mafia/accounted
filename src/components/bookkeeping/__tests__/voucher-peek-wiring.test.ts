/**
 * The verifikat side panel's wiring, which a render test in the node
 * environment cannot click through.
 *
 * Under Pengar, Bankrader and an account's reconciliation link each row to
 * its verifikat. Those links used to navigate to the verifikat page, whose
 * way back leads to the verifikat list, so the list being worked was lost for
 * every row checked. They render through VoucherPeekLink: still a real anchor
 * to the page, with a plain click read in a panel over the list.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('next-intl', () => {
  const t = (key: string) => key
  return { useTranslations: () => Object.assign(t, { has: () => true }) }
})

vi.mock('next/link', () => ({
  // prefetch is next/link's own prop, not an anchor attribute.
  default: ({ href, children, prefetch: _prefetch, ...rest }: { href: string; children: ReactNode; prefetch?: boolean }) =>
    createElement('a', { href, ...rest }, children),
}))

const { VoucherPeekLink } = await import('../VoucherPeekLink')

const read = (path: string) => readFileSync(join(process.cwd(), 'src', path), 'utf8')
const count = (source: string, needle: string) => source.split(needle).length - 1

const history = read('components/transactions/TransactionHistoryList.tsx')
const pairs = read('components/reconciliation/ReconciliationPairs.tsx')
const peekLink = read('components/bookkeeping/VoucherPeekLink.tsx')
const peek = read('components/bookkeeping/VoucherPeek.tsx')
const peekReads = read('lib/bookkeeping/voucher-peek.ts')

describe('verifikat links in the Pengar lists', () => {
  it('Bankrader renders both of its verifikat links through the peek link', () => {
    expect(history).toContain("import { VoucherPeekLink } from '@/components/bookkeeping/VoucherPeekLink'")
    expect(count(history, '<VoucherPeekLink')).toBe(2)
    // A bank row's verifikat, one per linked entry, and a skattekonto row's.
    expect(history).toMatch(/<VoucherPeekLink\s+key=\{entryId\}\s+entryId=\{entryId\}/)
    expect(history).toContain('<VoucherPeekLink entryId={row.journal_entry_id}')
  })

  it("an account's reconciliation renders all five of its verifikat links through the peek link", () => {
    expect(pairs).toContain("import { VoucherPeekLink } from '@/components/bookkeeping/VoucherPeekLink'")
    expect(count(pairs, '<VoucherPeekLink')).toBe(5)
    // Each link opens the verifikat its row names: the ledger row's own (its
    // number and its Granska), a matched verifikat, a proposed one, a linked one.
    expect(count(pairs, '<VoucherPeekLink entryId={item.item_id}')).toBe(2)
    expect(count(pairs, '<VoucherPeekLink entryId={v.journal_entry_id}')).toBe(1)
    expect(count(pairs, '<VoucherPeekLink entryId={p.journal_entry_id}')).toBe(1)
    expect(count(pairs, '<VoucherPeekLink entryId={item.linked_journal_entry_id}')).toBe(1)
  })

  it('neither list links to the verifikat page by hand', () => {
    expect(history).not.toContain('`/bookkeeping/${')
    expect(pairs).not.toContain('`/bookkeeping/${')
  })
})

describe('VoucherPeekLink', () => {
  it('is a real anchor to the verifikat page, with the caller\'s props on it and no panel until it is opened', () => {
    const props = { entryId: 'entry-1', className: 'quiet', 'data-ph-mask': '' }
    const html = renderToStaticMarkup(createElement(VoucherPeekLink, props, 'A12'))
    expect(html).toBe('<a href="/bookkeeping/entry-1" aria-haspopup="dialog" class="quiet" data-ph-mask="">A12</a>')
  })

  it('lets the click decision in lib decide, after the caller\'s own handler', () => {
    const handler = peekLink.slice(peekLink.indexOf('onClick={(event) => {'))
    const callerFirst = handler.indexOf('onClick?.(event)')
    const decision = handler.indexOf('if (!opensPeek(event)) return')
    const prevented = handler.indexOf('event.preventDefault()')
    expect(callerFirst).toBeGreaterThan(-1)
    expect(decision).toBeGreaterThan(callerFirst)
    // Only a click that opens the panel loses its navigation.
    expect(prevented).toBeGreaterThan(decision)
    expect(peekLink).toContain('href={voucherPageHref(entryId)}')
  })

  it('takes the focus back when the panel has closed', () => {
    expect(peekLink).toContain('opener.current = event.currentTarget')
    expect(peekLink).toContain('onClosed={() => opener.current?.focus()}')
    expect(peek).toMatch(/onCloseAutoFocus=\{\(event\) => \{\s*event\.preventDefault\(\)\s*onClosed\?\.\(\)/)
  })
})

describe('VoucherPeek is read-only', () => {
  it('sends no request with a method of its own: every read is a GET', () => {
    for (const source of [peek, peekReads]) {
      expect(source).not.toMatch(/\bmethod\s*:/)
      expect(source).not.toMatch(/\b(POST|PUT|PATCH|DELETE)\b/)
    }
  })

  it('reads through the journal entry endpoint and the shared rättelse flags, not a route of its own', () => {
    expect(peekReads).toContain('`/api/bookkeeping/journal-entries/${encodeURIComponent(entryId)}`')
    expect(peekReads).toContain('fetchRattelseFlags([entryId], request)')
  })

  it('renders none of the verifikat page\'s write surfaces', () => {
    // The page's underlag list uploads, replaces and detaches; the panel links the files instead.
    expect(peek).not.toContain('JournalEntryAttachments')
    expect(peek).not.toMatch(/Correct\w*Dialog|StrikeLinesDialog|useReverseJournalEntry|DocumentUploadZone/)
    // Its one way on is the link to the page, where the actions live.
    expect(peek).toContain('<IntentLink href={voucherPageHref(entryId)}>')
  })

  it('shows the lines in the shared posting table, whose totals round with roundOre', () => {
    expect(peek).toContain('<VoucherLinesTable')
    expect(peek).toContain('showTotals')
    expect(peek).not.toMatch(/toFixed|Math\.round/)
  })
})
