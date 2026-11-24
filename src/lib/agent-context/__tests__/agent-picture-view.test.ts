import { describe, expect, it } from 'vitest'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import {
  agentGroupOf,
  agentName,
  checkDoesNotApply,
  countParts,
  groupAgents,
  instantWords,
  isFresh,
  latestDelivery,
  memoryDots,
  offersClients,
  orderedCheckLines,
  otherConnections,
  startsWithBrand,
  summarizeChecks,
  type OtherConnections,
} from '../agent-picture-view'
import type { PictureAgents, PictureCheckLine, PictureChecks, PictureSource, PictureSourceGroup } from '../agent-picture'

const source = (over: Partial<PictureSource>): PictureSource => ({
  id: 'x',
  key: 'bank',
  name: null,
  detail: null,
  tail: null,
  count: null,
  state: 'connected',
  last_delivered_at: null,
  logo: null,
  href: '/',
  ...over,
})

describe('isFresh', () => {
  const now = '2026-03-02T10:00:00.000Z'

  it('is true for a delivery in the last ten minutes', () => {
    expect(isFresh('2026-03-02T09:55:00.000Z', now)).toBe(true)
    expect(isFresh('2026-03-02T09:50:00.000Z', now)).toBe(true)
  })

  it('is false for an older delivery, none or an unreadable time', () => {
    expect(isFresh('2026-03-02T09:49:59.000Z', now)).toBe(false)
    expect(isFresh(null, now)).toBe(false)
    expect(isFresh('soon', now)).toBe(false)
  })
})

describe('latestDelivery', () => {
  it('is the newest delivery among the connected sources', () => {
    const groups: PictureSourceGroup[] = [
      { id: 'bank', items: [source({ id: 'a', last_delivered_at: '2026-03-02T05:12:00.000Z' })] },
      {
        id: 'authorities',
        items: [
          source({ id: 'b', last_delivered_at: '2026-03-01T21:14:00.000Z' }),
          // Newer, but not connected: it delivered nothing.
          source({ id: 'c', state: 'needs_attention', last_delivered_at: '2026-03-02T09:00:00.000Z' }),
          source({ id: 'd', state: 'not_connected' }),
        ],
      },
    ]
    expect(latestDelivery(groups)).toBe('2026-03-02T05:12:00.000Z')
  })

  it('leaves out the signed-in person\'s own phone link: what it delivered says nothing of the company', () => {
    const groups: PictureSourceGroup[] = [
      { id: 'bank', items: [source({ id: 'a', last_delivered_at: '2026-03-01T05:12:00.000Z' })] },
      // The newest time in the picture, and the person's own.
      { id: 'documents', items: [source({ id: 'whatsapp', key: 'whatsapp', last_delivered_at: '2026-03-02T09:00:00.000Z' })] },
    ]
    expect(latestDelivery(groups)).toBe('2026-03-01T05:12:00.000Z')
    // With nothing else that delivered, nothing is said about when the company was updated.
    expect(latestDelivery([groups[1]])).toBeNull()
  })

  it('is null when no connected source has a time', () => {
    expect(latestDelivery([])).toBeNull()
    expect(latestDelivery([{ id: 'bank', items: [source({ last_delivered_at: null }), source({ last_delivered_at: 'not a time' })] }])).toBeNull()
  })
})

describe('instantWords', () => {
  // 09:00 in Stockholm on 2 March (CET).
  const now = new Date('2026-03-02T08:00:00.000Z')

  it('says today with its time for an instant on the same Swedish day', () => {
    const words = instantWords('2026-03-02T05:12:00.000Z', now)!
    expect(words).toMatchObject({ today: true, hasTime: true })
    expect(words.date.toISOString()).toBe('2026-03-02T05:12:00.000Z')
    // 23:30 UTC the day before is 00:30 in Stockholm: today.
    expect(instantWords('2026-03-01T23:30:00.000Z', now)).toMatchObject({ today: true, hasTime: true })
  })

  it('says today without a time for a bare date', () => {
    const words = instantWords('2026-03-02', now)!
    expect(words).toMatchObject({ today: true, hasTime: false })
    // Noon of the day, so the date reads the same wherever it is formatted.
    expect(words.date.toISOString()).toBe('2026-03-02T12:00:00.000Z')
  })

  it('says another day by its date', () => {
    expect(instantWords('2026-03-01', now)).toMatchObject({ today: false, hasTime: false })
    expect(instantWords('2026-03-01T22:30:00.000Z', now)).toMatchObject({ today: false, hasTime: true })
  })

  it('answers nothing for what is no date', () => {
    expect(instantWords('nyss', now)).toBeNull()
  })
})

