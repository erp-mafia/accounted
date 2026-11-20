import { describe, expect, it } from 'vitest'
import { makeTransaction } from '@/tests/helpers'
import {
  accountProposal,
  categorizeBodyFor,
  proposalFromTemplate,
  whyKeyFor,
  withAccount,
  type BookingProposal,
} from '@/lib/bookkeeping/proposal'
import { getTemplateById } from '@/lib/bookkeeping/booking-templates'
import { rowProposal } from '../category-suggestions'
import { booksWithoutReview } from '../direct-booking'
import {
  activationFor,
  isPersonChoice,
  rememberReviewChoice,
  reviewChoiceFor,
  type ReviewChoice,
  type ReviewChoices,
} from '../review-choice'

/**
 * The booking a person set in the Bokför review, kept for the row
 * (PostHog 170). The person changed the account the assistant proposed,
 * closed the review and opened it again: the review was back on the
 * assistant's proposal. The page keeps what the review reports through
 * rememberReviewChoice and asks reviewChoiceFor before the row's proposals.
 */

const TX = 'tx-1'
const DOC = 'doc-1'

// What the assistant proposed off the invoice: a private cost, which an
// aktiebolag books on 2893.
const assistantPick: BookingProposal = accountProposal({
  id: `assistant:${TX}`,
  source: 'assistant',
  account: '2893',
  label: 'Skuld till ägare',
  category: 'private',
  vat_treatment: 'exempt',
  amount: -1000,
  confidence: 0.5,
  has_underlag: true,
})

// The account the person set over it.
const ownChoice = withAccount(assistantPick, '7699', 'standard_25', -1000, 'Övriga personalkostnader')

const row = (overrides: Parameters<typeof makeTransaction>[0] = {}) =>
  makeTransaction({ id: TX, amount: -1000, document_id: DOC, ...overrides })

/** What a review reports: its booking, the row's pin, the account it activates at booking. */
const held = (proposal: BookingProposal, underlagKey: string | null, activate: string | null = null): ReviewChoice => ({
  proposal,
  underlag_key: underlagKey,
  activate,
})

describe('isPersonChoice', () => {
  it('is a booking the person set or picked, never one a source proposed', () => {
    expect(isPersonChoice(ownChoice)).toBe(true)
    expect(isPersonChoice(proposalFromTemplate(getTemplateById('telecom_mobile')!, 'manual'))).toBe(true)
    expect(isPersonChoice(assistantPick)).toBe(false)
    for (const source of ['rule', 'recent', 'catalog', 'counterparty'] as const) {
      expect(isPersonChoice({ source })).toBe(false)
    }
  })
})

describe('rememberReviewChoice', () => {
  it('keeps the booking the person set, with the underlag the row pins', () => {
    const kept = rememberReviewChoice({}, TX, held(ownChoice, DOC))
    expect(kept).toEqual({ [TX]: { proposal: ownChoice, underlag_key: DOC, activate: null } })
  })

  it('keeps nothing for the proposal a review merely opened with', () => {
    const before: ReviewChoices = {}
    expect(rememberReviewChoice(before, TX, held(assistantPick, DOC))).toBe(before)
  })

  it('returns the same object when the review reports what is already kept', () => {
    const kept = rememberReviewChoice({}, TX, held(ownChoice, DOC, '7699'))
    expect(rememberReviewChoice(kept, TX, held(ownChoice, DOC, '7699'))).toBe(kept)
  })

  it('follows the review: the latest booking, and the underlag attached in it', () => {
    const first = rememberReviewChoice({}, TX, held(ownChoice, null))
    const attached = rememberReviewChoice(first, TX, held(ownChoice, DOC))
    expect(attached[TX]).toEqual({ proposal: ownChoice, underlag_key: DOC, activate: null })

    const again = withAccount(ownChoice, '7699', 'reduced_12', -1000)
    expect(rememberReviewChoice(attached, TX, held(again, DOC))[TX].proposal).toBe(again)
  })

  it('lets go when the person takes a proposal instead (the assistant\'s pick, Ångra)', () => {
    const other = rememberReviewChoice({}, 'tx-2', held(ownChoice, null))
    const kept = rememberReviewChoice(other, TX, held(ownChoice, DOC, '7699'))
    const after = rememberReviewChoice(kept, TX, held(assistantPick, DOC, '7699'))
    expect(after).toEqual(other)
  })

  // The account the person picked from the catalogue that the chart lacks:
  // the review activates it before booking, and only that one (crm#1101).
  it('keeps the account the review activates at booking, only for the booking that is on it', () => {
    const kept = rememberReviewChoice({}, TX, held(ownChoice, DOC, '7699'))
    expect(kept[TX].activate).toBe('7699')

    // The person moved on to an account the chart has: nothing to activate.
    const onChart = withAccount(ownChoice, '6991', 'standard_25', -1000, 'Övriga kostnader')
    expect(rememberReviewChoice(kept, TX, held(onChart, DOC, null))[TX].activate).toBeNull()
    // A pick left over from another account never rides along.
    expect(rememberReviewChoice(kept, TX, held(onChart, DOC, '7699'))[TX].activate).toBeNull()
    // A template books its own accounts.
    const template = proposalFromTemplate(getTemplateById('telecom_mobile')!, 'manual')
    expect(rememberReviewChoice({}, TX, held(template, DOC, '7699'))[TX].activate).toBeNull()
  })
})

