/**
 * An agent card's panel: which parts it shows for what was read, in what
 * order, how many it lists, and what it says in both languages. Rendered
 * with the real message files.
 */
import { describe, expect, it } from 'vitest'
import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import type { PictureActivity, PictureAgent, PictureAgentCard } from '@/lib/agent-context/agent-picture'
import type { AgentCardWork } from '@/lib/agent-context/agent-work'
import type { QuestionOperation } from '@/lib/questions/operations'
import { AgentPanelBody } from '../AgentPanel'
import { agentPanelParts, connectedBy } from '../agent-panel-parts'

const IntlProvider = NextIntlClientProvider as (props: Omit<ComponentProps<typeof NextIntlClientProvider>, 'children'>) => ReturnType<typeof NextIntlClientProvider>

const connection = (id: string, over: Partial<PictureAgent> = {}): PictureAgent => ({
  id,
  kind: 'claude',
  name: null,
  service_account: null,
  last_used_at: null,
  calls_today: 0,
  last_call_at: null,
  connected_at: '2026-01-04T10:00:00.000Z',
  is_own: true,
  owner_name: null,
  ...over,
})
const CARD: PictureAgentCard = {
  id: 'claude',
  kind: 'claude',
  name: null,
  service_account: null,
  labels: [],
  connections: [connection('c1', { last_used_at: '2026-03-02T08:10:00.000Z' }), connection('c2', { is_own: false, owner_name: 'Anna Ek', connected_at: '2026-02-12T10:00:00.000Z' })],
}

const operation = (id: string, over: Partial<QuestionOperation> = {}): QuestionOperation => ({
  operation_id: id,
  operation_number: null,
  operation_type: 'categorize_transaction',
  title: 'ignored',
  status: 'pending',
  journal_entry_id: null,
  bank_row: { label: 'Leverantören AB', amount: -4990.5, currency: 'SEK' },
  document_name: null,
  voucher_label: null,
  ...over,
})
const question = (id: string) => ({ question_id: id, question: `Vad avser betalningen ${id}?`, asked_at: '2026-03-01T08:00:00.000Z' })

const work = (over: Partial<AgentCardWork> = {}): AgentCardWork => ({
  card: 'claude',
  questions: { waiting: [], waiting_total: 0, answered: 0 },
  proposals: { waiting: [], waiting_total: 0, approved: 0, rejected: 0 },
  ...over,
})

// Deterministic words: the picture's own are tested where they are made.
const words = { time: (instant: string) => instant.slice(11, 16), when: (instant: string) => instant.slice(0, 10) }

type BodyProps = ComponentProps<typeof AgentPanelBody>
function render(props: Partial<BodyProps> & { work: BodyProps['work'] }, locale: 'sv' | 'en' = 'sv'): string {
  return renderToStaticMarkup(
    createElement(IntlProvider, { locale, messages: locale === 'sv' ? sv : en }, createElement(AgentPanelBody, { card: CARD, calls: null, activity: null, words, ...props })),
  )
}
const ok = (data: AgentCardWork): BodyProps['work'] => ({ state: 'ok', data })

/** The parts of the panel, by their names, in the order they are drawn. */
const partsOf = (html: string): string[] => [...html.matchAll(/<section aria-label="([^"]+)"/g)].map((m) => m[1])
/** One part's markup. */
const partOf = (html: string, name: string): string => html.match(new RegExp(`<section aria-label="${name}"[\\s\\S]*?</section>`))?.[0] ?? ''
/** Every link of some markup: where it leads and what it says. */
/** The text between the tags of some markup, each tag giving way to `gap`. */
const betweenTags = (html: string, gap: string): string =>
  html
    .split('<')
    .map((part, index) => (index === 0 ? part : part.slice(part.indexOf('>') + 1)))
    .join(gap)
