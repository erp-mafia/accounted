/**
 * counterparty-templates.rename and counterparty-templates.update: an agent
 * could only read the learned booking rules, so a rule that learned a wrong
 * account stayed and kept proposing it. The rename's rules are tested through
 * the dashboard route (app/api/settings/counterparty-templates); here the
 * contract of the two MCP doors and what they hand an agent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { createLogger } from '@/lib/logger'
import { counterpartyTemplatesRename, counterpartyTemplatesUpdate } from '../counterparty-templates'
import type { OperationContext } from '../types'

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TEMPLATE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

const RULE = {
  id: TEMPLATE_ID,
  company_id: COMPANY_ID,
  counterparty_name: 'hallon ab 4471',
  counterparty_aliases: ['hallon'],
  debit_account: '6211',
  credit_account: '1930',
  vat_treatment: 'standard_25',
  vat_account: '2641',
  category: 'expense_telecom',
  occurrence_count: 3,
  corrections: 0,
  confidence: 0.9,
  last_seen_date: '2026-10-19',
  source: 'auto_learned',
  is_active: true,
  mode: 'propose',
  paused_at: null,
  always_review: false,
  created_at: '2026-08-25T10:00:00Z',
  updated_at: '2026-10-19T10:00:00Z',
}

function setup() {
  const mock = createQueuedMockSupabase()
  const ctx: OperationContext = {
    supabase: mock.supabase as never,
    companyId: COMPANY_ID,
    userId: 'user-1',
    log: createLogger('test'),
  }
  return { ...mock, ctx }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('counterparty-templates: contract', () => {
  it('both are low-risk bookkeeping:write that stage over MCP, behind search, with no v1 door', () => {
    for (const [op, tool, pending] of [
      [counterpartyTemplatesRename, 'gnubok_rename_counterparty_template', 'rename_counterparty_template'],
      [counterpartyTemplatesUpdate, 'gnubok_update_counterparty_template', 'update_counterparty_template'],
    ] as const) {
      expect(op.kind).toBe('write')
      expect(op.scope).toBe('bookkeeping:write')
      expect(op.risk).toBe('low')
      expect(op.http).toBeUndefined()
      expect(op.mcp?.name).toBe(tool)
      expect(op.mcp?.visibility ?? 'search').toBe('search')
      expect(op.mcp?.stage?.pendingType).toBe(pending)
    }
  })

  it('update takes propose or paused and at least one change, nothing else (validation, 400)', () => {
    const parse = (value: unknown) => counterpartyTemplatesUpdate.input.safeParse(value).success
    expect(parse({ counterparty_template_id: TEMPLATE_ID, mode: 'paused' })).toBe(true)
    expect(parse({ counterparty_template_id: TEMPLATE_ID, mode: 'propose' })).toBe(true)
    expect(parse({ counterparty_template_id: TEMPLATE_ID, always_review: true })).toBe(true)
    // Booking on its own waits for the autopilot tier, as on the web.
    expect(parse({ counterparty_template_id: TEMPLATE_ID, mode: 'auto' })).toBe(false)
    expect(parse({ counterparty_template_id: TEMPLATE_ID })).toBe(false)
    expect(parse({ counterparty_template_id: 'hallon', mode: 'paused' })).toBe(false)
    // The accounts are learned from bookings, never typed in here.
    expect(parse({ counterparty_template_id: TEMPLATE_ID, mode: 'paused', debit_account: '6212' })).toBe(false)
  })

  it('rename needs a uuid and a name of at most 100 characters (validation, 400)', () => {
    const parse = (value: unknown) => counterpartyTemplatesRename.input.safeParse(value).success
    expect(parse({ counterparty_template_id: TEMPLATE_ID, counterparty_name: 'Hallon' })).toBe(true)
    expect(parse({ counterparty_template_id: TEMPLATE_ID, counterparty_name: '   ' })).toBe(false)
    expect(parse({ counterparty_template_id: TEMPLATE_ID, counterparty_name: 'a'.repeat(101) })).toBe(false)
    expect(parse({ counterparty_template_id: TEMPLATE_ID })).toBe(false)
  })

  it('titles the approval by what changes and the rule the preview names, never by an id', () => {
    const update = counterpartyTemplatesUpdate.mcp!.stage!.title
    const preview = { counterparty_name_display: 'Hallon Ab 4471' }
    expect(update({ counterparty_template_id: TEMPLATE_ID, mode: 'paused' }, preview)).toBe('Pausa regeln för Hallon Ab 4471')
    expect(update({ counterparty_template_id: TEMPLATE_ID, mode: 'propose' }, preview)).toBe(
      'Låt regeln för Hallon Ab 4471 föreslå igen',
    )
    expect(update({ counterparty_template_id: TEMPLATE_ID, always_review: true }, preview)).toBe(
      'Regeln för Hallon Ab 4471 ska alltid granskas',
    )
    expect(update({ counterparty_template_id: TEMPLATE_ID, mode: 'paused' })).toBe('Pausa regeln för motparten')
    // Both changed: the title names both, never only the mode.
    expect(update({ counterparty_template_id: TEMPLATE_ID, mode: 'propose', always_review: true }, preview)).toBe(
      'Låt regeln för Hallon Ab 4471 föreslå igen och kräv alltid granskning',
    )
    expect(update({ counterparty_template_id: TEMPLATE_ID, mode: 'paused', always_review: false }, preview)).toBe(
      'Pausa regeln för Hallon Ab 4471 och sluta kräva granskning',
    )
    const rename = counterpartyTemplatesRename.mcp!.stage!.title
    expect(
      rename(
        { counterparty_template_id: TEMPLATE_ID, counterparty_name: 'hallon' },
        { counterparty_name_display: 'Hallon Ab 4471', new_name_display: 'Hallon' },
      ),
    ).toBe('Byt namn på regeln Hallon Ab 4471 till Hallon')
  })
})

describe('counterparty-templates.update: run', () => {
  it('dry run answers the rule before and after and writes nothing', async () => {
    const { ctx, enqueue, findCall } = setup()
    enqueue({ data: RULE })

    const outcome = await counterpartyTemplatesUpdate.run(
      ctx,
      { counterparty_template_id: TEMPLATE_ID, mode: 'paused' },
      { dryRun: true },
    )

    expect(outcome).toMatchObject({
      ok: true,
      dryRun: true,
      preview: {
        counterparty_template_id: TEMPLATE_ID,
        debit_account: '6211',
        mode_before: 'propose',
        mode_after: 'paused',
        always_review_after: false,
        changed: true,
      },
    })
    expect(findCall('categorization_templates', 'update')).toBeUndefined()
  })

  it('pauses the rule through the same update the Regler page makes, and answers it in the output shape', async () => {
    const { ctx, enqueueMany, findCall, findCalls } = setup()
    enqueueMany([{ data: RULE }, { data: { ...RULE, mode: 'paused', is_active: false, paused_at: '2026-11-25T10:00:00Z' } }])

    const outcome = await counterpartyTemplatesUpdate.run(
      ctx,
      { counterparty_template_id: TEMPLATE_ID, mode: 'paused' },
      { dryRun: false },
    )

    expect(findCall('categorization_templates', 'update')).toEqual([{ mode: 'paused', always_review: undefined }])
    expect(findCalls('categorization_templates', 'eq')).toContainEqual(['company_id', COMPANY_ID])
    expect(outcome.ok && !outcome.dryRun).toBe(true)
    if (!outcome.ok || outcome.dryRun) return
    expect(outcome.data).toMatchObject({ changed: true, template: { counterparty_template_id: TEMPLATE_ID, mode: 'paused' } })
    expect(counterpartyTemplatesUpdate.output.safeParse(outcome.data).success).toBe(true)
  })

  it('a rule already as asked is answered unchanged, with no write', async () => {
    const { ctx, enqueue, findCall } = setup()
    enqueue({ data: { ...RULE, always_review: true } })

    const outcome = await counterpartyTemplatesUpdate.run(
      ctx,
      { counterparty_template_id: TEMPLATE_ID, mode: 'propose', always_review: true },
      { dryRun: false },
    )

    expect(outcome).toMatchObject({ ok: true, data: { changed: false, template: { always_review: true } } })
    expect(findCall('categorization_templates', 'update')).toBeUndefined()
  })

  it('answers COUNTERPARTY_TEMPLATE_NOT_FOUND for another company\'s or an unknown rule (404)', async () => {
    const { ctx, enqueue, findCall } = setup()
    enqueue({ data: null })

    const outcome = await counterpartyTemplatesUpdate.run(
      ctx,
      { counterparty_template_id: TEMPLATE_ID, mode: 'paused' },
      { dryRun: false },
    )

    expect(outcome).toEqual({ ok: false, code: 'COUNTERPARTY_TEMPLATE_NOT_FOUND' })
    expect(findCall('categorization_templates', 'update')).toBeUndefined()
  })
})

describe('counterparty-templates.rename: run', () => {
  it('dry run names the rule as it is and as it would be, and writes nothing', async () => {
    const { ctx, enqueueMany, findCall } = setup()
    enqueueMany([{ data: RULE }, { data: null }])

    const outcome = await counterpartyTemplatesRename.run(
      ctx,
      { counterparty_template_id: TEMPLATE_ID, counterparty_name: 'Hallon' },
      { dryRun: true },
    )

    expect(outcome).toMatchObject({
      ok: true,
      dryRun: true,
      preview: { counterparty_name_display: 'Hallon AB 4471', new_name_display: 'Hallon', changed: true },
    })
    expect(findCall('categorization_templates', 'update')).toBeUndefined()
    expect(findCall('categorization_templates', 'delete')).toBeUndefined()
  })

  it('renames, keeps the old name as an alias, and answers the template in the output shape', async () => {
    const { ctx, enqueueMany, findCall } = setup()
    const renamed = { ...RULE, counterparty_name: 'hallon', counterparty_aliases: ['hallon', 'hallon ab 4471'] }
    enqueueMany([{ data: RULE }, { data: null }, { data: renamed }])

    const outcome = await counterpartyTemplatesRename.run(
      ctx,
      { counterparty_template_id: TEMPLATE_ID, counterparty_name: 'Hallon' },
      { dryRun: false },
    )

    expect(findCall('categorization_templates', 'update')).toEqual([
      { counterparty_name: 'hallon', counterparty_aliases: ['hallon', 'hallon ab 4471'] },
    ])
    expect(outcome.ok && !outcome.dryRun).toBe(true)
    if (!outcome.ok || outcome.dryRun) return
    expect(outcome.data).toMatchObject({
      changed: true,
      template: { counterparty_name: 'hallon', counterparty_name_display: 'Hallon', mode: 'propose' },
    })
    expect(counterpartyTemplatesRename.output.safeParse(outcome.data).success).toBe(true)
  })

  it('maps the refusals to their codes: unknown (404), name taken (409), too short (400)', async () => {
    const unknown = setup()
    unknown.enqueue({ data: null })
    expect(
      await counterpartyTemplatesRename.run(
        unknown.ctx,
        { counterparty_template_id: TEMPLATE_ID, counterparty_name: 'Hallon' },
        { dryRun: false },
      ),
    ).toEqual({ ok: false, code: 'COUNTERPARTY_TEMPLATE_NOT_FOUND' })

    const taken = setup()
    taken.enqueueMany([{ data: RULE }, { data: { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', is_active: true } }])
    expect(
      await counterpartyTemplatesRename.run(
        taken.ctx,
        { counterparty_template_id: TEMPLATE_ID, counterparty_name: 'Hallon' },
        { dryRun: false },
      ),
    ).toEqual({ ok: false, code: 'COUNTERPARTY_TEMPLATE_NAME_TAKEN' })

    const short = setup()
    const outcome = await counterpartyTemplatesRename.run(
      short.ctx,
      { counterparty_template_id: TEMPLATE_ID, counterparty_name: 'H' },
      { dryRun: false },
    )
    expect(outcome).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' })
    expect(short.supabase.from).not.toHaveBeenCalled()
  })
})
