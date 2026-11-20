import { describe, it, expect } from 'vitest'
import { contestCounterpart, mergeAssistantSuggestion } from '../propose'
import { buildCounterpartySuggestion, getSuggestedTemplates, rowProposal } from '../category-suggestions'
import { booksWithoutReview } from '../direct-booking'
import { assistantSuggestionFromRead, type AssistantRead } from '@/lib/agent/categorize/read'
import { candidateFromProposal } from '@/lib/agent/categorize/candidates'
import { makeCategorizationTemplate, makeTransaction } from '@/tests/helpers'
import type { CategorizationTemplate } from '@/types'
import type { CounterpartyTemplateMatch } from '@/lib/bookkeeping/counterparty-templates'

/**
 * The stored read as a check on a weak counterpart match. The case behind
 * it: a restaurant row wore a software vendor's account (matched on a shared
 * city), while the read made an hour earlier had looked at that very
 * suggestion and booked the row elsewhere.
 */
const TX = { id: 'tx-1', amount: -473.63 }

function scene(opts: {
  method?: CounterpartyTemplateMatch['matchMethod']
  template?: Partial<CategorizationTemplate>
  /** The account the read booked the row on; null when it found nothing. */
  readAccount?: string | null
  /** Whether the counterpart was on the read's slate. */
  sawCounterpart?: boolean
} = {}) {
  const template = makeCategorizationTemplate({
    counterparty_name: 'resend san francisco kortköputtag',
    debit_account: '5420',
    vat_treatment: 'reverse_charge',
    occurrence_count: 1,
    ...opts.template,
  })
  const counterpart = buildCounterpartySuggestion(template, 0.38)
  const read: AssistantRead = {
    transaction_id: TX.id,
    underlag_key: null,
    has_underlag: false,
    account: opts.readAccount === undefined ? '5890' : opts.readAccount,
    category: 'expense_travel',
    vat_treatment: 'exempt',
    reverse_charge: false,
    confidence: 0.2,
    model_confidence: 'low',
    agreement: 0.67,
    from_candidate: false,
    reasoning: 'En restaurang, inte programvara.',
    candidates: opts.sawCounterpart === false ? [] : [candidateFromProposal(counterpart)],
    model: 'm',
  }
  const assistant = assistantSuggestionFromRead(read, TX, 'aktiebolag')
  const list = assistant ? mergeAssistantSuggestion([counterpart], assistant) : [counterpart]
  const match = { matchMethod: opts.method ?? 'token_subset', template }
  return { list, match, read, out: contestCounterpart(list, match, read) }
}

describe('contestCounterpart', () => {
  it('takes a weak match off the row when the read saw it and booked the row elsewhere', () => {
    const { out } = scene()
    expect(out.map((p) => [p.source, p.contested ?? false])).toEqual([
      ['counterparty', true],
      ['assistant', false],
    ])
    // The row recommends nothing: the read takes the match down, it does not take its place.
    expect(rowProposal(out)).toBeUndefined()
  })

  it('leaves the match alone when the read books the same account', () => {
    const { out } = scene({ readAccount: '5420' })
    expect(rowProposal(out)?.source).toBe('counterparty')
    expect(out.some((p) => p.contested)).toBe(false)
  })

  it('contests nothing when the read never saw the counterpart, or found nothing', () => {
    expect(rowProposal(scene({ sawCounterpart: false }).out)?.source).toBe('counterparty')
    expect(rowProposal(scene({ readAccount: null }).out)?.source).toBe('counterparty')
  })

  it('counts a match by name as weak only until the counterpart is a habit', () => {
    const byName = (template: Partial<CategorizationTemplate>) =>
      rowProposal(scene({ method: 'exact_normalized', template }).out)?.source
    expect(byName({ occurrence_count: 2 })).toBeUndefined()
    expect(byName({ occurrence_count: 3 })).toBe('counterparty')
  })

  it('never contests a rule the person set to book on its own, matched by name', () => {
    const { out } = scene({ method: 'exact_alias', template: { occurrence_count: 1, mode: 'auto' } })
    expect(rowProposal(out)?.source).toBe('counterparty')
  })

  it('treats a match on shared words or a near spelling as weak however often the counterpart was booked', () => {
    for (const method of ['token_subset', 'fuzzy'] as const) {
      const { out } = scene({ method, template: { occurrence_count: 40, mode: 'auto' } })
      expect(rowProposal(out)).toBeUndefined()
      // Not from the row, and not for an agent reading books_without_review either.
      expect(booksWithoutReview(out[0])).toBe(false)
    }
  })

  it('marks only the counterpart: a rule or a catalog match beside it is untouched', async () => {
    const { list, match, read } = scene()
    const catalog = await getSuggestedTemplates(
      makeTransaction({ description: 'Spotify', merchant_name: 'Spotify', amount: -119 }),
      'aktiebolag',
    )
    expect(catalog.length).toBeGreaterThan(0)
    const out = contestCounterpart([...list, ...catalog], match, read)
    expect(out.filter((p) => p.contested).map((p) => p.source)).toEqual(['counterparty'])
  })
})
