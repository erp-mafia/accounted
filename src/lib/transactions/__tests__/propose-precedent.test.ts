/**
 * proposeForTransactions and the company's own earlier booking of a
 * counterparty (source 'precedent', ../booking-precedent.ts), under
 * BOOKING_PRECEDENT_COMPANY_IDS.
 *
 * Off: the proposals, their order, what the log records and the one-click
 * decision are what they were, and neither the precedent read nor the read
 * of switched-off rules by the row is made (only their names, for the
 * learned rows: propose-auto-learned.test.ts).
 *
 * On: the precedent leads the row exactly when no counterparty rule matches
 * it (active or switched off), no rule of the company's own proposes for it
 * and the books hold an earlier booking that says one account; it never
 * books by one click; its count is logged. Which stored rows are an earlier
 * booking at all (posted, not a storno, inside the window, the company's own)
 * is the database's answer, pinned in tests/pg/booking-precedents.pg.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase, makeCategorizationTemplate, makeTransaction } from '@/tests/helpers'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CounterpartyTemplateMatch } from '@/lib/bookkeeping/counterparty-templates'
import { accountProposal, type BookingProposal } from '@/lib/bookkeeping/proposal'
import type { PrecedentBooking, PrecedentLine } from '../booking-precedent'

const { counterparts, clearingPropose } = vi.hoisted(() => ({ counterparts: vi.fn(), clearingPropose: vi.fn() }))
vi.mock('@/lib/bookkeeping/counterparty-templates', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/bookkeeping/counterparty-templates')>()),
  findCounterpartyTemplatesBatch: counterparts,
}))
vi.mock('@/lib/composition/clearing-proposals', () => ({
  CLEARING_PROPOSERS: [{ id: 'fake', module: 'pos', propose: clearingPropose }],
}))

import { proposeForTransactions } from '../propose'
import { rowProposal } from '../category-suggestions'
import { DIRECT_BOOKING_ON, reviewReason, reviewRequired } from '../direct-booking'
import { offeredSuggestions } from '@/lib/suggestion-log/classify'
import { evaluateMappingRules } from '@/lib/bookkeeping/mapping-engine'
import { candidateFromProposal } from '@/lib/agent/categorize/candidates'

const COMPANY = 'company-1'

const bankRow = (id: string, text: string, over: Record<string, unknown> = {}) =>
  makeTransaction({ id, amount: -500, merchant_name: text, description: text, original_description: text, document_id: null, ...over })

const nordverk = bankRow('tx-nordverk', 'Nordverk')

const line = (account: string, debit: number, credit: number): PrecedentLine => ({ account, debit, credit })
let seq = 0
function earlier(lines: PrecedentLine[], over: Partial<PrecedentBooking> = {}): PrecedentBooking {
  seq += 1
  return { transaction_id: `earlier-${seq}`, date: '2026-06-01', amount: -500, journal_entry_id: `entry-${seq}`, settlement_ledger: null, lines, ...over }
}
const software = () => earlier([line('5420', 400, 0), line('2641', 100, 0), line('1930', 0, 500)])

function mappingRule(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rule-described',
    user_id: null,
    company_id: COMPANY,
    rule_name: 'Described: Nordverk',
    rule_type: 'merchant_name',
    priority: 5,
    mcc_codes: null,
    merchant_pattern: 'Nordverk',
    description_pattern: null,
    amount_min: null,
    amount_max: null,
    debit_account: '6110',
    credit_account: '1930',
    vat_treatment: null,
    vat_debit_account: null,
    vat_credit_account: null,
    risk_level: 'NONE',
    default_private: false,
    requires_review: false,
    confidence_score: 0.98,
    capitalization_threshold: null,
    capitalized_debit_account: null,
    is_active: true,
    source: 'user_description',
    user_description: 'kontorsmaterial',
    template_id: 'office_supplies_general',
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    ...overrides,
  }
}
const described = () => mappingRule()
const learned = () =>
  mappingRule({ id: 'rule-learned', rule_name: 'Learned: Nordverk', priority: 10, debit_account: '5410', confidence_score: 0.95, source: 'auto', user_description: null, template_id: null })
const systemDefault = () => mappingRule({ id: 'rule-system', company_id: null, rule_name: 'System: Nordverk', priority: 80, source: 'system', user_description: null, template_id: null })

const sureRead = (transactionId: string) => ({
  company_id: COMPANY,
  transaction_id: transactionId,
  underlag_key: 'doc-1',
  has_underlag: true,
  account: '6250',
  category: 'expense_other',
  vat_treatment: 'standard_25',
  reverse_charge: false,
  reverse_charge_kind: null,
  confidence: '0.9',
  model_confidence: 'high',
  agreement: 1,
  from_candidate: false,
  reasoning: 'Porto.',
  candidates: [],
  model: 'm',
})

const rule = (name: string) =>
  makeCategorizationTemplate({ id: `tpl-${name}`, counterparty_name: name, counterparty_aliases: [name], debit_account: '6200', credit_account: '1930', occurrence_count: 5 })
const matchOf = (template: ReturnType<typeof rule>): CounterpartyTemplateMatch => ({ template, matchMethod: 'exact_normalized', confidence: 0.67 })

interface Scene {
  company?: unknown[]
  system?: unknown[]
  reads?: unknown[]
  /** Counterparty rules the company switched off. */
  switchedOff?: unknown[]
  switchedOffError?: boolean
  /** The books' answer per counterparty text. */
  booked?: Record<string, PrecedentBooking[]>
  precedentError?: boolean
}

