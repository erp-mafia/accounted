import { describe, expect, it } from 'vitest'
import {
  agentGroupOf,
  agentName,
  countParts,
  groupAgents,
  instantWords,
  isFresh,
  latestDelivery,
  memoryDots,
  startsWithBrand,
  summarizeChecks,
} from '../agent-picture-view'
import type { PictureCheckLine, PictureChecks, PictureSource, PictureSourceGroup } from '../agent-picture'

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

  it('is null when no connected source has a time', () => {
    expect(latestDelivery([])).toBeNull()
    expect(latestDelivery([{ id: 'bank', items: [source({ last_delivered_at: null }), source({ last_delivered_at: 'not a time' })] }])).toBeNull()
  })
})

describe('instantWords', () => {
  // Built from local parts, so the test reads the same in every time zone.
  const now = new Date(2026, 2, 2, 9, 0)

  it('says today with its time for an instant on the same day', () => {
    const words = instantWords(new Date(2026, 2, 2, 6, 12).toISOString(), now)!
    expect(words.today).toBe(true)
    expect(words.hasTime).toBe(true)
    expect(words.date.getHours()).toBe(6)
  })

  it('says today without a time for a bare date', () => {
    expect(instantWords('2026-03-02', now)).toMatchObject({ today: true, hasTime: false })
  })

  it('says another day by its date', () => {
    expect(instantWords('2026-03-01', now)).toMatchObject({ today: false, hasTime: false })
    expect(instantWords(new Date(2026, 2, 1, 23, 59).toISOString(), now)).toMatchObject({ today: false, hasTime: true })
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
