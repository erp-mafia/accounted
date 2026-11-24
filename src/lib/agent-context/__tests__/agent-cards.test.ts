/**
 * The cards of the agents column: which connections share a card, which
 * rows belong to a card, and what a card's line says.
 */
import { describe, expect, it } from 'vitest'
import { agentCardId, agentCards, agentCardState, cardOwnsRow, cardWork, tallyWork, type CardConnection } from '../agent-cards'
import type { PictureActivity, PictureAgent, PictureAgentCard, PictureWork } from '../agent-picture'

const connection = (id: string, over: Partial<CardConnection> = {}): CardConnection => ({
  id,
  kind: 'claude',
  name: null,
  service_account: null,
  service_account_id: null,
  label: 'Claude (Anthropic)',
  ...over,
})
const key = (id: string, name: string) => connection(id, { kind: 'key', name, label: name })
const account = (id: string, accountId: string, name: string) => connection(id, { kind: 'key', name: `nyckel ${id}`, service_account: name, service_account_id: accountId, label: name })

describe('agentCardId', () => {
  it('names a card by its kind, by its named connection, or by its service account', () => {
    expect(agentCardId(connection('a'))).toBe('claude')
    expect(agentCardId(connection('b', { kind: 'mcp' }))).toBe('mcp')
    expect(agentCardId(key('c', 'Nattjobbet'))).toBe('key:c')
    expect(agentCardId(connection('d', { kind: 'partner', name: 'Byrån' }))).toBe('key:d')
    // A partner whose name is not known is named by its kind, like any client the screen names that way.
    expect(agentCardId(connection('e', { kind: 'partner' }))).toBe('partner')
    // The account wins over the key's own name.
    expect(agentCardId(account('f', 'sa-1', 'Lönesystemet'))).toBe('account:sa-1')
  })
})

describe('agentCards', () => {
  it('puts the connections of one kind on one card, and keeps the order they came in', () => {
    const cards = agentCards([connection('c2'), connection('l1', { kind: 'local', label: 'MCP-klient (OAuth)' }), connection('c1'), connection('g1', { kind: 'chatgpt', label: 'ChatGPT (OpenAI)' }), connection('c3')])
    expect(cards.map((card) => [card.id, card.kind, card.name, card.connections.map((c) => c.id)])).toEqual([
      ['claude', 'claude', null, ['c2', 'c1', 'c3']],
      ['local', 'local', null, ['l1']],
      ['chatgpt', 'chatgpt', null, ['g1']],
    ])
  })

  it('keeps a named key and a named partner key as cards of their own, even under one name', () => {
    const cards = agentCards([key('k1', 'Nattjobbet'), key('k2', 'Nattjobbet'), connection('p1', { kind: 'partner', name: 'Byrån', label: 'Byrån' })])
    expect(cards.map((card) => [card.id, card.name, card.connections.length])).toEqual([
      ['key:k1', 'Nattjobbet', 1],
      ['key:k2', 'Nattjobbet', 1],
      ['key:p1', 'Byrån', 1],
    ])
  })

  it('puts a service account\'s connections on one card per account, named by the account alone', () => {
    const cards = agentCards([account('k1', 'sa-1', 'Lönesystemet'), account('k2', 'sa-2', 'Kassan'), account('k3', 'sa-1', 'Lönesystemet')])
    expect(cards.map((card) => [card.id, card.kind, card.name, card.service_account, card.connections.map((c) => c.id)])).toEqual([
      ['account:sa-1', 'key', null, 'Lönesystemet', ['k1', 'k3']],
      ['account:sa-2', 'key', null, 'Kassan', ['k2']],
    ])
  })

  it('gives a card the labels its connections alone can have written', () => {
    const cards = agentCards([
      connection('c1'),
      connection('c2'),
      key('k1', 'Nattjobbet'),
      key('k2', 'Nattjobbet'),
      key('k3', 'Rapporter'),
      connection('m1', { kind: 'mcp', label: null }),
    ])
    expect(cards.map((card) => [card.id, card.labels])).toEqual([
      // Two connections of one card writing one label: the card owns it, once.
      ['claude', ['Claude (Anthropic)']],
      // Two cards can have written "Nattjobbet": neither owns it.
      ['key:k1', []],
      ['key:k2', []],
      ['key:k3', ['Rapporter']],
      // A connection whose label is not known owns none.
      ['mcp', []],
    ])
  })

  it('answers no cards for no connections', () => {
    expect(agentCards([])).toEqual([])
  })
})

