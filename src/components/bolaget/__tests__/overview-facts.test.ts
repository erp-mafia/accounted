import { describe, expect, it } from 'vitest'
import { overviewFacts, type CommitmentsAnswer, type MeetingAnswer, type RegisterAnswer } from '../overview-facts'
import type { ObligationView } from '@/lib/commitments/types'

const TODAY = '2026-10-30'

const register = (over: Partial<RegisterAnswer['register']['reconciliation']> = {}): RegisterAnswer => ({
  register: { total_shares: 500, holders: [{}, {}], reconciliation: { status: 'match', register_shares: 500, settings_shares: 500, ...over } },
  roles: {
    signatory_rule: 'Styrelsen',
    roles: [
      { name: 'Ordf', role: 'styrelseordforande', active: true },
      { name: 'Ledamot', role: 'styrelseledamot', active: true },
      { name: 'Avgången', role: 'styrelseledamot', active: false },
      { name: 'Suppleant', role: 'styrelsesuppleant', active: true },
      { name: 'VD', role: 'vd', active: true },
    ],
  },
})

const payment = (over: Partial<ObligationView>): ObligationView => ({
  obligation_id: 'o',
  agreement_id: 'a',
  agreement_title: 'Lån',
  kind: 'loan',
  due_on: '2026-11-30',
  amount: 100,
  currency: 'SEK',
  direction: 'out',
  status: 'expected',
  amount_is_estimate: false,
  transaction_id: null,
  ...over,
})

describe('overviewFacts', () => {
  it('says how many owners and whether the aktiebok holds every share', () => {
    expect(overviewFacts({ today: TODAY, register: register(), meetings: null, commitments: null }).owners).toEqual({
      holders: 2,
      shares: 500,
      allocation: 'all',
      register_shares: 500,
      settings_shares: 500,
    })
    expect(overviewFacts({ today: TODAY, register: register({ status: 'mismatch', register_shares: 400 }), meetings: null, commitments: null }).owners?.allocation).toBe('part')
    expect(overviewFacts({ today: TODAY, register: register({ status: 'settings_empty', settings_shares: null }), meetings: null, commitments: null }).owners?.allocation).toBeNull()
  })

  it('names the sitting board members (not suppleanter, not who left) and the firmateckning', () => {
    expect(overviewFacts({ today: TODAY, register: register(), meetings: null, commitments: null }).board).toEqual({
      members: ['Ordf', 'Ledamot'],
      signatory_rule: 'Styrelsen',
    })
  })

  it('picks the next planned meeting, or says there is none', () => {
    const meetings: MeetingAnswer = {
      meetings: [
        { corporate_meeting_id: '1', title: 'Held', meeting_date: '2026-11-01', status: 'held' },
        { corporate_meeting_id: '2', title: 'Past draft', meeting_date: '2026-10-01', status: 'draft' },
        { corporate_meeting_id: '3', title: 'Later', meeting_date: '2026-12-15', status: 'draft' },
        { corporate_meeting_id: '4', title: 'Next', meeting_date: '2026-11-20', status: 'draft' },
      ],
    }
    expect(overviewFacts({ today: TODAY, register: null, meetings, commitments: null }).next_meeting).toEqual({ title: 'Next', date: '2026-11-20' })
    expect(overviewFacts({ today: TODAY, register: null, meetings: { meetings: [] }, commitments: null }).next_meeting).toBe('none')
  })

  it('gives the next payment per agreement, the others as a count, and missed ones apart', () => {
    const commitments: CommitmentsAnswer = {
      agreements: [{ status: 'active' }, { status: 'active' }, { status: 'ended' }],
      upcoming_payments: [
        payment({ obligation_id: 'l1', agreement_id: 'loan', due_on: '2026-11-30' }),
        payment({ obligation_id: 'l2', agreement_id: 'loan', due_on: '2026-12-31' }),
        payment({ obligation_id: 'r1', agreement_id: 'rent', agreement_title: 'Hyra', due_on: '2026-12-01' }),
        payment({ obligation_id: 'x1', agreement_id: 'late', agreement_title: 'Sen', due_on: '2026-10-10', status: 'missed' }),
      ],
    }
    const facts = overviewFacts({ today: TODAY, register: null, meetings: null, commitments })
    expect(facts.payments).toMatchObject({ next: { agreement_id: 'loan', due_on: '2026-11-30', more: 1 }, others: 1, missed: 1 })
    expect(facts.agreements).toEqual({ active: 2 })
  })

  it('leaves out every line whose register is closed or failed', () => {
    expect(overviewFacts({ today: TODAY, register: null, meetings: null, commitments: null })).toEqual({
      owners: null,
      board: null,
      next_meeting: null,
      payments: null,
      agreements: null,
    })
  })
})
