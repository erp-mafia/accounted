import { describe, it, expect } from 'vitest'
import { accountProposal, type BookingProposal } from '@/lib/bookkeeping/proposal'
import { businessAccountOfLines, classifyBankLineDecision, type BankLineFinal } from '../classify'

const assistant = accountProposal({
  id: 'assistant:tx-1',
  source: 'assistant',
  account: '6540',
  label: 'IT-tjänster',
  category: 'expense_software',
  vat_treatment: 'standard_25',
  amount: -500,
  confidence: 0.82,
})

const counterparty: BookingProposal = {
  template_id: 'cp:abc',
  source: 'counterparty',
  booking: { kind: 'counterparty', counterparty_template_id: 'abc' },
  name_sv: 'GitHub',
  name_en: 'GitHub',
  group: 'counterparty',
  debit_account: '6230',
  credit_account: '1930',
  confidence: 0.95,
  description_sv: '',
  risk_level: 'LOW',
  requires_review: false,
  vat_treatment: 'standard_25',
}

const picked = accountProposal({
  id: 'account:6540',
  source: 'manual',
  account: '6540',
  label: 'x',
  category: 'expense_software',
  vat_treatment: 'standard_25',
  amount: -500,
})

function final(over: Partial<BankLineFinal> = {}): BankLineFinal {
  return { journal_entry_id: 'je-1', booking: null, account: '6540', vat_treatment: 'standard_25', lines: [], ...over }
}

const read = { model: 'claude-sonnet', prompt_sha256: 'abc123' }