describe('which rows belong to a card', () => {
  // The cards come in the order of their first connection: claude, key:k1, key:k2, key:k3.
  const [claude, nightA, nightB, reports] = agentCards([connection('c1'), connection('c2'), key('k1', 'Nattjobbet'), key('k2', 'Nattjobbet'), key('k3', 'Rapporter')])

  it('takes a row that names one of the card\'s connections by id', () => {
    expect(cardOwnsRow(claude, { actor_id: 'c2', actor_label: null })).toBe(true)
    expect(cardOwnsRow(claude, { actor_id: 'k1', actor_label: 'Claude (Anthropic)' })).toBe(false)
    expect(cardOwnsRow(nightA, { actor_id: 'k1', actor_label: 'Nattjobbet' })).toBe(true)
  })

  it('takes a row that carries only a label when the card alone owns the label', () => {
    expect(cardOwnsRow(claude, { actor_id: null, actor_label: 'Claude (Anthropic)' })).toBe(true)
    expect(cardOwnsRow(reports, { actor_id: null, actor_label: 'Rapporter' })).toBe(true)
    expect(cardOwnsRow(reports, { actor_id: null, actor_label: 'Claude (Anthropic)' })).toBe(false)
  })

  it('leaves a row out of every card when two cards share its label', () => {
    const row = { actor_id: null, actor_label: 'Nattjobbet' }
    expect([claude, nightA, nightB, reports].filter((card) => cardOwnsRow(card, row))).toEqual([])
  })

  it('never reads a row that names a connection by its label, and takes no row that names nobody', () => {
    // The id names a connection no card has (one that was disconnected): the label is not a second chance.
    expect(cardOwnsRow(claude, { actor_id: 'gone', actor_label: 'Claude (Anthropic)' })).toBe(false)
    expect(cardOwnsRow(claude, { actor_id: null, actor_label: null })).toBe(false)
    expect(cardOwnsRow(claude, { actor_id: '', actor_label: '' })).toBe(false)
  })
})