const linksOf = (html: string): Array<[string, string]> => [...html.matchAll(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => [m[1], betweenTags(m[2], '')])
const textOf = (html: string): string => betweenTags(html, ' ').replace(/\s+/g, ' ').trim()

describe('agentPanelParts', () => {
  it('leaves out a part with nothing in it, and says so when neither part has anything', () => {
    expect(agentPanelParts(work())).toEqual({ questions: null, proposals: null, nothing: true, questionList: true })
    expect(agentPanelParts(work({ questions: null }))).toEqual({ questions: null, proposals: null, nothing: true, questionList: false })
  })

  it('shows the questions when one waits or one was answered', () => {
    const waiting = agentPanelParts(work({ questions: { waiting: [question('q1')], waiting_total: 1, answered: 0 } }))
    expect(waiting.questions).toEqual({ waiting: [question('q1')], more: 0, answered: 0 })
    expect(waiting.nothing).toBe(false)
    const answered = agentPanelParts(work({ questions: { waiting: [], waiting_total: 0, answered: 3 } }))
    expect(answered.questions).toEqual({ waiting: [], more: 0, answered: 3 })
    expect(answered.proposals).toBeNull()
  })

  it('shows the proposals when one waits or one was approved or rejected, each as a prepared line that opens its own page', () => {
    const parts = agentPanelParts(work({ proposals: { waiting: [operation('p1'), operation('p2', { operation_type: 'create_customer', bank_row: null })], waiting_total: 2, approved: 0, rejected: 0 } }))
    expect(parts.proposals!.waiting.map((line) => [line.operation_id, line.state, line.kind, line.href])).toEqual([
      ['p1', 'prepared', 'booking', '/pending/p1'],
      ['p2', 'prepared', 'other', '/pending/p2'],
    ])
    expect(parts.questions).toBeNull()
    expect(agentPanelParts(work({ proposals: { waiting: [], waiting_total: 0, approved: 0, rejected: 1 } })).proposals).toEqual({ waiting: [], more: 0, approved: 0, rejected: 1 })
  })

  it('counts what is past the listed ones', () => {
    const questions = { waiting: Array.from({ length: 10 }, (_, i) => question(`q${i}`)), waiting_total: 14, answered: 2 }
    const proposals = { waiting: Array.from({ length: 10 }, (_, i) => operation(`p${i}`)), waiting_total: 52, approved: 0, rejected: 0 }
    const parts = agentPanelParts(work({ questions, proposals }))
    expect([parts.questions!.waiting.length, parts.questions!.more]).toEqual([10, 4])
    expect([parts.proposals!.waiting.length, parts.proposals!.more]).toEqual([10, 42])
  })
})

describe('connectedBy', () => {
  it('names the person themselves, a colleague by name, and nobody when the name is not known', () => {
    expect(connectedBy({ is_own: true, owner_name: null })).toEqual({ message: 'agent_connected_by_you' })
    expect(connectedBy({ is_own: false, owner_name: 'Anna Ek' })).toEqual({ message: 'agent_connected_by', name: 'Anna Ek' })
    expect(connectedBy({ is_own: false, owner_name: null })).toEqual({ message: 'agent_connected' })
  })
})

describe('the panel of an agent card', () => {
  const full = work({
    questions: { waiting: [question('q1'), question('q2')], waiting_total: 2, answered: 3 },
    proposals: {
      waiting: [operation('p1'), operation('p2', { operation_type: 'attach_document_to_transaction', document_name: 'kvitto.pdf' }), operation('p3', { operation_type: 'create_customer', bank_row: null })],
      waiting_total: 3,
      approved: 12,
      rejected: 1,
    },
  })
  const calls = { count: 14, last_call_at: '2026-03-02T14:32:00.000Z', capped: false }

  it('shows its parts in order: Frågor, Förslag, Läst, Anslutningar', () => {
    expect(partsOf(render({ work: ok(full), calls }))).toEqual(['Frågor', 'Förslag', 'Läst', 'Anslutningar'])
    expect(partsOf(render({ work: ok(full), calls }, 'en'))).toEqual(['Questions', 'Proposals', 'Read', 'Connections'])
  })

  it('writes each waiting question as its text, leading to the question list, then how many were answered', () => {
    const part = partOf(render({ work: ok(full) }), 'Frågor')
    expect(linksOf(part)).toEqual([
      ['/questions', 'Vad avser betalningen q1?'],
      ['/questions', 'Vad avser betalningen q2?'],
    ])
    expect(textOf(part)).toMatch(/3 besvarade$/)
    expect(textOf(partOf(render({ work: ok(full) }, 'en'), 'Questions'))).toMatch(/3 answered$/)
    expect(textOf(partOf(render({ work: ok(work({ questions: { waiting: [], waiting_total: 0, answered: 1 } })) }), 'Frågor'))).toBe('Frågor 1 besvarad')
  })

  it('writes each waiting proposal with the question list\'s own line, leading to its page, then how many were approved and rejected', () => {
    const part = partOf(render({ work: ok(full) }), 'Förslag')
    const links = linksOf(part)
    expect(links.map(([href]) => href)).toEqual(['/pending/p1', '/pending/p2', '/pending/p3'])
    // The same words the question list writes for a prepared operation (questions.operation_*).
    expect(links[0][1]).toMatch(/^Förberett: bokföring av Leverantören AB, /)
    expect(links[1][1]).toMatch(/^Förberett: kvitto\.pdf som underlag till Leverantören AB, /)
    expect(links[2][1]).toMatch(/^Förberett: /)
    expect(textOf(part)).toMatch(/12 godkända och 1 avvisat de senaste 30 dagarna$/)

    const english = partOf(render({ work: ok(full) }, 'en'), 'Proposals')
    expect(linksOf(english)[0][1]).toMatch(/^Prepared: /)
    expect(textOf(english)).toMatch(/12 approved and 1 rejected in the last 30 days$/)
  })

  it('says the approved alone, or the rejected alone, when there is only the one', () => {
    const only = (approved: number, rejected: number, locale: 'sv' | 'en' = 'sv') =>
      textOf(partOf(render({ work: ok(work({ proposals: { waiting: [], waiting_total: 0, approved, rejected } })) }, locale), locale === 'sv' ? 'Förslag' : 'Proposals'))
    expect(only(1, 0)).toBe('Förslag 1 godkänt de senaste 30 dagarna')
    expect(only(4, 0)).toBe('Förslag 4 godkända de senaste 30 dagarna')
    expect(only(0, 2)).toBe('Förslag 2 avvisade de senaste 30 dagarna')
    expect(only(4, 0, 'en')).toBe('Proposals 4 approved in the last 30 days')
    expect(only(0, 2, 'en')).toBe('Proposals 2 rejected in the last 30 days')
  })

  it('lists at most what it was given and says how many more there are, leading to where they all are', () => {
    const many = work({
      questions: { waiting: Array.from({ length: 10 }, (_, i) => question(`q${i}`)), waiting_total: 14, answered: 0 },
      proposals: { waiting: Array.from({ length: 10 }, (_, i) => operation(`p${i}`)), waiting_total: 52, approved: 0, rejected: 0 },
    })
    const html = render({ work: ok(many) })
    const questions = linksOf(partOf(html, 'Frågor'))
    expect(questions).toHaveLength(11)
    expect(questions.at(-1)).toEqual(['/questions', '+4 till'])
    const proposals = linksOf(partOf(html, 'Förslag'))
    expect(proposals).toHaveLength(11)
    expect(proposals.at(-1)).toEqual(['/pending', '+42 till'])
    expect(linksOf(partOf(render({ work: ok(many) }, 'en'), 'Proposals')).at(-1)).toEqual(['/pending', '+42 more'])
  })

  it('says in one calm line that the card asked and prepared nothing, and still shows its connections', () => {
    const html = render({ work: ok(work()) })
    expect(partsOf(html)).toEqual(['Anslutningar'])
    expect(html).toContain('Inga frågor och inga förslag just nu.')
    expect(render({ work: ok(work()) }, 'en')).toContain('No questions and no proposals right now.')
    // A company without the question list is told about proposals only.
    const noList = render({ work: ok(work({ questions: null })) })
    expect(noList).toContain('Inga förslag just nu.')
    expect(noList).not.toContain('Inga frågor')
    expect(render({ work: ok(work({ questions: null })) }, 'en')).toContain('No proposals right now.')
    // With something to show the line is not there.
    expect(render({ work: ok(full) })).not.toContain('just nu')
  })

  it('leaves the questions out for a company without the question list, whatever the card prepared', () => {
    expect(partsOf(render({ work: ok({ ...full, questions: null }), calls }))).toEqual(['Förslag', 'Läst', 'Anslutningar'])
  })

  it('says the calls of the day in one line, and leaves the part out when the card made none', () => {
    expect(textOf(partOf(render({ work: ok(work()), calls }), 'Läst'))).toBe('Läst 14 anrop i dag, senast 14:32')
    expect(textOf(partOf(render({ work: ok(work()), calls }, 'en'), 'Read'))).toBe('Read 14 calls today, last 14:32')
    expect(partsOf(render({ work: ok(work()), calls: null }))).not.toContain('Läst')
  })

  it('lists each connection with who connected it, since when and when it was last used, and leads to where they are managed', () => {
    const activity: PictureActivity = { now: '2026-03-02T09:00:00.000Z', day: '2026-03-02', actors: { c2: { calls_today: 0, last_call_at: '2026-02-28T07:00:00.000Z' } }, capped: false, memory_facts: 0, work: null }
    const part = partOf(render({ work: ok(work()), activity }), 'Anslutningar')
    const rows = [...part.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) => textOf(m[1]))
    expect(rows).toEqual([
      // The key's own last use where the log holds no call; the log's call where it does.
      'Ansluten av dig 2026-01-04 Senast använd 2026-03-02',
      'Ansluten av Anna Ek 2026-02-12 Senast använd 2026-02-28',
    ])
    expect(linksOf(part)).toEqual([['/settings/api', 'Hantera anslutningar']])

    const english = partOf(render({ work: ok(work()), activity }, 'en'), 'Connections')
    expect([...english.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) => textOf(m[1]))).toEqual([
      'Connected by you 2026-01-04 Last used 2026-03-02',
      'Connected by Anna Ek 2026-02-12 Last used 2026-02-28',
    ])
    expect(linksOf(english)).toEqual([['/settings/api', 'Manage connections']])
  })

  it('says a connection was never used, and names nobody for a colleague whose name is not known', () => {
    const card: PictureAgentCard = { ...CARD, connections: [connection('c3', { is_own: false })] }
    const part = partOf(render({ work: ok(work()), card }), 'Anslutningar')
    expect(textOf(part.match(/<li[^>]*>([\s\S]*?)<\/li>/)![1])).toBe('Ansluten 2026-01-04 Aldrig använd')
  })

  it('says nothing of the use of a connection made in another company unless this company\'s own log holds a call', () => {
    // Such a key is used in its other companies too: when the key was last used is not handed out.
    const card: PictureAgentCard = { ...CARD, connections: [connection('c4', { elsewhere: true }), connection('c5', { elsewhere: true })] }
    const activity: PictureActivity = { now: '2026-03-02T09:00:00.000Z', day: '2026-03-02', actors: { c5: { calls_today: 0, last_call_at: '2026-02-20T07:00:00.000Z' } }, capped: false, memory_facts: 0, work: null }
    const part = partOf(render({ work: ok(work()), card, activity }), 'Anslutningar')
    const rows = [...part.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) => textOf(m[1]))
    expect(rows).toEqual(['Ansluten av dig 2026-01-04', 'Ansluten av dig 2026-01-04 Senast använd 2026-02-20'])
  })

  it('shows the connections and the calls while the questions and proposals are on their way, and when they cannot be read', () => {
    const loading = render({ work: { state: 'loading' }, calls })
    expect(partsOf(loading)).toEqual(['Läst', 'Anslutningar'])
    expect(loading).toContain('aria-busy')
    expect(loading).not.toContain('just nu')

    const failed = render({ work: { state: 'failed', description: 'Något gick fel.', onRetry: () => {} }, calls })
    expect(partsOf(failed)).toEqual(['Läst', 'Anslutningar'])
    expect(failed).toContain('Kunde inte läsa frågor och förslag')
    expect(failed).toContain('Något gick fel.')
    expect(render({ work: { state: 'failed', description: 'x', onRetry: () => {} } }, 'en')).toContain('Could not read the questions and proposals')
  })
})
