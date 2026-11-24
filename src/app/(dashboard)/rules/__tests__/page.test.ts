import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createTranslator } from 'next-intl'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import { createQueuedMockSupabase, createRowsMockSupabase } from '@/tests/helpers'

// /rules with and without the agent picture (AGENT_PICTURE_COMPANY_IDS).
// With it, one sentence above the list says how the company books, and the
// rules the company set itself are listed under the list when it has any,
// never a row a booking learned; without it the page is the list and the
// blocks alone, and reads nothing for either.

const COMPANY = 'aaaaaaaa-0000-4000-8000-000000000001'
const state = vi.hoisted(() => ({ locale: 'sv' as 'sv' | 'en', companyId: null as string | null }))
const mock = createQueuedMockSupabase()
/** A client that answers from tables, for the tests that seed rows; null: the queue of answers above. */
const tables: { client: unknown } = { client: null }
const getDashboardAuthContext = vi.fn(async () => ({ supabase: tables.client ?? mock.supabase, user: { id: 'user-1' }, sessionId: null }))
const redirectInvoicerOffPage = vi.fn(async () => {})

// The page asks for the `rules` messages alone.
const rulesSv = createTranslator({ locale: 'sv', messages: sv, namespace: 'rules' })
const rulesEn = createTranslator({ locale: 'en', messages: en, namespace: 'rules' })
vi.mock('next-intl/server', () => ({
  getLocale: async () => state.locale,
  getTranslations: async () => (state.locale === 'en' ? rulesEn : rulesSv),
}))
vi.mock('@/components/rules/RulesList', () => ({ default: () => null }))
vi.mock('@/components/rules/BookingBlocks', () => ({ default: () => null }))
vi.mock('@/components/rules/HandWrittenRules', () => ({ default: () => null }))
vi.mock('../../request-context', () => ({
  getDashboardCompanyId: async () => state.companyId,
  getDashboardAuthContext: () => getDashboardAuthContext(),
  redirectInvoicerOffPage: () => redirectInvoicerOffPage(),
}))

const { default: RulesPage } = await import('../page')
const { default: RulesList } = await import('@/components/rules/RulesList')
const { default: BookingBlocks } = await import('@/components/rules/BookingBlocks')
const { default: HandWrittenRules } = await import('@/components/rules/HandWrittenRules')

/** Every element of a tree that was built but not rendered, in order. */
function elements(node: ReactNode): ReactElement<{ children?: ReactNode; className?: string; rules?: unknown }>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement<{ children?: ReactNode; className?: string; rules?: unknown }>(node)) return []
  return [node, ...elements(node.props.children)]
}

const PART = new Map<unknown, string>([
  ['p', 'sentence'],
  [RulesList, 'rules'],
  [HandWrittenRules, 'own rules'],
  [BookingBlocks, 'blocks'],
])

/** The page as its parts: the sentences in it, what follows the top bar, and the rules handed to the section of the company's own. */
async function page() {
  const all = elements(await RulesPage())
  return {
    sentences: all.filter((el) => el.type === 'p').map((el) => el.props.children),
    sentenceClass: all.find((el) => el.type === 'p')?.props.className,
    order: all.filter((el) => PART.has(el.type)).map((el) => PART.get(el.type)),
    headings: all.filter((el) => typeof el.type === 'string' && /^h[1-6]$/.test(el.type)).length,
    ownRules: all.find((el) => el.type === HandWrittenRules)?.props.rules,
  }
}

function settings(row: unknown, series: string[]) {
  mock.enqueue({ data: row })
  mock.enqueue({ data: series.map((voucher_series) => ({ voucher_series })) })
}

/** A mapping_rules row as the profile's read selects it. */
const mappingRule = (rule_name: string, merchant_pattern: string | null, debit_account: string | null, vat_treatment: string | null = null, description_pattern: string | null = null) => ({
  rule_name,
  merchant_pattern,
  description_pattern,
  debit_account,
  vat_treatment,
})

/** The page's three reads, in the order it makes them: the settings, the series, the company's own rules. */
function reads(rules: { data?: unknown; error?: unknown }) {
  settings({ vat_registered: true, moms_period: 'yearly', accounting_method: 'accrual' }, ['A'])
  mock.enqueue(rules)
}