function ledger(scene: Scene) {
  return createTableMockSupabase({
    mapping_rules: (chain) => ({
      data: chain.some((c) => c.method === 'is') ? (scene.system ?? []) : (scene.company ?? []),
      error: null,
    }),
    company_settings: { data: { entity_type: 'aktiebolag', direct_booking_enabled: true }, error: null },
    transaction_assistant_reads: { data: scene.reads ?? [], error: null },
    categorization_templates: scene.switchedOffError
      ? { data: null, error: { message: 'rls denied' } }
      : { data: scene.switchedOff ?? [], error: null },
    'rpc:booking_precedents': (chain) => {
      if (scene.precedentError) return { data: null, error: { message: 'timeout' } }
      const asked = (chain[0].args[0] as { p_names: string[] }).p_names
      const names: Record<string, string> = {}
      const bookings: Record<string, PrecedentBooking[]> = {}
      for (const text of asked) {
        names[text] = text.toLowerCase()
        if (scene.booked?.[text]) bookings[text.toLowerCase()] = scene.booked[text]
      }
      return { data: { names, bookings }, error: null }
    },
  })
}

async function propose(scene: Scene, rows = [nordverk]) {
  const mock = ledger(scene)
  const out = await proposeForTransactions(mock.supabase as unknown as SupabaseClient, COMPANY, rows)
  return { out, mock, list: out.proposals[rows[0].id] ?? [] }
}

const sources = (list: BookingProposal[]) => list.map((p) => p.source)
const asked = (mock: ReturnType<typeof ledger>) =>
  mock.findCalls('rpc:booking_precedents', 'rpc').map(([args]) => (args as { p_names: string[] }).p_names)

