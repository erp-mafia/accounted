/**
 * The låneförbud (ABL 21:1-3, 21:8, 21:10) per circle and exception, as
 * the Bolaget research brief lists them. Conservative: everything the check
 * cannot clear is flagged with a warning, nothing is refused.
 */
import { describe, expect, it } from 'vitest'
import { assessLoanBan, type LoanBanInput } from '../loan-ban'

function input(over: Partial<LoanBanInput> = {}): LoanBanInput {
  return {
    direction: 'lends',
    kind: 'loan',
    relation: 'none',
    exception: 'none',
    party_kind: 'person',
    holder_capital_pct: null,
    is_board: false,
    is_ceo: false,
    ...over,
  }
}

describe('assessLoanBan', () => {
  it('a loan the company takes from an owner is outside the förbud', () => {
    expect(assessLoanBan(input({ direction: 'borrows', holder_capital_pct: 100 }))).toEqual({
      status: 'not_applicable',
      circle: [],
      exception: null,
      special_list: false,
      warnings: [],
    })
  })

  it('a borrower outside the circle is not flagged', () => {
    expect(assessLoanBan(input())).toMatchObject({ status: 'outside_circle', circle: [], warnings: [] })
  })

  it.each([
    ['a shareholder', { holder_capital_pct: 30 }, ['holder']],
    ['a board member', { is_board: true }, ['board']],
    ['the VD', { is_ceo: true }, ['ceo']],
    ['an insider of another group company', { relation: 'group_insider' as const }, ['group_insider']],
    ['a spouse, cohabitant or relative', { relation: 'related_person' as const }, ['related_person']],
    ['a legal person an insider controls', { relation: 'controlled_entity' as const, party_kind: 'company' as const }, ['controlled_entity']],
  ])('%s in the circle without an exception is flagged', (_label, over, circle) => {
    const r = assessLoanBan(input(over))
    expect(r.status).toBe('prohibited')
    expect(r.circle).toEqual(circle)
    expect(r.warnings.map((w) => w.code)).toEqual(['LOAN_BAN_PROHIBITED'])
    expect(r.warnings[0]!.message_sv).toContain('21 kap. 1 §')
  })

  it('a shareholder below 1 % of the capital is outside the förbud when that is the only link', () => {
    expect(assessLoanBan(input({ holder_capital_pct: 0.5 }))).toMatchObject({ status: 'exception', exception: 'small_holding', special_list: false, warnings: [] })
  })

  it('the 1 % exception does not cover a small shareholder who also sits on the board', () => {
    expect(assessLoanBan(input({ holder_capital_pct: 0.5, is_board: true }))).toMatchObject({ status: 'prohibited', circle: ['holder', 'board'] })
  })

  it('a business loan and a dispensation clear the loan and put it on the 21:10 special list', () => {
    for (const exception of ['business_loan', 'dispensation'] as const) {
      const r = assessLoanBan(input({ holder_capital_pct: 60, exception }))
      expect(r).toMatchObject({ status: 'exception', exception, special_list: true })
      expect(r.warnings.map((w) => w.code)).toEqual(['LOAN_SPECIAL_LIST'])
    }
  })

  it('the group company exception clears a loan to a company, not to a person', () => {
    expect(assessLoanBan(input({ party_kind: 'company', holder_capital_pct: 100, exception: 'group_company' }))).toMatchObject({
      status: 'exception',
      exception: 'group_company',
      special_list: false,
      warnings: [],
    })
    const person = assessLoanBan(input({ holder_capital_pct: 100, exception: 'group_company' }))
    expect(person.status).toBe('prohibited')
    expect(person.warnings.map((w) => w.code)).toEqual(['LOAN_BAN_GROUP_EXCEPTION_PERSON'])
  })

  it('security for an insider\'s debt is covered the same way (21:3)', () => {
    const r = assessLoanBan(input({ kind: 'security', is_ceo: true }))
    expect(r.status).toBe('prohibited')
    expect(r.warnings[0]!.message_sv.startsWith('Säkerheten')).toBe(true)
  })
})
