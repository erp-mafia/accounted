/**
 * The v1 stage mode (`?stage=true`) tells about a filed momsdeklaration the
 * way the MCP door does (lib/pending-operations/filed-vat-note.ts): the dry
 * run answers the proposal as its approver would read it, and the staged row
 * carries the same advisory in preview_data.compliance_warning, through
 * insertStagedOperation, the one insert every non-MCP stager shares.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { z } from 'zod'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { createLogger } from '@/lib/logger'
import { defineOperation, type OperationOutcome } from '../types'

const note = vi.hoisted(() => ({ text: null as string | null, asked: [] as unknown[] }))
vi.mock('@/lib/pending-operations/filed-vat-note', () => ({
  stagedFiledVatNote: async (_supabase: unknown, _companyId: unknown, op: unknown) => {
    note.asked.push(op)
    return note.text
  },
}))

import { stageOperation } from '../stage'

const NOTE =
  'Momsdeklarationen för 2026-Q3 är redan inlämnad (2026-11-11), och rättelsen ändrar underlaget för den. ' +
  'Godkänns förslaget kan deklarationen behöva rättas.'

const run = vi.fn<(...args: unknown[]) => Promise<OperationOutcome<{ ok: boolean }>>>()

// A stand-in for journal-entries.strike-lines: the door is what is under test.
const strikeLines = defineOperation({
  id: 'test.strike-lines',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'high',
  reversible: false,
  docs: {
    summary: 'Test fixture.',
    description: 'Fixture operation for the filed-momsperiod note.',
    useWhen: 'never: test fixture',
    doNotUseFor: 'anything outside this test file',
    pitfalls: [],
    example: { response: {} },
  },
  input: z.object({ journal_entry_id: z.string() }),
  output: z.object({ ok: z.boolean() }),
  http: { method: 'POST', path: '/api/v1/companies/:companyId/test-strike-lines' },
  mcp: {
    name: 'gnubok_test_strike_lines',
    title: 'Test',
    stage: {
      pendingType: 'correct_entry_lines_inline',
      title: () => 'Rättelse av rader i verifikat',
      extras: () => ({ complianceNote: 'Verifikatet är kopplat till en banktransaktion.' }),
    },
  },
  run: (...args) => run(...args),
})

const ACTOR = { type: 'api_key' as const, id: 'key-1', label: 'Agent' }
const PREVIEW = { journal_entry_id: 'e-1', entry_date: '2026-09-27', struck_lines: [], added_lines: [], resulting_lines: [] }

function ctx() {
  const mock = createQueuedMockSupabase()
  mock.enqueue({ data: [], error: null }) // open operations naming the rows
  mock.enqueue({ data: { id: 'op-new', status: 'pending' }, error: null }) // pending_operations insert, when reached
  return { mock, ctx: { supabase: mock.supabase as never, companyId: 'company-1', userId: 'user-1', log: createLogger('test') } }
}

beforeEach(() => {
  vi.clearAllMocks()
  note.text = null
  note.asked.length = 0
  run.mockResolvedValue({ ok: true, dryRun: true, preview: PREVIEW })
})

describe('stageOperation: a proposal that changes a filed momsdeklaration', () => {
  it('answers the dry run with the note beside the operation\'s own advisory', async () => {
    note.text = NOTE
    const { ctx: c } = ctx()

    const staged = await stageOperation(strikeLines, c, { journal_entry_id: 'e-1' }, ACTOR, { dryRun: true })

    expect(staged.ok && staged.dryRun).toBe(true)
    if (!staged.ok || !staged.dryRun) return
    expect(staged.plan.preview.compliance_warning).toBe(`Verifikatet är kopplat till en banktransaktion. ${NOTE}`)
    expect(note.asked).toEqual([
      { operation_type: 'correct_entry_lines_inline', params: { journal_entry_id: 'e-1' }, preview_data: PREVIEW },
    ])
  })

  it('stores the note on the staged row, read by the approver', async () => {
    note.text = NOTE
    const { mock, ctx: c } = ctx()

    const staged = await stageOperation(strikeLines, c, { journal_entry_id: 'e-1' }, ACTOR, { dryRun: false })

    expect(staged.ok && !staged.dryRun).toBe(true)
    const [inserted] = mock.findCall('pending_operations', 'insert') as [{ preview_data: Record<string, unknown> }]
    expect(inserted.preview_data.compliance_warning).toBe(`Verifikatet är kopplat till en banktransaktion. ${NOTE}`)
  })

  it('leaves the dry run and the row as they were when the proposal changes no filed declaration', async () => {
    const dry = ctx()
    const answered = await stageOperation(strikeLines, dry.ctx, { journal_entry_id: 'e-1' }, ACTOR, { dryRun: true })
    if (!answered.ok || !answered.dryRun) throw new Error('expected a dry run')
    expect(answered.plan.preview.compliance_warning).toBe('Verifikatet är kopplat till en banktransaktion.')

    const real = ctx()
    await stageOperation(strikeLines, real.ctx, { journal_entry_id: 'e-1' }, ACTOR, { dryRun: false })
    const [inserted] = real.mock.findCall('pending_operations', 'insert') as [{ preview_data: Record<string, unknown> }]
    expect(inserted.preview_data.compliance_warning).toBe('Verifikatet är kopplat till en banktransaktion.')
  })
})