beforeEach(() => {
  vi.clearAllMocks()
  counterparts.mockResolvedValue(new Map<string, CounterpartyTemplateMatch>())
  clearingPropose.mockResolvedValue(new Map<string, BookingProposal>())
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('switch off: nothing changes', () => {
  const withRule = bankRow('tx-rule', 'Nordverk', { document_id: 'doc-1' })
  const withCounterpart = bankRow('tx-counterpart', 'Sydkraft')
  const bare = bankRow('tx-bare', 'Vattenverket')
  const rows = [withRule, withCounterpart, bare]
  const scene = (): Scene => ({
    company: [learned()],
    reads: [sureRead('tx-rule')],
    // The books hold earlier bookings of every row, and a rule is switched off: neither is read.
    booked: { Nordverk: [software()], Sydkraft: [software()], Vattenverket: [software()] },
    switchedOff: [rule('vattenverket')],
  })

  async function run() {
    counterparts.mockResolvedValue(new Map([['tx-counterpart', matchOf(rule('sydkraft'))]]))
    return propose(scene(), rows)
  }

  it('the proposals, their order, the logged list and the one-click decision are the ones before', async () => {
    const { out } = await run()

    expect(out.proposals['tx-rule'].map((p) => [p.source, p.template_id])).toEqual([
      ['rule', 'equipment_small'],
      ['assistant', 'assistant:tx-rule'],
    ])
    expect(out.proposals['tx-counterpart'].map((p) => [p.source, p.template_id])).toEqual([['counterparty', 'counterparty:tpl-sydkraft']])
    // No rule knows the row: the catalog's keyword match is all it has.
    expect(out.proposals['tx-bare'].map((p) => [p.source, p.template_id])).toEqual([['catalog', 'premises_electricity']])

    expect(offeredSuggestions(out.proposals['tx-rule']).suggestions.map((s) => [s.source, s.source_id, s.rank, s.evidence])).toEqual([
      ['rule', 'equipment_small', 0, { rule_own: true, rule_requires_review: false }],
      ['assistant', 'assistant:tx-rule', 1, { has_underlag: true }],
    ])
    expect(offeredSuggestions(out.proposals['tx-counterpart']).suggestions.map((s) => [s.source, s.source_id, s.evidence])).toEqual([
      ['counterparty_template', 'counterparty:tpl-sydkraft', { seen_count: 5, rule_mode: 'propose' }],
    ])

    expect(reviewReason(rowProposal(out.proposals['tx-rule'])!, DIRECT_BOOKING_ON)).toBeNull()
    expect(reviewReason(rowProposal(out.proposals['tx-counterpart'])!, DIRECT_BOOKING_ON)).toBeNull()
    expect(reviewReason(rowProposal(out.proposals['tx-bare'])!, DIRECT_BOOKING_ON)).toBe('evidence')
  })

  it('makes neither the precedent read nor the read of switched-off rules by the row', async () => {
    const { mock } = await run()
    expect(mock.supabase.rpc).not.toHaveBeenCalled()
    // Only the read by name, which the learned rows are read beside (propose-auto-learned.test.ts).
    expect(mock.findCalls('categorization_templates', 'select')).toEqual([['id, counterparty_name, counterparty_aliases, debit_account, credit_account']])
  })

  it('the switch of another company leaves this one exactly as unset', async () => {
    const unset = (await run()).out
    vi.stubEnv('BOOKING_PRECEDENT_COMPANY_IDS', 'company-2')
    const { out, mock } = await run()
    expect(out).toEqual(unset)
    expect(mock.supabase.rpc).not.toHaveBeenCalled()
  })
})

describe('switch on: the earlier booking leads where no rule proposes', () => {
  beforeEach(() => {
    vi.stubEnv('BOOKING_PRECEDENT_COMPANY_IDS', COMPANY)
  })

  it('is the first proposal: the account and moms of the most recent booking, with the count that agree', async () => {
    const { list, mock } = await propose({ booked: { Nordverk: [software(), software(), earlier([line('6110', 500, 0), line('1930', 0, 500)])] } })

    expect(list).toHaveLength(1)
    expect(list[0]).toEqual({
      ...accountProposal({
        id: 'precedent:5420',
        source: 'precedent',
        account: '5420',
        label: 'Programvaror',
        category: 'expense_software',
        vat_treatment: 'standard_25',
        amount: -500,
        confidence: 0.54,
        description: 'Som förra gången: bokförd så 2 gånger tidigare',
      }),
      requires_review: true,
      seen_count: 2,
    })
    expect(asked(mock)).toEqual([['Nordverk']])
  })

  it('never books by one click, and the log records its count', async () => {
    const many = Array.from({ length: 20 }, software)
    const { list } = await propose({ booked: { Nordverk: many } })

    expect(rowProposal(list)?.source).toBe('precedent')
    expect(list[0].seen_count).toBe(20)
    expect(reviewReason(list[0], DIRECT_BOOKING_ON)).toBe('evidence')
    // What the MCP suggestion tool answers as books_without_review.
    expect(!reviewRequired(list[0], DIRECT_BOOKING_ON)).toBe(false)
    expect(offeredSuggestions(list).suggestions.map((s) => [s.source, s.source_id, s.rank, s.evidence])).toEqual([
      ['precedent', 'precedent:5420', 0, { seen_count: 20 }],
    ])
    // The assistant's candidate slate takes it as the counterparty's history.
    expect(candidateFromProposal(list[0])).toMatchObject({ account: '5420', vatTreatment: 'standard_25', source: 'history' })
  })

  it('stands ahead of a system default, a sure read of the receipt and the catalog, so the row opens a review', async () => {
    const withReceipt = bankRow('tx-nordverk', 'Nordverk', { document_id: 'doc-1' })
    const { list } = await propose(
      { system: [systemDefault()], reads: [sureRead('tx-nordverk')], booked: { Nordverk: [software()] } },
      [withReceipt],
    )
    expect(list.map((p) => [p.source, p.template_id])).toEqual([
      ['precedent', 'precedent:5420'],
      ['rule', 'office_supplies_general'],
      ['assistant', 'assistant:tx-nordverk'],
    ])
    expect(reviewReason(rowProposal(list)!, DIRECT_BOOKING_ON)).toBe('evidence')
    // The read is not marked: no auto-learned row stood on this row.
    expect(list[2].replaces_learned_rule).toBeUndefined()
  })

  it('stands where an auto-learned mapping row stood, and the read below it is marked', async () => {
    const withReceipt = bankRow('tx-nordverk', 'Nordverk', { document_id: 'doc-1' })
    const { list } = await propose(
      { company: [learned()], reads: [sureRead('tx-nordverk')], booked: { Nordverk: [software()] } },
      [withReceipt],
    )
    expect(sources(list)).toEqual(['precedent', 'assistant'])
    expect(list[1].replaces_learned_rule).toBe(true)
    expect(list.every((p) => reviewReason(p, DIRECT_BOOKING_ON) === 'evidence')).toBe(true)
  })

  it('passes over a payment that settled a supplier invoice and takes the next older ordinary booking', async () => {
    const paidInvoice = earlier([line('2440', 500, 0), line('1930', 0, 500)])
    const { list } = await propose({ booked: { Nordverk: [paidInvoice, software()] } })
    expect(list.map((p) => [p.source, p.template_id, p.seen_count])).toEqual([['precedent', 'precedent:5420', 1]])
  })

  it('passes over a payment that settled a customer invoice and takes the next older ordinary booking', async () => {
    const payment = bankRow('tx-nordverk', 'Nordverk', { amount: 500 })
    const paidInvoice = earlier([line('1930', 500, 0), line('1510', 0, 500)], { amount: 500 })
    const sale = earlier([line('1930', 500, 0), line('3001', 0, 400), line('2611', 0, 100)], { amount: 500 })
    const { list } = await propose({ booked: { Nordverk: [paidInvoice, sale] } }, [payment])
    expect(list.map((p) => [p.source, p.template_id, p.seen_count])).toEqual([['precedent', 'precedent:3001', 1]])
  })

  it('a clearing proposal still leads above it', async () => {
    // Money in: the rows a clearing proposer is asked about.
    const payout = bankRow('tx-nordverk', 'Nordverk', { amount: 500 })
    const sale = earlier([line('1930', 500, 0), line('3001', 0, 400), line('2611', 0, 100)], { amount: 500 })
    const clearing: BookingProposal = {
      ...accountProposal({ id: 'clearing:pos:card', source: 'clearing', account: '1686', label: 'Kort från kassan', category: 'income_other', vat_treatment: 'exempt', amount: 500, confidence: 0.9 }),
      requires_review: true,
    }
    clearingPropose.mockResolvedValue(new Map([['tx-nordverk', clearing]]))
    const { list } = await propose({ booked: { Nordverk: [sale] } }, [payout])
    expect(list.map((p) => [p.source, p.template_id])).toEqual([
      ['clearing', 'clearing:pos:card'],
      ['precedent', 'precedent:3001'],
    ])
  })

  it('asks the books once for all the rows, and only about rows no rule answers', async () => {
    const sydkraft = bankRow('tx-sydkraft', 'Sydkraft')
    const vatten = bankRow('tx-vatten', 'Vattenverket')
    const again = bankRow('tx-nordverk-2', 'Nordverk')
    counterparts.mockResolvedValue(new Map([['tx-sydkraft', matchOf(rule('sydkraft'))]]))
    const { out, mock } = await propose(
      { booked: { Nordverk: [software()], Sydkraft: [software()], Vattenverket: [earlier([line('5020', 500, 0), line('1930', 0, 500)])] } },
      [nordverk, sydkraft, vatten, again],
    )

    expect(asked(mock)).toEqual([['Nordverk', 'Vattenverket']])
    expect(sources(out.proposals['tx-nordverk'])).toEqual(['precedent'])
    expect(sources(out.proposals['tx-nordverk-2'])).toEqual(['precedent'])
    expect(out.proposals['tx-vatten'][0]).toMatchObject({ source: 'precedent', template_id: 'precedent:5020', vat_treatment: 'exempt' })
    expect(sources(out.proposals['tx-sydkraft'])).toEqual(['counterparty'])
  })
})

describe('switch on: never otherwise', () => {
  beforeEach(() => {
    vi.stubEnv('BOOKING_PRECEDENT_COMPANY_IDS', COMPANY)
  })

  const booked = () => ({ Nordverk: [software(), software()] })

  it('a counterparty rule matches the row: the rule proposes, the books are not asked', async () => {
    counterparts.mockResolvedValue(new Map([['tx-nordverk', matchOf(rule('nordverk'))]]))
    const { list, mock } = await propose({ booked: booked() })
    expect(sources(list)).toEqual(['counterparty'])
    expect(mock.supabase.rpc).not.toHaveBeenCalled()
  })

  it.each([
    ['paused', { mode: 'paused', is_active: false, paused_at: '2026-10-01T00:00:00Z' }],
    ['switched off', { mode: 'paused', is_active: false, occurrence_count: 1 }],
  ] as const)('the counterparty rule is %s: it silences the precedent too', async (_label, state) => {
    const off = makeCategorizationTemplate({ counterparty_name: 'nordverk', counterparty_aliases: ['nordverk'], ...state })
    const { list, mock } = await propose({ switchedOff: [off], booked: booked() })
    expect(list).toEqual([])
    expect(mock.supabase.rpc).not.toHaveBeenCalled()
    // Read by its own filter: the company's rules that are not active.
    expect(mock.findCalls('categorization_templates', 'eq')).toEqual([['company_id', COMPANY], ['is_active', false]])
  })

  it('a switched-off rule of another counterparty silences nothing', async () => {
    const off = makeCategorizationTemplate({ counterparty_name: 'sydkraft', counterparty_aliases: ['sydkraft'], mode: 'paused', is_active: false })
    const { list } = await propose({ switchedOff: [off], booked: booked() })
    expect(sources(list)).toEqual(['precedent'])
  })

  it('the books hold no earlier booking of the counterparty (none, a storno only, or older than the window)', async () => {
    const { list, mock } = await propose({ booked: {} })
    expect(list).toEqual([])
    expect(asked(mock)).toEqual([['Nordverk']])
  })

  it('the only booking is the row itself', async () => {
    const { list } = await propose({ booked: { Nordverk: [earlier([line('5420', 500, 0), line('1930', 0, 500)], { transaction_id: 'tx-nordverk' })] } })
    expect(list).toEqual([])
  })

  it('the text names no counterparty: the books are not asked', async () => {
    const nameless = bankRow('tx-nameless', 'INTERNET BET 4', { merchant_name: null })
    const { out, mock } = await propose({ booked: { 'INTERNET BET 4': [software()] } }, [nameless])
    expect(sources(out.proposals['tx-nameless'] ?? [])).not.toContain('precedent')
    expect(mock.supabase.rpc).not.toHaveBeenCalled()
  })

  it.each([
    ['a supplier invoice', [line('2440', 500, 0), line('1930', 0, 500)], -500],
    ['a customer invoice', [line('1930', 500, 0), line('1510', 0, 500)], 500],
  ] as const)('the only earlier booking settled %s', async (_label, lines, amount) => {
    const open = bankRow('tx-nordverk', 'Nordverk', { amount })
    const { list } = await propose({ booked: { Nordverk: [earlier([...lines], { amount })] } }, [open])
    expect(list).toEqual([])
  })

  it('the earlier booking carries several business accounts', async () => {
    const split = earlier([line('5420', 300, 0), line('6110', 200, 0), line('1930', 0, 500)])
    const { list } = await propose({ booked: { Nordverk: [split] } })
    expect(list).toEqual([])
  })

  it('a rule a person described proposes for the row: it leads and books by one click, as before', async () => {
    const { list, mock } = await propose({ company: [described()], booked: booked() })
    expect(list.map((p) => [p.source, p.template_id])).toEqual([['rule', 'office_supplies_general']])
    expect(reviewReason(rowProposal(list)!, DIRECT_BOOKING_ON)).toBeNull()
    expect(mock.supabase.rpc).not.toHaveBeenCalled()
  })

  it('a payment to Skatteverket leads with the skattekonto and gets no precedent', async () => {
    const tax = bankRow('tx-tax', 'Skatteverket', { amount: -12000 })
    const { out, mock } = await propose({ booked: { Skatteverket: [earlier([line('5890', 12000, 0), line('1930', 0, 12000)], { amount: -12000 })] } }, [tax])
    expect(out.proposals['tx-tax'][0]).toMatchObject({ source: 'catalog', template_id: 'financial_tax_account' })
    expect(sources(out.proposals['tx-tax'])).not.toContain('precedent')
    expect(mock.supabase.rpc).not.toHaveBeenCalled()
  })

  it('a failed read of the books leaves the list as it is without them', async () => {
    const { list } = await propose({ system: [systemDefault()], precedentError: true })
    expect(sources(list)).toEqual(['rule'])
  })

  it('a failed read of the switched-off rules offers no precedent at all', async () => {
    const { list, mock } = await propose({ switchedOffError: true, booked: booked() })
    expect(list).toEqual([])
    expect(mock.supabase.rpc).not.toHaveBeenCalled()
  })
})

describe('a row with a described rule, a counterparty rule and an earlier booking: both engines', () => {
  const template = makeCategorizationTemplate({
    id: 'tpl-nordverk',
    counterparty_name: 'nordverk',
    counterparty_aliases: ['nordverk'],
    debit_account: '6200',
    credit_account: '1930',
    vat_treatment: null,
    occurrence_count: 5,
    confidence: 0.9,
    source: 'user_approved',
  })

  /** Both engines read the same stores: the described rule, the counterparty rule, the books. */
  function stores() {
    return createTableMockSupabase({
      mapping_rules: (chain) => ({ data: chain.some((c) => c.method === 'is') ? [] : [described(), learned()], error: null }),
      company_settings: { data: { entity_type: 'aktiebolag', direct_booking_enabled: true }, error: null },
      transaction_assistant_reads: { data: [], error: null },
      categorization_templates: (chain) => ({
        data: chain.some((c) => c.method === 'eq' && c.args[0] === 'is_active' && c.args[1] === false) ? [] : [template],
        error: null,
      }),
      'rpc:booking_precedents': { data: { names: { Nordverk: 'nordverk' }, bookings: { nordverk: [software()] } }, error: null },
    })
  }

  it.each([
    ['off', ''],
    ['on', COMPANY],
  ])(
    'switch %s: the proposals lead with the counterparty rule and then the described rule; evaluateMappingRules answers the described rule; neither takes the earlier booking',
    async (_label, value) => {
      vi.stubEnv('BOOKING_PRECEDENT_COMPANY_IDS', value)
      counterparts.mockResolvedValue(new Map([['tx-nordverk', { template, matchMethod: 'exact_normalized', confidence: 0.86 }]]))

      const proposing = stores()
      const { proposals } = await proposeForTransactions(proposing.supabase as unknown as SupabaseClient, COMPANY, [nordverk])
      expect(proposals['tx-nordverk'].map((p) => [p.source, p.template_id]).slice(0, 2)).toEqual([
        ['counterparty', 'counterparty:tpl-nordverk'],
        ['rule', 'office_supplies_general'],
      ])
      expect(sources(proposals['tx-nordverk'])).not.toContain('precedent')
      expect(proposing.supabase.rpc).not.toHaveBeenCalled()

      const evaluating = stores()
      const result = await evaluateMappingRules(evaluating.supabase as unknown as SupabaseClient, COMPANY, nordverk, 'aktiebolag')
      expect(result.rule?.id).toBe('rule-described')
      expect(result.debit_account).toBe('6110')
      expect(evaluating.supabase.rpc).not.toHaveBeenCalled()
    },
  )
})