describe('countParts', () => {
  it('names every kind that holds something and leaves out a kind at zero', () => {
    expect(countParts({ vouchers: 4912, bank_rows: 1311, documents: 0, customers: 38, suppliers: 0 })).toEqual({
      parts: [
        { kind: 'vouchers', count: 4912 },
        { kind: 'bank_rows', count: 1311 },
        { kind: 'customers', count: 38 },
      ],
      unknown: false,
    })
  })

  it('leaves out a kind that could not be counted, and says unknown only when none could', () => {
    expect(countParts({ vouchers: null, bank_rows: 2, documents: null, customers: null, suppliers: null })).toEqual({ parts: [{ kind: 'bank_rows', count: 2 }], unknown: false })
    expect(countParts({ vouchers: null, bank_rows: null, documents: null, customers: null, suppliers: null })).toEqual({ parts: [], unknown: true })
    // An empty company is known to be empty.
    expect(countParts({ vouchers: 0, bank_rows: 0, documents: 0, customers: 0, suppliers: 0 })).toEqual({ parts: [], unknown: false })
  })
})

describe('memoryDots', () => {
  it('has three rows of twelve at least, one filled dot per remembered thing', () => {
    expect(memoryDots(0)).toEqual({ total: 36, filled: 0 })
    expect(memoryDots(23)).toEqual({ total: 36, filled: 23 })
    expect(memoryDots(35)).toEqual({ total: 36, filled: 35 })
  })

  it('grows by a row of twelve when the grid is full', () => {
    expect(memoryDots(36)).toEqual({ total: 48, filled: 36 })
    expect(memoryDots(47)).toEqual({ total: 48, filled: 47 })
    expect(memoryDots(48)).toEqual({ total: 60, filled: 48 })
    expect(memoryDots(60)).toEqual({ total: 72, filled: 60 })
  })

  it('stops at six rows, every dot filled', () => {
    expect(memoryDots(72)).toEqual({ total: 72, filled: 72 })
    expect(memoryDots(500)).toEqual({ total: 72, filled: 72 })
  })

  it('takes a count that is no whole positive number as it can', () => {
    expect(memoryDots(-3)).toEqual({ total: 36, filled: 0 })
    expect(memoryDots(2.9)).toEqual({ total: 36, filled: 2 })
  })
})

const line = (check_id: string, status: PictureCheckLine['status'], over: Partial<PictureCheckLine> = {}): PictureCheckLine => ({
  id: `${check_id}:${over.subject ?? 'company'}`,
  check_id,
  name_sv: check_id,
  name_en: check_id,
  subject: null,
  subject_tail: null,
  status,
  difference: null,
  unit: 'SEK',
  things: status === 'attention' ? 1 : null,
  as_of: '2026-03-02',
  href: null,
  reason_code: null,
  ...over,
})

function checks(lines: PictureCheckLine[], over: Partial<PictureChecks> = {}): PictureChecks {
  const counts = { agrees: 0, attention: 0, unknown: 0 }
  for (const l of lines) counts[l.status] += 1
  return { read_at: '2026-03-02T09:00:00.000Z', lines, counts, truncated: 0, queue_unavailable: false, ...over }
}

