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
})