describe('the work of a day, by card', () => {
  const cards = agentCards([connection('c1'), connection('c2'), key('k1', 'Nattjobbet'), key('k2', 'Nattjobbet'), key('k3', 'Rapporter')])
  const of = (id: string) => cards.find((card) => card.id === id)!

  it('keeps a label that is also a name on Object.prototype as an ordinary entry', () => {
    const work = tallyWork(
      [{ actor_id: null, actor_label: 'constructor' }],
      [
        { actor_id: null, actor_label: '__proto__' },
        { actor_id: null, actor_label: '__proto__' },
        { actor_id: '__proto__', actor_label: 'x' },
      ],
    )
    // Nothing reached the prototype every object shares.
    expect(Object.hasOwn(Object.prototype, 'proposals')).toBe(false)
    expect(Object.hasOwn(Object.prototype, 'questions')).toBe(false)
    expect(({} as Record<string, unknown>).proposals).toBeUndefined()
    // The rows are counted under their own keys.
    expect(Object.keys(work.by_label).sort()).toEqual(['__proto__', 'constructor'])
    expect(work.by_label['__proto__']).toEqual({ questions: 0, proposals: 2 })
    expect(work.by_label.constructor).toEqual({ questions: 1, proposals: 0 })
    expect(Object.keys(work.by_connection)).toEqual(['__proto__'])
    expect(work.by_connection['__proto__']).toEqual({ questions: 0, proposals: 1 })
    // As the browser gets it: the counts survive the trip as own entries.
    const sent = JSON.parse(JSON.stringify(work)) as PictureWork
    expect(Object.hasOwn(sent.by_label, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(sent.by_label)).toBe(Object.prototype)
  })

  it('reads only a table\'s own entries: a card whose label is a name on Object.prototype counts nothing inherited', () => {
    const named = agentCards([key('k9', 'constructor'), key('k8', 'toString')])
    const empty: PictureWork = { by_connection: {}, by_label: {} }
    for (const card of named) expect(cardWork(card, empty)).toEqual({ questions: 0, proposals: 0 })
    const some: PictureWork = JSON.parse(JSON.stringify(tallyWork([], [{ actor_id: null, actor_label: 'constructor' }]))) as PictureWork
    const owner = named.find((card) => card.labels.includes('constructor'))!
    expect(cardWork(owner, some)).toEqual({ questions: 0, proposals: 1 })
  })

  it('counts each row under the connection it names, or under its label when it names none', () => {
    const work = tallyWork(
      [
        { actor_id: 'c1', actor_label: 'Claude (Anthropic)' },
        { actor_id: null, actor_label: 'Rapporter' },
        { actor_id: null, actor_label: null },
      ],
      [
        { actor_id: 'c1', actor_label: 'Claude (Anthropic)' },
        { actor_id: 'c2', actor_label: 'Claude (Anthropic)' },
        { actor_id: 'k1', actor_label: 'Nattjobbet' },
        { actor_id: null, actor_label: 'Nattjobbet' },
        { actor_id: null, actor_label: 'Claude (Anthropic)' },
      ],
    )
    expect(work).toEqual({
      by_connection: { c1: { questions: 1, proposals: 1 }, c2: { questions: 0, proposals: 1 }, k1: { questions: 0, proposals: 1 } },
      by_label: { Rapporter: { questions: 1, proposals: 0 }, Nattjobbet: { questions: 0, proposals: 1 }, 'Claude (Anthropic)': { questions: 0, proposals: 1 } },
    })

    // By id over both connections, and the label the card alone owns.
    expect(cardWork(of('claude'), work)).toEqual({ questions: 1, proposals: 3 })
    // By id only: the label two cards share is counted on neither.
    expect(cardWork(of('key:k1'), work)).toEqual({ questions: 0, proposals: 1 })
    expect(cardWork(of('key:k2'), work)).toEqual({ questions: 0, proposals: 0 })
    // By a label one card owns.
    expect(cardWork(of('key:k3'), work)).toEqual({ questions: 1, proposals: 0 })
  })

  it('answers nothing done when the work is not known', () => {
    expect(cardWork(of('claude'), null)).toEqual({ questions: 0, proposals: 0 })
    expect(cardWork(of('claude'), undefined)).toEqual({ questions: 0, proposals: 0 })
  })
})

describe('what a card\'s line says', () => {
  const NOW = '2026-03-02T09:00:00.000Z'
  const agent = (id: string, over: Partial<PictureAgent> = {}): PictureAgent => ({
    id,
    kind: 'claude',
    name: null,
    service_account: null,
    last_used_at: null,
    calls_today: 0,
    last_call_at: null,
    connected_at: '2026-01-01T00:00:00.000Z',
    is_own: true,
    owner_name: null,
    ...over,
  })
  const card = (connections: PictureAgent[], labels: string[] = []): Pick<PictureAgentCard, 'connections' | 'labels'> => ({ connections, labels })
  const activity = (over: Partial<PictureActivity> = {}): PictureActivity => ({ now: NOW, day: '2026-03-02', actors: {}, capped: false, memory_facts: 0, work: { by_connection: {}, by_label: {} }, ...over })
  const work = (by_connection: PictureWork['by_connection'], by_label: PictureWork['by_label'] = {}): PictureWork => ({ by_connection, by_label })

  it('says reading now for a call in the last minute by any of its connections, whatever else it did', () => {
    const state = agentCardState(
      card([agent('a'), agent('b')]),
      activity({
        actors: { a: { calls_today: 3, last_call_at: '2026-03-02T08:00:00.000Z' }, b: { calls_today: 1, last_call_at: '2026-03-02T08:59:30.000Z' } },
        work: work({ a: { questions: 2, proposals: 3 } }),
      }),
    )
    expect(state).toEqual({ line: { kind: 'reading' }, active: true, calls: 4, last_call_at: '2026-03-02T08:59:30.000Z', capped: false, connections: 2 })
  })

  it('says what the card did for the company today before it says how many calls it made', () => {
    const called = { a: { calls_today: 14, last_call_at: '2026-03-02T08:10:00.000Z' } }
    expect(agentCardState(card([agent('a'), agent('b')]), activity({ actors: called, work: work({ a: { questions: 1, proposals: 1 }, b: { questions: 1, proposals: 2 } }) })).line).toEqual({ kind: 'work', questions: 2, proposals: 3 })
    expect(agentCardState(card([agent('a')]), activity({ actors: called, work: work({ a: { questions: 2, proposals: 0 } }) })).line).toEqual({ kind: 'work', questions: 2, proposals: 0 })
    expect(agentCardState(card([agent('a')]), activity({ actors: called, work: work({ a: { questions: 0, proposals: 1 } }) })).line).toEqual({ kind: 'work', questions: 0, proposals: 1 })
    // Work that came in through a label the card owns counts too, with no call in the log.
    expect(agentCardState(card([agent('a')], ['Nattjobbet']), activity({ work: work({}, { Nattjobbet: { questions: 0, proposals: 4 } }) })).line).toEqual({ kind: 'work', questions: 0, proposals: 4 })
    // Another card's work is not this card's.
    expect(agentCardState(card([agent('a')]), activity({ actors: called, work: work({ z: { questions: 5, proposals: 5 } }) })).line.kind).toBe('calls')
  })

  it('says the calls of the day over every connection, with the newest call, when nothing else was done', () => {
    const state = agentCardState(
      card([agent('a'), agent('b'), agent('c')]),
      activity({ actors: { a: { calls_today: 10, last_call_at: '2026-03-02T07:00:00.000Z' }, b: { calls_today: 4, last_call_at: '2026-03-02T08:10:00.000Z' } } }),
    )
    expect(state).toEqual({ line: { kind: 'calls', count: 14, last_call_at: '2026-03-02T08:10:00.000Z', capped: false }, active: false, calls: 14, last_call_at: '2026-03-02T08:10:00.000Z', capped: false, connections: 3 })
    // A day with more calls than were read says so.
    expect(agentCardState(card([agent('a')]), activity({ capped: true, actors: { a: { calls_today: 1000, last_call_at: '2026-03-02T08:10:00.000Z' } } })).line).toEqual({ kind: 'calls', count: 1000, last_call_at: '2026-03-02T08:10:00.000Z', capped: true })
  })

  it('says when the card was last used when it made no call today: the newest of its connections', () => {
    const state = agentCardState(
      card([agent('a', { last_used_at: '2026-02-10T10:00:00.000Z' }), agent('b', { last_used_at: '2026-02-20T10:00:00.000Z' }), agent('c')]),
      activity({ actors: { a: { calls_today: 0, last_call_at: '2026-02-25T10:00:00.000Z' } } }),
    )
    // A connection's last call in the log wins over when its key was last used.
    expect(state.line).toEqual({ kind: 'last_used', at: '2026-02-25T10:00:00.000Z' })
    expect(agentCardState(card([agent('a', { last_used_at: '2026-02-10T10:00:00.000Z' }), agent('b', { last_used_at: '2026-02-20T10:00:00.000Z' })]), activity()).line).toEqual({ kind: 'last_used', at: '2026-02-20T10:00:00.000Z' })
  })

  it('says never used for a card none of whose connections was used', () => {
    expect(agentCardState(card([agent('a'), agent('b')]), activity())).toEqual({ line: { kind: 'never_used' }, active: false, calls: 0, last_call_at: null, capped: false, connections: 2 })
  })

  it('says only that a connection made in another company is connected when this company\'s log holds no call of it', () => {
    // The loader hands out no last use for such a key: it may be another company's.
    const elsewhere = agent('a', { elsewhere: true })
    expect(agentCardState(card([elsewhere]), activity()).line).toEqual({ kind: 'connected' })
    expect(agentCardState(card([elsewhere]), null).line).toEqual({ kind: 'connected' })
    // Beside a connection made here that was never used, the card still says no more than it knows.
    expect(agentCardState(card([agent('b'), elsewhere]), activity()).line).toEqual({ kind: 'connected' })
  })

  it('reads the line of a connection made in another company from this company\'s own calls', () => {
    const elsewhere = agent('a', { elsewhere: true })
    const earlier = activity({ actors: { a: { calls_today: 0, last_call_at: '2026-02-25T10:00:00.000Z' } } })
    expect(agentCardState(card([elsewhere]), earlier).line).toEqual({ kind: 'last_used', at: '2026-02-25T10:00:00.000Z' })
    const today = activity({ actors: { a: { calls_today: 2, last_call_at: '2026-03-02T08:10:00.000Z' } } })
    expect(agentCardState(card([elsewhere]), today).line).toEqual({ kind: 'calls', count: 2, last_call_at: '2026-03-02T08:10:00.000Z', capped: false })
    // A connection made here that was used says so, whatever stands beside it.
    expect(agentCardState(card([agent('b', { last_used_at: '2026-02-10T10:00:00.000Z' }), elsewhere]), activity()).line).toEqual({ kind: 'last_used', at: '2026-02-10T10:00:00.000Z' })
  })

  it('says nothing about today without an activity answer: only when the card was last used', () => {
    const connections = [agent('a', { calls_today: 9, last_call_at: '2026-03-02T08:59:50.000Z', last_used_at: '2026-03-02T08:59:50.000Z' })]
    expect(agentCardState(card(connections), null)).toEqual({ line: { kind: 'last_used', at: '2026-03-02T08:59:50.000Z' }, active: false, calls: 9, last_call_at: '2026-03-02T08:59:50.000Z', capped: false, connections: 1 })
  })

  it('falls back to the calls when the day\'s work could not be read', () => {
    const state = agentCardState(card([agent('a')]), activity({ work: null, actors: { a: { calls_today: 2, last_call_at: '2026-03-02T08:10:00.000Z' } } }))
    expect(state.line).toEqual({ kind: 'calls', count: 2, last_call_at: '2026-03-02T08:10:00.000Z', capped: false })
  })
})