describe('summarizeChecks', () => {
  it('says the checks could not be read when there are none to read', () => {
    expect(summarizeChecks(null)).toEqual({ kind: 'unreadable' })
    expect(summarizeChecks(checks([]))).toEqual({ kind: 'none' })
  })

  it('names the bank and the skattekonto when everything agrees, each with the time it holds at', () => {
    const summary = summarizeChecks(
      checks([
        line('bank_balance_vs_bank', 'agrees', { subject: 'Företagskonto', as_of: '2026-03-02' }),
        line('skattekonto_vs_skatteverket', 'agrees', { as_of: '2026-03-01' }),
        line('receivables_vs_ledger', 'agrees'),
        line('bank_feed', 'agrees', { as_of: '2026-03-02T05:12:00.000Z' }),
      ]),
    )
    expect(summary).toEqual({
      kind: 'agrees',
      // The bank agrees as of the last time the bank was read.
      named: [
        { check_id: 'bank_balance_vs_bank', as_of: '2026-03-02T05:12:00.000Z' },
        { check_id: 'skattekonto_vs_skatteverket', as_of: '2026-03-01' },
      ],
      // The receivables agree too; the feed is said with the bank.
      more: 1,
      agrees: 4,
      unknown: 0,
    })
  })

  it('takes the bank\'s own date without a feed line, the newest of several accounts', () => {
    const summary = summarizeChecks(
      checks([
        line('bank_balance_vs_bank', 'agrees', { subject: 'A', as_of: '2026-02-28' }),
        line('bank_balance_vs_bank', 'agrees', { subject: 'B', as_of: '2026-03-02' }),
      ]),
    )
    expect(summary).toEqual({ kind: 'agrees', named: [{ check_id: 'bank_balance_vs_bank', as_of: '2026-03-02' }], more: 0, agrees: 2, unknown: 0 })
  })

  it('does not name a check that has a result which could not run, and counts what agrees', () => {
    const summary = summarizeChecks(
      checks([
        line('bank_balance_vs_bank', 'agrees', { subject: 'A' }),
        line('bank_balance_vs_bank', 'unknown', { subject: 'B' }),
        line('payables_vs_ledger', 'agrees'),
        line('skattekonto_vs_skatteverket', 'unknown'),
      ]),
    )
    expect(summary).toEqual({ kind: 'agrees', named: [], more: 2, agrees: 2, unknown: 2 })
  })

  it('says how many need a look and which checks, then how many agree', () => {
    const summary = summarizeChecks(
      checks([
        line('bank_balance_vs_bank', 'attention', { subject: 'A' }),
        line('bank_balance_vs_bank', 'attention', { subject: 'B' }),
        line('skattekonto_vs_skatteverket', 'attention'),
        line('payables_vs_ledger', 'attention'),
        line('receivables_vs_ledger', 'agrees'),
        line('vat_declared_not_settled', 'unknown'),
      ]),
    )
    expect(summary).toEqual({
      kind: 'attention',
      count: 4,
      names: ['bank_balance_vs_bank', 'skattekonto_vs_skatteverket', 'payables_vs_ledger'],
      more: 0,
      agrees: 1,
    })
  })

  it('names three checks and counts the rest', () => {
    const summary = summarizeChecks(checks(['a', 'b', 'c', 'd', 'e'].map((id) => line(id, 'attention'))))
    expect(summary).toMatchObject({ kind: 'attention', count: 5, names: ['a', 'b', 'c'], more: 2, agrees: 0 })
  })

  it('counts by the queue\'s own totals, which include results past the listed ones', () => {
    const summary = summarizeChecks(checks([line('vat_declared_not_settled', 'agrees')], { counts: { agrees: 9, attention: 0, unknown: 1 }, truncated: 8 }))
    expect(summary).toEqual({ kind: 'agrees', named: [], more: 9, agrees: 9, unknown: 1 })
  })

  it('says only that results could not run when nothing agrees and nothing needs a look', () => {
    expect(summarizeChecks(checks([line('receivables_vs_ledger', 'unknown'), line('payables_vs_ledger', 'unknown')]))).toEqual({ kind: 'unknown', count: 2 })
  })
})

