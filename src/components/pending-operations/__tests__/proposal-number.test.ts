/**
 * The proposal's own number, as people read it, in the real components and
 * with the real messages in both languages. The number says which proposal
 * this is and never changes; the place in a walk ("3 av 12") moves as
 * proposals are approved and keeps its own words. A proposal without a
 * number (read before the column exists, or decided before numbers) shows
 * no label at all.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PendingOperation } from '@/types'

const locale = vi.hoisted(() => ({ current: 'sv' as 'sv' | 'en' }))

vi.mock('next-intl', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next-intl')>()
  const messages = {
    sv: (await import('@/messages/sv.json')).default,
    en: (await import('@/messages/en.json')).default,
  }
  return {
    ...actual,
    // The translator the app gets, strict: a missing key or a broken ICU
    // message throws instead of rendering the key path.
    useTranslations: (namespace: string) =>
      actual.createTranslator({
        locale: locale.current,
        messages: messages[locale.current] as never,
        namespace: namespace as never,
        onError: (error) => {
          throw error
        },
      }),
    useLocale: () => locale.current,
  }
})
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
// The review's buttons ask whether the viewer may write; that is the page's
// company context, which this render has none of.
vi.mock('@/components/ui/viewer-lock', () => ({ useViewerLock: () => ({ canWrite: true, lockedTitle: undefined }) }))

const { createTranslator } = await import('next-intl')
const { ProposalNumber, proposalNumberLabel } = await import('../ProposalNumber')
const { ReviewWalk } = await import('../ProposalReview')

const MESSAGES = {
  sv: (await import('@/messages/sv.json')).default,
  en: (await import('@/messages/en.json')).default,
}

/** The "pending" translator as a page gets it from next-intl, strict. */
const translator = (language: 'sv' | 'en') =>
  createTranslator({
    locale: language,
    messages: MESSAGES[language] as never,
    namespace: 'pending' as never,
    onError: (error) => {
      throw error
    },
  }) as unknown as (key: string, values?: Record<string, string>) => string

const proposal = (overrides: Partial<PendingOperation>): PendingOperation => ({
  id: 'op-1',
  user_id: 'user-1',
  company_id: 'company-1',
  operation_type: 'create_customer',
  status: 'pending',
  title: 'Skapa kund: Exempel AB',
  params: {},
  preview_data: { name: 'Exempel AB', customer_type: 'swedish_business' },
  result_data: null,
  actor_type: 'api_key',
  actor_id: null,
  actor_label: null,
  risk_level: 'low',
  agent_metadata: null,
  rejection_category: null,
  rejection_reason: null,
  created_at: '2026-11-17T08:00:00Z',
  resolved_at: null,
  updated_at: '2026-11-17T08:00:00Z',
  ...overrides,
})

beforeEach(() => {
  locale.current = 'sv'
})

describe('proposalNumberLabel', () => {
  it('reads "Förslag 128" in Swedish and "Proposal 128" in English', () => {
    expect(proposalNumberLabel({ operation_number: 128 }, translator('sv'))).toBe('Förslag 128')
    expect(proposalNumberLabel({ operation_number: 128 }, translator('en'))).toBe('Proposal 128')
  })

  it('never groups the digits: a number is a name, not an amount', () => {
    expect(proposalNumberLabel({ operation_number: 2357 }, translator('sv'))).toBe('Förslag 2357')
    expect(proposalNumberLabel({ operation_number: 12045 }, translator('en'))).toBe('Proposal 12045')
  })

  it('is null without a number, so a kicker built from parts leaves it out', () => {
    expect(proposalNumberLabel({}, translator('sv'))).toBeNull()
    expect(proposalNumberLabel({ operation_number: null }, translator('sv'))).toBeNull()
    expect(proposalNumberLabel(null, translator('sv'))).toBeNull()
    expect([proposalNumberLabel({}, translator('sv')), 'Ny kund'].filter(Boolean).join(' · ')).toBe('Ny kund')
  })
})

describe('ProposalNumber, the short form in a dense row', () => {
  const render = (op: { operation_number?: unknown }) => renderToStaticMarkup(createElement(ProposalNumber, { op }))

  it('shows "#128", quiet and tabular, with the sentence form for a hover and a screen reader', () => {
    const html = render({ operation_number: 128 })
    expect(html).toContain('<span aria-hidden="true">#128</span>')
    expect(html).toContain('<span class="sr-only">Förslag 128</span>')
    expect(html).toContain('title="Förslag 128"')
    expect(html).toContain('tabular-nums')
    expect(html).toContain('text-muted-foreground')
    // It never gives way to the title beside it.
    expect(html).toContain('shrink-0')
  })

  it('says it in English under the English locale', () => {
    locale.current = 'en'
    const html = render({ operation_number: 2357 })
    expect(html).toContain('#2357')
    expect(html).toContain('<span class="sr-only">Proposal 2357</span>')
  })

  it('renders nothing at all without a number', () => {
    expect(render({})).toBe('')
    expect(render({ operation_number: null })).toBe('')
    expect(render({ operation_number: 0 })).toBe('')
  })
})

describe('the review of one proposal (ReviewWalk)', () => {
  const walk = (ops: PendingOperation[], on: PendingOperation) =>
    renderToStaticMarkup(
      createElement(ReviewWalk, {
        groups: [{ key: 'run-1', label: 'Claude · 2026-11-17', ops }],
        op: on,
        position: { index: ops.indexOf(on), count: ops.length, previous: null, next: null },
        kicker: 'Förslag 128 · Ny kund',
        origin: null,
        retrieved: null,
        note: '',
        blocked: false,
        primary: { label: 'Godkänn', onClick: () => {} },
        onReject: () => {},
        onStep: () => {},
        remaining: ops.length,
        gone: false,
      }),
    )

  // Three proposals with one and the same title: the case the number is for.
  const alike = [128, 129, 131].map((operation_number, i) => proposal({ id: `op-${i}`, operation_number }))

  it('tells look-alike proposals apart in the queue by their numbers', () => {
    const html = walk(alike, alike[1]!)
    for (const number of [128, 129, 131]) {
      expect(html).toContain(`<span aria-hidden="true">#${number}</span>`)
      expect(html).toContain(`aria-label="Förslag ${number}, Skapa kund: Exempel AB"`)
    }
  })

  it('announces the place in the walk and the proposal\'s own number as two different things', () => {
    const html = walk(alike, alike[1]!)
    // The second of three in this walk; its number is 129 whatever is approved around it.
    expect(html).toContain('2 av 3: förslag 129, Skapa kund: Exempel AB')
    expect(html).not.toContain('Förslag 2 av 3')

    locale.current = 'en'
    expect(walk(alike, alike[2]!)).toContain('3 of 3: proposal 131, Skapa kund: Exempel AB')
  })

  it('keeps the walk as it was for a proposal without a number: no label, no "#"', () => {
    const bare = [proposal({ id: 'op-a' }), proposal({ id: 'op-b', operation_number: null })]
    const html = walk(bare, bare[0]!)
    expect(html).toContain('Förslag 1 av 2: Skapa kund: Exempel AB')
    expect(html).toContain('aria-label="Skapa kund: Exempel AB"')
    expect(html).not.toContain('#')
    expect(html).not.toContain('sr-only">Förslag')
  })
})