describe('activationFor', () => {
  const kept = rememberReviewChoice({}, TX, held(ownChoice, DOC, '7699'))

  it('hands the reopened review the account its first open was going to activate', () => {
    expect(activationFor(kept, TX, ownChoice)).toBe('7699')
  })

  it('activates nothing for any other proposal, or any other row', () => {
    expect(activationFor(kept, TX, assistantPick)).toBeNull()
    expect(activationFor(kept, TX, { ...ownChoice })).toBeNull()
    expect(activationFor(kept, 'tx-2', ownChoice)).toBeNull()
    expect(activationFor({}, TX, ownChoice)).toBeNull()
  })
})

describe('reviewChoiceFor', () => {
  const kept = rememberReviewChoice({}, TX, held(ownChoice, DOC))

  it('stands while the row is unbooked and pins the same underlag', () => {
    expect(reviewChoiceFor(kept, row())).toBe(ownChoice)
  })

  it('stands for a row without underlag when it was made without one', () => {
    const bare = rememberReviewChoice({}, TX, held(ownChoice, null))
    expect(reviewChoiceFor(bare, row({ document_id: null }))).toBe(ownChoice)
  })

  it('lapses when the row pins another underlag, or none: a new question for the proposals', () => {
    expect(reviewChoiceFor(kept, row({ document_id: 'doc-2' }))).toBeNull()
    expect(reviewChoiceFor(kept, row({ document_id: null }))).toBeNull()
    const bare = rememberReviewChoice({}, TX, held(ownChoice, null))
    expect(reviewChoiceFor(bare, row())).toBeNull()
  })

  it('is not offered for a row that is booked or already decided', () => {
    expect(reviewChoiceFor(kept, row({ journal_entry_id: 'je-1' }))).toBeNull()
    expect(reviewChoiceFor(kept, row({ is_business: true }))).toBeNull()
    expect(reviewChoiceFor(kept, row({ is_business: false }))).toBeNull()
  })

  it('answers null for a row nobody decided', () => {
    expect(reviewChoiceFor(kept, row({ id: 'tx-2' }))).toBeNull()
    expect(reviewChoiceFor({}, row())).toBeNull()
  })
})

describe('the row after the review closes (PostHog 170)', () => {
  // The page resolves a row as reviewChoiceFor(...) ?? rowProposal(...).
  const proposals = [assistantPick]
  const resolve = (choices: ReviewChoices, tx = row()) => reviewChoiceFor(choices, tx) ?? rowProposal(proposals)

  it('opens on the machine\'s proposal while nobody has decided', () => {
    expect(resolve({})).toBe(assistantPick)
  })

  it('opens on the account the person set, marked as theirs, and books it with its moms', () => {
    const choices = rememberReviewChoice({}, TX, held(ownChoice, DOC))
    const reopened = resolve(choices)!
    expect(reopened).toBe(ownChoice)
    expect(reopened.name_sv).toBe('Övriga personalkostnader')
    expect(whyKeyFor(reopened)).toEqual({ key: 'rec_why_manual' })
    expect(categorizeBodyFor(reopened)).toEqual({
      is_business: true,
      category: 'expense_other',
      account_override: '7699',
      vat_treatment: 'standard_25',
    })
  })

  it('never books the person\'s choice from the row without the review', () => {
    expect(booksWithoutReview(ownChoice)).toBe(false)
  })

  it('goes back to the proposals once the underlag changes', () => {
    const choices = rememberReviewChoice({}, TX, held(ownChoice, DOC))
    expect(resolve(choices, row({ document_id: 'doc-2' }))).toBe(assistantPick)
  })
})