beforeEach(() => {
  vi.clearAllMocks()
  mock.reset()
  tables.client = null
  state.locale = 'sv'
  state.companyId = COMPANY
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('/rules with the agent picture on', () => {
  beforeEach(() => {
    vi.stubEnv('AGENT_PICTURE_COMPANY_IDS', COMPANY)
  })

  it('says how the company books in one quiet sentence above the list, in Swedish', async () => {
    settings({ vat_registered: true, moms_period: 'yearly', accounting_method: 'accrual' }, ['A'])
    const shown = await page()
    expect(shown.sentences).toEqual(['Företaget bokför med fakturametoden, redovisar moms årsvis och använder serie A.'])
    expect(shown.order).toEqual(['sentence', 'rules', 'blocks'])
    // Plain text in the lowest text tier: no heading, no card, no icon.
    expect(shown.sentenceClass).toBe('text-sm text-muted-foreground')
    expect(shown.headings).toBe(0)
  })

  it('says it in English for an English reader', async () => {
    state.locale = 'en'
    settings({ vat_registered: true, moms_period: 'quarterly', accounting_method: 'cash' }, ['A', 'B'])
    expect((await page()).sentences).toEqual(['The company books with the cash method, reports VAT quarterly and uses series A and B.'])
  })

  it('leaves out a part the company has no value for', async () => {
    settings({ vat_registered: false, moms_period: 'quarterly', accounting_method: 'accrual' }, ['A'])
    expect((await page()).sentences).toEqual(['Företaget bokför med fakturametoden och använder serie A.'])
    settings({ vat_registered: true, moms_period: 'monthly', accounting_method: 'accrual' }, [])
    expect((await page()).sentences).toEqual(['Företaget bokför med fakturametoden och redovisar moms månadsvis.'])
  })

  it('has no sentence when the company has none of the parts: the page is as without the picture', async () => {
    settings(null, [])
    const shown = await page()
    expect(shown.sentences).toEqual([])
    expect(shown.order).toEqual(['rules', 'blocks'])
  })

  it('has no sentence without an active company, and reads nothing', async () => {
    state.companyId = null
    expect((await page()).sentences).toEqual([])
    expect(getDashboardAuthContext).not.toHaveBeenCalled()
  })

  it('sends the invoicing-only role away before it reads, as the pages with their own reads do', async () => {
    redirectInvoicerOffPage.mockRejectedValueOnce(new Error('NEXT_REDIRECT:/invoices'))
    await expect(RulesPage()).rejects.toThrow('NEXT_REDIRECT:/invoices')
    expect(mock.supabase.from).not.toHaveBeenCalled()
  })

  it('lists the rules the company set itself under the list, each as the bookkeeping profile gives an explicit rule', async () => {
    reads({
      data: [
        mappingRule('Hyra', 'FASTIGHETS AB', '5010', 'exempt'),
        mappingRule('Bankavgift', null, '6570', null, 'MÅNADSAVGIFT'),
        // A text that names no one is never applied, and a rule that matches nothing says nothing: neither is listed.
        mappingRule('Insättning', 'INSÄTTNING', '1930'),
        mappingRule('Tom', null, '6990'),
      ],
    })
    const shown = await page()
    expect(shown.order).toEqual(['sentence', 'rules', 'own rules', 'blocks'])
    expect(shown.ownRules).toEqual([
      { rule_name: 'Hyra', match: 'FASTIGHETS AB', account_number: '5010', vat_treatment: 'exempt', source: 'mapping_rule' },
      { rule_name: 'Bankavgift', match: 'MÅNADSAVGIFT', account_number: '6570', vat_treatment: null, source: 'mapping_rule' },
    ])
  })

  it("reads them through the caller's own client, for the active company: the active ones, without the rows a booking learned", async () => {
    reads({ data: [mappingRule('Hyra', 'FASTIGHETS AB', '5010')] })
    await page()
    expect(mock.supabase.from.mock.calls.map(([table]) => table)).toEqual(['company_settings', 'voucher_sequences', 'mapping_rules'])
    expect(mock.findCalls('mapping_rules', 'eq')).toEqual([
      ['company_id', COMPANY],
      ['is_active', true],
    ])
    expect(mock.findCalls('mapping_rules', 'neq')).toEqual([['source', 'auto']])
  })

  describe.each([
    ['outside the precedent switch', undefined],
    ['inside the precedent switch', COMPANY],
  ] as const)('the rows a booking learned, %s', (_name, precedent) => {
    /** A mapping_rules row as the table holds it: `source` says who wrote it, a booking ('auto') or a person ('user_description'). */
    const stored = (rule_name: string, source: 'auto' | 'user_description', priority: number, over: Record<string, unknown> = {}) => ({
      company_id: COMPANY,
      is_active: true,
      source,
      priority,
      ...mappingRule(rule_name, `${rule_name.split(': ')[1].toUpperCase()} AB`, '5010'),
      ...over,
    })
    const LEARNED = [stored('Learned: Telia', 'auto', 8), stored('Learned: Ica', 'auto', 9)]
    const WRITTEN = [stored('Described: Hyresvärden', 'user_description', 3), stored('Described: Banken', 'user_description', 5, { debit_account: '6570' })]

    /** The page over tables whose rows the page's own filters run over, as the database runs them. */
    async function pageOver(mappingRules: Record<string, unknown>[]) {
      tables.client = createRowsMockSupabase({
        company_settings: [{ company_id: COMPANY, vat_registered: true, moms_period: 'yearly', accounting_method: 'accrual' }],
        voucher_sequences: [{ company_id: COMPANY, voucher_series: 'A' }],
        mapping_rules: mappingRules,
      }).supabase
      return page()
    }
    const names = (rules: unknown) => (rules as Array<{ rule_name: string }>).map((rule) => rule.rule_name)

    beforeEach(() => {
      if (precedent) vi.stubEnv('BOOKING_PRECEDENT_COMPANY_IDS', precedent)
    })

    it('are no section: a company with only learned rows has the list and the blocks alone', async () => {
      const shown = await pageOver(LEARNED)
      expect(shown.order).toEqual(['sentence', 'rules', 'blocks'])
      expect(shown.ownRules).toBeUndefined()
    })

    it('are left out of the section: a company with both is shown only the rules a person wrote', async () => {
      const shown = await pageOver([...LEARNED, ...WRITTEN])
      expect(shown.order).toEqual(['sentence', 'rules', 'own rules', 'blocks'])
      expect(names(shown.ownRules)).toEqual(['Described: Hyresvärden', 'Described: Banken'])
      expect(shown.ownRules).toEqual([
        { rule_name: 'Described: Hyresvärden', match: 'HYRESVÄRDEN AB', account_number: '5010', vat_treatment: null, source: 'mapping_rule' },
        { rule_name: 'Described: Banken', match: 'BANKEN AB', account_number: '6570', vat_treatment: null, source: 'mapping_rule' },
      ])
    })

    it("leave another company's rules and a rule that is switched off out too", async () => {
      const shown = await pageOver([
        ...WRITTEN,
        stored('Described: Grannen', 'user_description', 1, { company_id: 'bbbbbbbb-0000-4000-8000-000000000002' }),
        stored('Described: Avslutad', 'user_description', 2, { is_active: false }),
      ])
      expect(names(shown.ownRules)).toEqual(['Described: Hyresvärden', 'Described: Banken'])
    })
  })

  it('has no such section for a company with none: the root holds the list and the blocks alone', async () => {
    for (const rules of [{ data: [] }, { data: null }, { data: [mappingRule('Insättning', 'INSÄTTNING', '1930')] }]) {
      reads(rules)
      const shown = await page()
      expect(shown.order, JSON.stringify(rules)).toEqual(['sentence', 'rules', 'blocks'])
      expect(shown.ownRules).toBeUndefined()
    }
  })

  it('has the section without the sentence when the company has rules and none of the sentence\'s parts', async () => {
    settings(null, [])
    mock.enqueue({ data: [mappingRule('Hyra', 'FASTIGHETS AB', '5010')] })
    expect((await page()).order).toEqual(['rules', 'own rules', 'blocks'])
  })

  it('leaves the section out when the rules cannot be read: the rest of the page stands', async () => {
    reads({ data: null, error: { message: 'permission denied' } })
    const shown = await page()
    expect(shown.order).toEqual(['sentence', 'rules', 'blocks'])
    expect(shown.sentences).toEqual(['Företaget bokför med fakturametoden, redovisar moms årsvis och använder serie A.'])
  })
})

describe.each([
  ['unset', undefined],
  ['naming another company', 'another-company'],
])('/rules with the agent picture %s: as before', (_name, picture) => {
  beforeEach(() => {
    if (picture !== undefined) vi.stubEnv('AGENT_PICTURE_COMPANY_IDS', picture)
  })

  it('is the list and the blocks, with no sentence', async () => {
    const shown = await page()
    expect(shown.sentences).toEqual([])
    expect(shown.order).toEqual(['rules', 'blocks'])
  })

  it('reads nothing for the sentence or for the company\'s own rules', async () => {
    await page()
    expect(getDashboardAuthContext).not.toHaveBeenCalled()
    expect(redirectInvoicerOffPage).not.toHaveBeenCalled()
    expect(mock.supabase.from).not.toHaveBeenCalled()
  })

  it('has no section of the company\'s own rules, whatever rules it has', async () => {
    // A rule waiting in the queue is never asked for.
    mock.enqueue({ data: [mappingRule('Hyra', 'FASTIGHETS AB', '5010')] })
    const shown = await page()
    expect(shown.order).toEqual(['rules', 'blocks'])
    expect(shown.ownRules).toBeUndefined()
  })

  it('keeps the list and the blocks as the two children of the page root', async () => {
    const root = elements(await RulesPage()).find((el) => el.type === 'div' && el.props.className === 'space-y-8')
    const children = (root?.props.children as ReactElement[]).map((child) => child.type)
    expect(children).toEqual([RulesList, BookingBlocks])
  })
})
