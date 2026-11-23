import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Bankrader's Bokför on a row, with the booking screen switched on: the row
 * opens on the booking screen, as it does from Att bokföra and Hem, except
 * where a match settles an invoice or the company books the proposal from
 * the row (direct booking). Without the switch nothing changes.
 */
const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf8')
const CARD_SRC = read('../TransactionInboxCard.tsx')
const PAGE_SRC = read('../../../app/(dashboard)/transactions/page.tsx')

describe('Bankrader Bokför with the booking screen', () => {
  it('opens a row without a proposal on the booking screen instead of the picker, only when the page hands the door', () => {
    expect(CARD_SRC).toMatch(
      /else if \(proposal && onBookProposal\) onBookProposal\(transaction\)\s*else if \(onOpenBookingScreen\) onOpenBookingScreen\(transaction\)\s*else onOpenCategoryDialog\(transaction, anchor\)/,
    )
    expect(PAGE_SRC).toContain('onOpenBookingScreen={bookingScreen ? openRowOnBookingScreen : undefined}')
  })

  it('books a sure proposal from the row first, and opens the screen in place of the review', () => {
    const body = PAGE_SRC.slice(PAGE_SRC.indexOf('function bookProposal('), PAGE_SRC.indexOf('async function bookProposalNow('))
    const direct = body.indexOf('return void bookDirect(transaction, s)')
    const screen = body.indexOf('if (bookingScreen) return openRowOnBookingScreen(transaction)')
    const review = body.indexOf('openReview(transaction, s, false)')
    expect(direct).toBeGreaterThan(-1)
    expect(screen).toBeGreaterThan(direct)
    expect(review).toBeGreaterThan(screen)
  })

  it('opens a picked template or counterpart on the booking screen with it used, in place of the quick review', () => {
    const review = PAGE_SRC.slice(PAGE_SRC.indexOf('function openReview('), PAGE_SRC.indexOf('function handleTemplateSelected('))
    const toScreen = review.indexOf('if (bookingScreen) {')
    expect(toScreen).toBeGreaterThan(-1)
    expect(review).toContain('stagePickedProposal(transaction.id, proposal)')
    expect(review).toContain("bookingScreenHref({ kind: 'transaction', transactionId: transaction.id, account: null, picked: true }")
    expect(review.indexOf('setQuickReviewOpen(true)')).toBeGreaterThan(toScreen)
  })

  it('returns to Bankrader with its filters', () => {
    expect(PAGE_SRC).toContain(
      "router.push(bookingScreenHref({ kind: 'transaction', transactionId: transaction.id, account: null }, `/transactions${window.location.search}`))",
    )
  })
})
