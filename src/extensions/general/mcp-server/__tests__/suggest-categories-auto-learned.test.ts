/**
 * gnubok_suggest_categories: the `suggestions` hints read the company's
 * mapping rows through mappingRulesRead. With BOOKING_PRECEDENT_COMPANY_IDS
 * off an auto-learned row ("Learned: <merchant>") is a hint as before; on, it
 * is left out, and a row a person described is still one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase, makeTransaction } from '@/tests/helpers'

const { proposeMock, counterparts, switchedOff } = vi.hoisted(() => ({ proposeMock: vi.fn(), counterparts: vi.fn(), switchedOff: vi.fn() }))
vi.mock('@/lib/transactions/propose', () => ({
  proposeForTransactions: (...args: unknown[]) => proposeMock(...args),
}))
vi.mock('@/lib/bookkeeping/counterparty-templates', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/bookkeeping/counterparty-templates')>()),
  findCounterpartyTemplatesBatch: counterparts,
  readSwitchedOffRulesByName: switchedOff,
}))
vi.mock('@/lib/transactions/salary-run-payouts', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/transactions/salary-run-payouts')>()),
  findSalaryRunPayouts: vi.fn().mockResolvedValue({ links: new Map(), without_run: new Set() }),
}))

import { tools } from '../server'

const suggest = tools.find((t) => t.name === 'gnubok_suggest_categories')!
const COMPANY = 'company-1'

// A text no keyword pattern knows, so only the rules decide.
const row = makeTransaction({ id: 'tx-1', amount: -1200, description: 'Zqxw Vrpt', original_description: 'Zqxw Vrpt', merchant_name: 'Zqxw Vrpt' })

const rule = (overrides: Record<string, unknown>) => ({
  id: 'rule-learned',
  company_id: COMPANY,
  rule_name: 'Learned: Zqxw Vrpt',
  priority: 10,
  mcc_codes: null,
  merchant_pattern: 'Zqxw Vrpt',
  description_pattern: null,
  debit_account: '5410',
  credit_account: '1930',
  default_private: false,
  requires_review: false,
  confidence_score: 0.95,
  is_active: true,
  source: 'auto',
  user_description: null,
  template_id: null,
  created_at: '2026-01-01T00:00:00Z',
  ...overrides,
})
const learned = () => rule({})
const described = () =>
  rule({ id: 'rule-described', rule_name: 'Described: Zqxw Vrpt', priority: 5, debit_account: '6200', confidence_score: 0.98, source: 'user_description', user_description: 'telefoni' })

type Suggestion = { category: string; account: string | null; source: string }

/** paused: the names of the counterparty rules the company switched off (money out, as the learned row), or a failed read of them. */
async function hints(rules: unknown[], paused: string[] | 'read fails' = []): Promise<Suggestion[]> {
  counterparts.mockResolvedValue(new Map())
  if (paused === 'read fails') switchedOff.mockRejectedValue(new Error('read failed'))
  else
    switchedOff.mockResolvedValue(
      new Map(paused.map((name) => [name, [{ debit_account: '5410', credit_account: '1930' }]])),
    )
  proposeMock.mockResolvedValue({ proposals: {}, assistant_reads: {}, direct_booking: { enabled: true } })
  const { supabase, enqueue } = createQueuedMockSupabase()
  enqueue({ data: [row], error: null }) // transactions
  enqueue({ data: rules, error: null }) // mapping rules
  enqueue({ data: [], error: null }) // categorized history
  enqueue({ data: { entity_type: 'aktiebolag' }, error: null }) // companies
  const out = (await suggest.execute({ transaction_ids: ['tx-1'] }, COMPANY, 'user-1', supabase as never)) as {
    suggestions: Record<string, Suggestion[]>
  }
  return out.suggestions['tx-1'] ?? []
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('gnubok_suggest_categories: auto-learned mapping rows in suggestions', () => {
  it('switch off: the auto-learned row is a hint, as before', async () => {
    expect(await hints([learned()])).toEqual([
      expect.objectContaining({ source: 'mapping_rule', account: '5410', category: 'expense_equipment' }),
    ])
  })

  it('switch on: the auto-learned row is left out', async () => {
    vi.stubEnv('BOOKING_PRECEDENT_COMPANY_IDS', COMPANY)
    expect(await hints([learned()])).toEqual([])
  })

  it('switch on: a described row is still a hint', async () => {
    vi.stubEnv('BOOKING_PRECEDENT_COMPANY_IDS', COMPANY)
    expect(await hints([learned(), described()])).toEqual([
      expect.objectContaining({ source: 'mapping_rule', account: '6200', category: 'expense_telecom' }),
    ])
  })
})

describe('gnubok_suggest_categories: a counterparty rule the company paused', () => {
  it('silences the auto-learned row its merchant names', async () => {
    expect(await hints([learned()], ['zqxw vrpt'])).toEqual([])
  })

  it('a paused rule of another counterparty silences nothing', async () => {
    expect(await hints([learned()], ['zqxw'])).toEqual([expect.objectContaining({ source: 'mapping_rule', account: '5410' })])
  })

  it('leaves a described row a hint', async () => {
    expect(await hints([learned(), described()], ['zqxw vrpt'])).toEqual([
      expect.objectContaining({ source: 'mapping_rule', account: '6200', category: 'expense_telecom' }),
    ])
  })

  it('a failed read leaves the auto-learned row a hint, as stored', async () => {
    expect(await hints([learned()], 'read fails')).toEqual([expect.objectContaining({ source: 'mapping_rule', account: '5410' })])
  })
})