describe('a check that does not apply to the company', () => {
  /** The queue's results for a company whose bank and skattekonto agree, with what its form of bookkeeping adds. */
  const withBank = (rest: PictureCheckLine[]): PictureChecks =>
    checks([
      line('bank_balance_vs_bank', 'agrees', { subject: 'Företagskonto' }),
      line('skattekonto_vs_skatteverket', 'agrees'),
      ...rest,
    ])
  const receivables = (status: PictureCheckLine['status'], reason_code: string | null = null): PictureCheckLine => line('receivables_vs_ledger', status, { reason_code })
  const payables = (status: PictureCheckLine['status'], reason_code: string | null = null): PictureCheckLine => line('payables_vs_ledger', status, { reason_code })
  const vat = (status: PictureCheckLine['status'], reason_code: string | null = null): PictureCheckLine => line('vat_declared_not_settled', status, { reason_code })

  it('counts every check of an aktiebolag on the invoice method: all of them apply', () => {
    const summary = summarizeChecks(withBank([receivables('agrees'), payables('agrees'), vat('agrees')]))
    expect(summary).toMatchObject({ kind: 'agrees', agrees: 5, unknown: 0 })
  })

  it('does not count the receivables and the payables of a company on the cash method as checks that could not be read', () => {
    const cash = withBank([receivables('unknown', 'CASH_METHOD'), payables('unknown', 'CASH_METHOD'), vat('agrees')])
    // The queue's own total still holds the two results that did not run.
    expect(cash.counts.unknown).toBe(2)
    expect(summarizeChecks(cash)).toMatchObject({ kind: 'agrees', agrees: 3, unknown: 0 })
  })

  it('does not count the VAT check of a company that is not registered for VAT', () => {
    const noVat = withBank([receivables('agrees'), payables('agrees'), vat('unknown', 'NOT_VAT_REGISTERED')])
    expect(summarizeChecks(noVat)).toMatchObject({ kind: 'agrees', agrees: 4, unknown: 0 })
  })

  it('says there are no checks to show when not one check applies, instead of that they could not be read', () => {
    const none = checks([receivables('unknown', 'CASH_METHOD'), payables('unknown', 'CASH_METHOD'), vat('unknown', 'NOT_VAT_REGISTERED'), line('skattekonto_vs_skatteverket', 'unknown', { reason_code: 'SKATTEKONTO_NOT_CONNECTED' })])
    expect(summarizeChecks(none)).toEqual({ kind: 'none' })
  })

  it('still counts a check without a reason, one whose source failed, and one past the listed results', () => {
    expect(summarizeChecks(withBank([receivables('unknown'), payables('unknown', 'SOURCE_FAILED'), vat('unknown', 'NOT_VAT_REGISTERED')]))).toMatchObject({ kind: 'agrees', unknown: 2 })
    expect(summarizeChecks(checks([receivables('unknown'), vat('unknown', 'NOT_VAT_REGISTERED')]))).toEqual({ kind: 'unknown', count: 1 })
    // A result the queue counted and did not list has no reason here: it is counted.
    expect(summarizeChecks(checks([vat('unknown', 'NOT_VAT_REGISTERED')], { counts: { agrees: 0, attention: 0, unknown: 3 }, truncated: 2 }))).toEqual({ kind: 'unknown', count: 2 })
  })

  it('leaves what needs a look as it is', () => {
    const summary = summarizeChecks(withBank([receivables('attention'), payables('unknown', 'CASH_METHOD')]))
    expect(summary).toMatchObject({ kind: 'attention', count: 1, names: ['receivables_vs_ledger'], agrees: 2 })
  })

  it('tells a check that does not apply from one that could not be read', () => {
    expect(checkDoesNotApply(receivables('unknown', 'CASH_METHOD'))).toBe(true)
    expect(checkDoesNotApply(vat('unknown', 'NOT_VAT_REGISTERED'))).toBe(true)
    expect(checkDoesNotApply(receivables('unknown'))).toBe(false)
    expect(checkDoesNotApply(receivables('unknown', 'SOURCE_FAILED'))).toBe(false)
    expect(checkDoesNotApply(receivables('agrees'))).toBe(false)
    expect(checkDoesNotApply(receivables('attention'))).toBe(false)
  })

  it('lists the checks that do not apply last, the others in the order they were read', () => {
    const listed = orderedCheckLines([receivables('unknown', 'CASH_METHOD'), line('bank_feed', 'attention'), vat('unknown'), payables('unknown', 'CASH_METHOD'), line('bank_balance_vs_bank', 'agrees')])
    expect(listed.map((l) => l.check_id)).toEqual(['bank_feed', 'vat_declared_not_settled', 'bank_balance_vs_bank', 'receivables_vs_ledger', 'payables_vs_ledger'])
  })

  it('gives every reason in words that fit every legal form: the company, never the limited company', () => {
    const reasons: Record<string, string> = sv.wiki.picture.reasons
    for (const sentence of Object.values(reasons)) expect(sentence.toLowerCase()).not.toContain('bolag')
    expect(reasons.CASH_METHOD).toBe('Företaget använder kontantmetoden, så öppna fakturor finns inte i bokföringen förrän i bokslutet.')
    expect(reasons.NOT_VAT_REGISTERED).toBe('Företaget är inte momsregistrerat.')
    expect(reasons.ACCOUNT_ROLE_UNAVAILABLE).toBe('Kontot som kontrollen behöver finns inte för företaget.')
    const english: Record<string, string> = en.wiki.picture.reasons
    expect(english.CASH_METHOD).toContain('The company')
    expect(Object.keys(english).sort()).toEqual(Object.keys(reasons).sort())
  })
})

