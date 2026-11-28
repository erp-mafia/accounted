import { beforeEach, describe, expect, it } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { readRuleTrackRecord, trackRecordFrom, TRACK_RECORD_WINDOW } from '../track-record'

const RULE = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'

/** The first suggestion of a decided bank line, as suggestion_log keeps it. */
function top(ruleId: string, matchesFinal: boolean, templateVersion?: number) {
  return {
    top: {
      source: 'counterparty_template',
      source_id: `counterparty:${ruleId}`,
      rank: 0,
      matches_final: matchesFinal,
      ...(templateVersion !== undefined ? { evidence: { seen_count: 4, template_version: templateVersion } } : {}),
    },
  }
}

describe('trackRecordFrom', () => {
  it('counts the decided lines the rule proposed first, and those booked as it proposed', () => {
    const rows = [top(RULE, true), top(RULE, true), top(RULE, false), top(OTHER, true), { top: null }, { top: 'x' }]
    expect(trackRecordFrom(rows, RULE, null)).toEqual({ decided: 3, as_proposed: 2, version: null, current: null, capped: false })
  })

  it('counts the current version from the version each suggestion recorded', () => {
    const rows = [top(RULE, true, 3), top(RULE, false, 3), top(RULE, true, 2), top(RULE, true)]
    expect(trackRecordFrom(rows, RULE, 3)).toEqual({
      decided: 4,
      as_proposed: 3,
      version: 3,
      current: { decided: 2, as_proposed: 1 },
      capped: false,
    })
  })

  it('a rule never proposed first has no decisions', () => {
    expect(trackRecordFrom([top(OTHER, true)], RULE, 1)).toEqual({
      decided: 0,
      as_proposed: 0,
      version: 1,
      current: { decided: 0, as_proposed: 0 },
      capped: false,
    })
  })
})

describe('readRuleTrackRecord', () => {
  const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()

  beforeEach(() => {
    reset()
  })

  it("reads the company's decided bank lines whose first suggestion is the rule, newest first", async () => {
    enqueue({ data: { version: 2 } })
    enqueue({ data: [top(RULE, true, 2), top(RULE, false, 1)] })

    const record = await readRuleTrackRecord(supabase as never, 'company-1', RULE)

    expect(record).toEqual({ decided: 2, as_proposed: 1, version: 2, current: { decided: 1, as_proposed: 1 }, capped: false })
    expect(findCalls('suggestion_log', 'eq')).toEqual([
      ['company_id', 'company-1'],
      ['kind', 'bank_line'],
      ['suggestions->0->>source_id', `counterparty:${RULE}`],
    ])
    expect(findCalls('suggestion_log', 'neq')).toEqual([['outcome', 'dismissed']])
    expect(findCalls('suggestion_log', 'limit')).toEqual([[TRACK_RECORD_WINDOW]])
  })

  it('answers the counts without a version before the column exists', async () => {
    enqueue({ error: { code: '42703', message: 'column categorization_templates.version does not exist' } })
    enqueue({ data: [top(RULE, true)] })

    expect(await readRuleTrackRecord(supabase as never, 'company-1', RULE)).toEqual({
      decided: 1,
      as_proposed: 1,
      version: null,
      current: null,
      capped: false,
    })
  })

  it('throws when the decisions cannot be read', async () => {
    enqueue({ data: { version: 1 } })
    enqueue({ error: { code: '57014', message: 'canceling statement due to statement timeout' } })
    await expect(readRuleTrackRecord(supabase as never, 'company-1', RULE)).rejects.toMatchObject({ code: '57014' })
  })
})
