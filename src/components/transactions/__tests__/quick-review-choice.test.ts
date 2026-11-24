import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * What the Bokför review does with a booking somebody changed (PostHog 170):
 * the person set another account than the assistant proposed, closed the
 * review, and found the assistant's proposal back when they opened it again.
 * The decisions are pure and tested where they live
 * (lib/bookkeeping/proposal.ts, lib/transactions/review-choice.ts); Vitest
 * runs in `node` and never renders components, so like the sibling dialog
 * tests these are file-level assertions that the dialog, the page and the row
 * route through them.
 */

const read = (relative: string) => fs.readFileSync(path.resolve(__dirname, relative), 'utf8')
const DIALOG_SRC = read('../QuickReviewDialog.tsx')
const PAGE_SRC = read('../../../app/(dashboard)/transactions/page.tsx')
const CARD_SRC = read('../TransactionInboxCard.tsx')
const DRAWER_SRC = read('../TransactionDrawer.tsx')

describe('QuickReviewDialog: the category of a booking whose account was named', () => {
  it('takes the assistant pick over the shown proposal without inheriting a category that books no moms', () => {
    // A candidate pick carries no category of its own. Inheriting 'private'
    // from the proposal it replaces booked its cost account without moms.
    expect(DIALOG_SRC).toMatch(/carriedCategory\(p\.booking\.category,\s*pick\.account,\s*amountForLegs\)/)
    expect(DIALOG_SRC).not.toMatch(/'income_other'\)\s*:\s*p\.booking\.category\)/)
  })

  it('changes the account and the VAT through withAccount, which decides the category', () => {
    expect(DIALOG_SRC).toMatch(/return withAccount\(p,\s*account,\s*vat,\s*amountForLegs/)
    expect(DIALOG_SRC).toMatch(/setProposal\(\(p\)\s*=>\s*withAccount\(/)
  })
})

describe('QuickReviewDialog: the booking the person set', () => {
  it('names it by the account they picked, so the header stops naming the machine\'s pick', () => {
    expect(DIALOG_SRC).toMatch(/return withAccount\(p,\s*account,\s*vat,\s*amountForLegs,\s*label\)/)
    // The company's own name for the account first, the catalogue's after.
    expect(DIALOG_SRC).toMatch(
      /accounts\.find\(\(a\) => a\.account_number === account\)\?\.account_name \?\?\s*basCatalog\.find/,
    )
  })

  it('tells the page what it holds, with the row\'s own pin, whenever either changes', () => {
    expect(DIALOG_SRC).toMatch(/const rowUnderlagKey = underlagState\.source === 'pinned' \? documentId : null/)
    expect(DIALOG_SRC).toMatch(
      /useEffect\(\(\) => \{\s*if \(reviewedId\) onProposalChange\?\.\(reviewedId, \{ proposal, underlag_key: rowUnderlagKey, activate: pickedToActivate \}\)\s*\}, \[reviewedId, proposal, rowUnderlagKey, pickedToActivate, onProposalChange\]\)/,
    )
  })

  it('still activates the account the person picked from the catalogue when it opens on that booking again', () => {
    // Only that pick is ever activated (crm#1101): it comes back from the
    // page with the kept choice, nothing is derived from the proposal.
    expect(DIALOG_SRC).toMatch(/useState<string \| null>\(activateOnBooking\)/)
    expect(DIALOG_SRC).toMatch(/proposal\.booking\.account === pickedToActivate && wholeChart/)
    expect(PAGE_SRC).toMatch(
      /activateOnBooking=\{quickReview \? activationFor\(reviewChoices, quickReview\.transaction\.id, quickReview\.proposal\) : null\}/,
    )
  })

  it('never lets the assistant\'s pick take over a booking the person set', () => {
    // Before: autoApply={!isTemplateBooking}. A booking reopened as the
    // person's own is an account booking, so the stored read would have
    // replaced it the moment the review opened.
    // A review opened in the read's reverse-charge box (accounted#37) holds
    // a proposal with its own source: the pick does not take it over either,
    // nor a clearing proposal (the till's record says the money is already booked),
    // nor a learned pair opened in its own box because nothing confirms it.
    expect(DIALOG_SRC).toMatch(
      /autoApply=\{!isTemplateBooking && !isPersonChoice\(proposal\) && !docRead && !boxDispute && !inOwnBox && proposal\.source !== 'clearing'\}/,
    )
    expect(DIALOG_SRC).not.toMatch(/autoApply=\{!isTemplateBooking\}/)
  })

  it('offers the read of the document attached here as the alternative, once the person moved off it', () => {
    expect(DIALOG_SRC).toMatch(/initial=\{docRead \?\? \(assistantRead && readIsFresh\(assistantRead, tx\) \? assistantRead : null\)\}/)
    // Kept only together with taking the pick, when the assistant's line is
    // not on screen: the read that line opened with must not change under it.
    expect(DIALOG_SRC).toMatch(/setDocRead\(read\)\s*setAiProposal\(proposalMetaFromRead\(read, pick\)\)\s*takeAssistantPick\(pick, \{ auto: false, fromDocument: true \}\)/)
  })
})

describe('Transaktioner: the row keeps the booking the person set', () => {
  it('keeps what the review reports', () => {
    expect(PAGE_SRC).toMatch(/setReviewChoices\(\(prev\) => rememberReviewChoice\(prev, transactionId, held\)\)/)
    expect(PAGE_SRC).toContain('onProposalChange={handleReviewProposalChange}')
  })

  it('asks for it before the row\'s proposals, for the chip and for Bokför alike', () => {
    expect(PAGE_SRC).toMatch(/reviewChoiceFor\(reviewChoices, tx\) \?\? rowProposal\(templateSuggestions\[tx\.id\]\)/)
    // One resolver: the chip and Bokför cannot disagree about the row.
    expect(PAGE_SRC.match(/rowProposal\(templateSuggestions\[/g)).toHaveLength(1)
    expect(PAGE_SRC).toMatch(/const proposalFor = [\s\S]{0,200}const s = rowProposalFor\(tx\)/)
    expect(PAGE_SRC).toMatch(/function bookProposal\(transaction: TransactionWithInvoice\) \{\s*const s = rowProposalFor\(transaction\)/)
  })

  it('marks it as the person\'s on the row: its why, not a recommendation with a confidence', () => {
    expect(PAGE_SRC).toContain('own: isPersonChoice(s)')
    expect(CARD_SRC).toMatch(/proposal\.own\s*\?\s*proposal\.why\s*:\s*t\('proposal_title'/)
    expect(CARD_SRC).toContain('proposalOwn={!categoryLabel && !!proposal?.own}')
    expect(DRAWER_SRC).toMatch(/proposalOwn \? proposalWhy : t\('drawer_rec', \{ why: proposalWhy \}\)/)
  })

  it('says "Vald av dig" in both locales', () => {
    for (const locale of ['sv', 'en'] as const) {
      const messages = JSON.parse(read(`../../../messages/${locale}.json`)) as Record<string, Record<string, string>>
      expect(messages.tx_quick_review.rec_why_manual, locale).toBeTruthy()
      expect(messages.tx_quick_review.rec_kicker_manual, locale).toBeTruthy()
    }
  })
})