describe('agentName', () => {
  const agent = (kind: Parameters<typeof agentName>[0]['kind'], name: string | null = null, service_account: string | null = null) => ({ kind, name, service_account })

  it('names Claude, ChatGPT and Grok by their product names', () => {
    expect(agentName(agent('claude'))).toEqual({ text: 'Claude' })
    expect(agentName(agent('chatgpt'))).toEqual({ text: 'ChatGPT' })
    expect(agentName(agent('grok'))).toEqual({ text: 'Grok' })
  })

  it('names a client that is not known, and a local one, by the API settings page\'s own words', () => {
    expect(agentName(agent('mcp'))).toEqual({ message: 'kind_mcp' })
    expect(agentName(agent('local'))).toEqual({ message: 'kind_local' })
    expect(agentName(agent('cursor'))).toEqual({ message: 'kind_cursor' })
    expect(agentName(agent('gemini'))).toEqual({ message: 'target_gemini' })
    expect(agentName(agent('copilot'))).toEqual({ message: 'target_copilot' })
  })

  it('names a hand-made key by its own name and a partner by the partner', () => {
    expect(agentName(agent('key', 'Nattjobbet'))).toEqual({ text: 'Nattjobbet' })
    expect(agentName(agent('partner', 'Partnerbolaget'))).toEqual({ text: 'Partnerbolaget' })
    expect(agentName(agent('partner'))).toEqual({ message: 'kind_partner' })
  })

  it('names a service account\'s connection by the account, not by the key', () => {
    expect(agentName(agent('key', 'prod-key-2', 'Accounteds agent'))).toEqual({ text: 'Accounteds agent' })
  })
})

describe('the agent groups', () => {
  const claude = { id: '1', kind: 'claude' as const, service_account: null }
  const local = { id: '2', kind: 'local' as const, service_account: null }
  const key = { id: '3', kind: 'key' as const, service_account: null }
  const own = { id: '4', kind: 'key' as const, service_account: 'Accounteds agent' }
  const other = { id: '5', kind: 'key' as const, service_account: 'Lönesystemet' }

  it('tells a brand name at the start of a name, whatever the case', () => {
    expect(startsWithBrand('Accounteds agent', 'Accounted')).toBe(true)
    expect(startsWithBrand('  accounted  ', 'Accounted')).toBe(true)
    expect(startsWithBrand('Vår Accounted-agent', 'Accounted')).toBe(false)
    expect(startsWithBrand('Accounteds agent', '')).toBe(false)
  })

  it('puts each connection in its group', () => {
    expect(agentGroupOf(claude, 'Accounted')).toBe('clients')
    expect(agentGroupOf(local, 'Accounted')).toBe('clients')
    expect(agentGroupOf(key, 'Accounted')).toBe('keys')
    expect(agentGroupOf(own, 'Accounted')).toBe('brand')
    expect(agentGroupOf(other, 'Accounted')).toBe('service_accounts')
    // On another host the same account is one of the company's service accounts.
    expect(agentGroupOf(own, 'Byrån')).toBe('service_accounts')
  })

  it('lists the groups in the column\'s order and leaves out an empty one', () => {
    expect(groupAgents([key, other, own, claude, local], 'Accounted').map((g) => [g.id, g.agents.map((a) => a.id)])).toEqual([
      ['clients', ['1', '2']],
      ['brand', ['4']],
      ['service_accounts', ['5']],
      ['keys', ['3']],
    ])
    expect(groupAgents([claude], 'Accounted').map((g) => g.id)).toEqual(['clients'])
    expect(groupAgents([], 'Accounted')).toEqual([])
  })
})

describe('the connections the person may not list', () => {
  const agents = (others: number | null): Pick<PictureAgents, 'others'> => ({ others })

  it('says how many there are, nothing when there are none, and that it is not known when they were not counted', () => {
    const cases: Array<[Pick<PictureAgents, 'others'> | null, OtherConnections]> = [
      [agents(3), { kind: 'count', count: 3 }],
      [agents(1), { kind: 'count', count: 1 }],
      [agents(0), { kind: 'none' }],
      [agents(null), { kind: 'unknown' }],
      // The connections could not be read at all: the column says so in its own card.
      [null, { kind: 'none' }],
    ]
    for (const [given, expected] of cases) expect(otherConnections(given)).toEqual(expected)
  })

  it('offers a client as not connected only when it is known that nobody else has connected anything', () => {
    expect(offersClients(agents(0))).toBe(true)
    // A member whose colleagues' agents work the company is not told that Claude is not connected.
    expect(offersClients(agents(1))).toBe(false)
    expect(offersClients(agents(4))).toBe(false)
    expect(offersClients(agents(null))).toBe(false)
    expect(offersClients(null)).toBe(false)
  })
})