describe('classifyBankLineDecision', () => {
  it('accepted: the named suggestion was booked as offered', () => {
    const out = classifyBankLineDecision({ proposals: [counterparty, assistant], read, actedOn: 'assistant:tx-1', final: final() })
    expect(out.outcome).toBe('accepted')
    expect(out.acted_on).toBe(1)
    expect(out.suggestions.map((s) => s.matches_final)).toEqual([false, true])
  })

  it('logs that a counterpart match was contested, so the veto can be judged against what was booked', () => {
    const out = classifyBankLineDecision({ proposals: [{ ...counterparty, contested: true }, assistant], read, actedOn: null, final: final() })
    expect(out.suggestions.map((s) => s.contested)).toEqual([true, undefined])
  })

  it('changed: the named suggestion was edited to another account', () => {
    const out = classifyBankLineDecision({ proposals: [assistant], read, actedOn: 'assistant:tx-1', final: final({ account: '5410' }) })
    expect(out).toMatchObject({ outcome: 'changed', acted_on: 0 })
  })

  it('changed: same account, other VAT treatment', () => {
    const out = classifyBankLineDecision({ proposals: [assistant], actedOn: 'assistant:tx-1', final: final({ vat_treatment: 'exempt' }) })
    expect(out.outcome).toBe('changed')
  })

  it('accepted by identity: a counterpart booked by its own id, whatever the account read', () => {
    const out = classifyBankLineDecision({
      proposals: [counterparty],
      actedOn: 'cp:abc',
      final: final({ booking: { kind: 'counterparty', counterparty_template_id: 'abc' }, account: null }),
    })
    expect(out.outcome).toBe('accepted')
  })

  it('manual: no suggestion named, while matches_final still shows who agreed', () => {
    const out = classifyBankLineDecision({ proposals: [counterparty, assistant], final: final() })
    expect(out).toMatchObject({ outcome: 'manual', acted_on: null })
    expect(out.suggestions[1].matches_final).toBe(true)
  })

  it('manual: the named suggestion was not on offer when the decision was made', () => {
    const out = classifyBankLineDecision({ proposals: [counterparty], actedOn: 'assistant:tx-1', final: final() })
    expect(out).toMatchObject({ outcome: 'manual', acted_on: null })
  })

  it('dismissed: no final, nothing matches', () => {
    const out = classifyBankLineDecision({ proposals: [assistant], read, actedOn: 'assistant:tx-1', final: null })
    expect(out).toMatchObject({ outcome: 'dismissed', acted_on: null })
    expect(out.suggestions[0].matches_final).toBe(false)
  })

  it('keeps an account the person picked out of the suggestions', () => {
    const out = classifyBankLineDecision({ proposals: [picked, assistant], actedOn: 'account:6540', final: final() })
    expect(out.suggestions.map((s) => s.source_id)).toEqual(['assistant:tx-1'])
    expect(out.outcome).toBe('manual')
  })

  it('carries rank, source vocabulary, and the model and prompt hash on the assistant only', () => {
    const out = classifyBankLineDecision({ proposals: [counterparty, assistant], read, final: final() })
    expect(out.suggestions[0]).toMatchObject({ source: 'counterparty_template', rank: 0, model: null, prompt_sha256: null })
    expect(out.suggestions[1]).toMatchObject({
      source: 'assistant',
      rank: 1,
      confidence: 0.82,
      model: 'claude-sonnet',
      prompt_sha256: 'abc123',
      proposal: { booking: { kind: 'account', account: '6540' }, vat_treatment: 'standard_25' },
    })
  })

  it("keeps the assistant read's agreement, candidate origin and reasoning hash on the assistant only", () => {
    const out = classifyBankLineDecision({
      proposals: [counterparty, assistant],
      read: { ...read, agreement: 0.67, from_candidate: true, reasoning_sha256: 'r'.repeat(64) },
      final: final(),
    })
    expect(out.suggestions[0]).not.toHaveProperty('agreement')
    expect(out.suggestions[1]).toMatchObject({ agreement: 0.67, from_candidate: true, reasoning_sha256: 'r'.repeat(64) })
  })

  it('keeps the evidence the direct-booking policy reads, only the keys the proposal carried', () => {
    const out = classifyBankLineDecision({
      proposals: [{ ...counterparty, seen_count: 4, rule_mode: 'propose' }, assistant],
      final: final(),
    })
    expect(out.suggestions[0].evidence).toEqual({ seen_count: 4, rule_mode: 'propose' })
    expect(out.suggestions[1]).not.toHaveProperty('evidence')
  })

  it("bands the acted-on suggestion by the direct-booking policy, on the proposal as offered", () => {
    const on = { enabled: true }
    const habit = { ...counterparty, seen_count: 3, rule_mode: 'propose' as const }
    expect(classifyBankLineDecision({ proposals: [habit], actedOn: 'cp:abc', final: final({ account: '6230' }), directBooking: on }).confidence_band).toBe('direct')
    // Contested by the read: never booked from the row, whatever the habit.
    expect(
      classifyBankLineDecision({ proposals: [{ ...habit, contested: true }], actedOn: 'cp:abc', final: final({ account: '6230' }), directBooking: on }).confidence_band,
    ).toBe('review')
    // The assistant's own 0.82 is backing-floored, but without a receipt behind it the row opens a review.
    expect(classifyBankLineDecision({ proposals: [assistant], actedOn: 'assistant:tx-1', final: final(), directBooking: on }).confidence_band).toBe('review')
    expect(
      classifyBankLineDecision({ proposals: [{ ...assistant, has_underlag: true }], actedOn: 'assistant:tx-1', final: final(), directBooking: on }).confidence_band,
    ).toBe('direct')
  })

  it('bands under the company switch and the rule flags, and keeps the flags as evidence (accounted#130)', () => {
    const habit = { ...counterparty, seen_count: 9, rule_mode: 'propose' as const }
    const decide = (p: typeof habit, directBooking: { enabled: boolean }) =>
      classifyBankLineDecision({ proposals: [p], actedOn: 'cp:abc', final: final({ account: '6230' }), directBooking })
    expect(decide(habit, { enabled: false }).confidence_band).toBe('review')
    const imported = decide({ ...habit, rule_import_unconfirmed: true } as typeof habit, { enabled: true })
    expect(imported.confidence_band).toBe('review')
    expect(imported.suggestions[0].evidence).toMatchObject({ rule_import_unconfirmed: true })
    const asks = decide({ ...habit, rule_always_review: true } as typeof habit, { enabled: true })
    expect(asks.confidence_band).toBe('review')
    expect(asks.suggestions[0].evidence).toMatchObject({ rule_always_review: true })
    // A false flag is not written: the evidence keeps only what asked.
    expect(decide({ ...habit, rule_always_review: false, rule_import_unconfirmed: false } as typeof habit, { enabled: true }).suggestions[0].evidence).toEqual({
      seen_count: 9,
      rule_mode: 'propose',
    })
  })

  it('decides no band without the switch it is read under (a failed snapshot)', () => {
    const habit = { ...counterparty, seen_count: 3, rule_mode: 'propose' as const }
    expect(classifyBankLineDecision({ proposals: [habit], actedOn: 'cp:abc', final: final({ account: '6230' }) }).confidence_band).toBeNull()
  })

  it('has no band without an acted-on suggestion', () => {
    expect(classifyBankLineDecision({ proposals: [counterparty], final: final() }).confidence_band).toBeNull()
    expect(classifyBankLineDecision({ proposals: [counterparty], actedOn: 'cp:abc', final: null }).confidence_band).toBeNull()
  })
})

describe('businessAccountOfLines', () => {
  it('is the one account that is neither bank nor VAT', () => {
    expect(businessAccountOfLines([
      { account: '6540', debit: 400, credit: 0 },
      { account: '2641', debit: 100, credit: 0 },
      { account: '1930', debit: 0, credit: 500 },
    ])).toBe('6540')
  })

  it('is null when the lines split over several business accounts, or carry none', () => {
    expect(businessAccountOfLines([
      { account: '2710', debit: 300, credit: 0 },
      { account: '2731', debit: 200, credit: 0 },
      { account: '1630', debit: 0, credit: 500 },
    ])).toBeNull()
    expect(businessAccountOfLines([])).toBeNull()
  })

  it('leaves a card row\'s own settlement ledger out, like 19xx', () => {
    const cardPurchase = [
      { account: '6540', debit: 400, credit: 0 },
      { account: '2641', debit: 100, credit: 0 },
      { account: '2890', debit: 0, credit: 500 },
    ]
    expect(businessAccountOfLines(cardPurchase, ['2890'])).toBe('6540')
    // Without it 2890 is a second business account (a bank row paying a debt).
    expect(businessAccountOfLines(cardPurchase)).toBeNull()
  })
})
