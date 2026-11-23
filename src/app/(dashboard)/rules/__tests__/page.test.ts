import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createTranslator } from 'next-intl'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import { createQueuedMockSupabase } from '@/tests/helpers'

// /rules with and without the agent picture (AGENT_PICTURE_COMPANY_IDS).
// With it, one sentence above the list says how the company books; without
// it the page is the list and the blocks alone, and reads nothing for the
// sentence.

const COMPANY = 'aaaaaaaa-0000-4000-8000-000000000001'
const state = vi.hoisted(() => ({ locale: 'sv' as 'sv' | 'en', companyId: null as string | null }))
const mock = createQueuedMockSupabase()
const getDashboardAuthContext = vi.fn(async () => ({ supabase: mock.supabase, user: { id: 'user-1' }, sessionId: null }))
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
vi.mock('../../request-context', () => ({
  getDashboardCompanyId: async () => state.companyId,
  getDashboardAuthContext: () => getDashboardAuthContext(),
  redirectInvoicerOffPage: () => redirectInvoicerOffPage(),
}))

const { default: RulesPage } = await import('../page')
const { default: RulesList } = await import('@/components/rules/RulesList')
const { default: BookingBlocks } = await import('@/components/rules/BookingBlocks')

/** Every element of a tree that was built but not rendered, in order. */
function elements(node: ReactNode): ReactElement<{ children?: ReactNode; className?: string }>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement<{ children?: ReactNode; className?: string }>(node)) return []
  return [node, ...elements(node.props.children)]
}

/** The page as its parts: the sentences in it, and what follows the top bar. */
async function page() {
  const all = elements(await RulesPage())
  return {
    sentences: all.filter((el) => el.type === 'p').map((el) => el.props.children),
    sentenceClass: all.find((el) => el.type === 'p')?.props.className,
    order: all.filter((el) => el.type === 'p' || el.type === RulesList || el.type === BookingBlocks).map((el) => (el.type === 'p' ? 'sentence' : el.type === RulesList ? 'rules' : 'blocks')),
    headings: all.filter((el) => typeof el.type === 'string' && /^h[1-6]$/.test(el.type)).length,
  }
}

function settings(row: unknown, series: string[]) {
  mock.enqueue({ data: row })
  mock.enqueue({ data: series.map((voucher_series) => ({ voucher_series })) })
}

beforeEach(() => {
  vi.clearAllMocks()
  mock.reset()
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

  it('reads nothing for the sentence', async () => {
    await page()
    expect(getDashboardAuthContext).not.toHaveBeenCalled()
    expect(redirectInvoicerOffPage).not.toHaveBeenCalled()
    expect(mock.supabase.from).not.toHaveBeenCalled()
  })

  it('keeps the list and the blocks as the two children of the page root', async () => {
    const root = elements(await RulesPage()).find((el) => el.type === 'div' && el.props.className === 'space-y-8')
    const children = (root?.props.children as ReactElement[]).map((child) => child.type)
    expect(children).toEqual([RulesList, BookingBlocks])
  })
})
