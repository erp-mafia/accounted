/**
 * The staging preview of every salary-run structure write is the real
 * service's dry run (../salary-run-structure.ts), so it must reach a preview
 * without writing anything. Run against the real services and a client that
 * answers every read with a permissive row and records every write, the same
 * shape as the MCP staging harness (staging-behaviour.test.ts). The per-tool
 * rows below are the fixtures that harness needs to drive each tool to its
 * staging insert.
 */
import { describe, expect, it } from 'vitest'
import type { Logger } from '@/lib/logger'
import type { AnyOperation } from '../types'
import {
  salaryRunsCorrect,
  salaryRunsEmployeesAdd,
  salaryRunsEmployeesRemove,
  salaryRunsLinesCreate,
  salaryRunsLinesDelete,
  salaryRunsMarkPaid,
} from '../salary-run-structure'

const COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const USER_ID = '22222222-2222-4222-8222-222222222222'
const SOME_UUID = '33333333-3333-4333-8333-333333333333'

interface Fixture {
  rows?: Record<string, Record<string, unknown>>
  empty?: string[]
}

function recordingClient(fixture: Fixture) {
  const writes: string[] = []
  const builder = (table: string): unknown => {
    const row = { id: SOME_UUID, company_id: COMPANY_ID, status: 'draft', ...(fixture.rows?.[table] ?? {}) }
    let single = false
    const chain: unknown = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            const empty = fixture.empty?.includes(table)
            return (resolve: (value: unknown) => void) =>
              resolve({ data: empty ? (single ? null : []) : single ? row : [row], error: null, count: empty ? 0 : 1 })
          }
          if (prop === 'single' || prop === 'maybeSingle') {
            return () => {
              single = true
              return chain
            }
          }
          if (prop === 'insert' || prop === 'update' || prop === 'delete' || prop === 'upsert') {
            return () => {
              writes.push(`${String(prop)} on ${table}`)
              return chain
            }
          }
          return () => chain
        },
      },
    )
    return chain
  }
  const client = {
    from: (table: string) => builder(table),
    rpc: (fn: string) => {
      writes.push(`rpc ${fn}`)
      return builder(`rpc:${fn}`)
    },
  }
  return { client, writes }
}

const log = { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} } as unknown as Logger

const CASES: Array<{ op: AnyOperation; args: Record<string, unknown>; fixture: Fixture }> = [
  {
    op: salaryRunsEmployeesAdd,
    args: { salary_run_id: SOME_UUID, employee_id: SOME_UUID },
    // Not on the run yet.
    fixture: { empty: ['salary_run_employees'] },
  },
  {
    op: salaryRunsEmployeesRemove,
    args: { salary_run_id: SOME_UUID, employee_id: SOME_UUID },
    fixture: {},
  },
  {
    op: salaryRunsLinesCreate,
    args: { salary_run_id: SOME_UUID, employee_id: SOME_UUID, item_type: 'bonus', description: 'Bonus', amount: 100 },
    fixture: {},
  },
  {
    op: salaryRunsLinesDelete,
    args: { salary_run_id: SOME_UUID, salary_line_item_id: SOME_UUID },
    // The line belongs to this run.
    fixture: { rows: { salary_line_items: { salary_run_employee: { salary_run_id: SOME_UUID } } } },
  },
  {
    op: salaryRunsCorrect,
    args: { salary_run_id: SOME_UUID },
    fixture: {
      rows: {
        salary_runs: { status: 'booked', period_year: 2026, period_month: 5, payment_date: '2026-05-25', salary_entry_id: SOME_UUID },
      },
    },
  },
  {
    op: salaryRunsMarkPaid,
    args: { salary_run_id: SOME_UUID },
    fixture: { rows: { salary_runs: { status: 'approved' } } },
  },
]

describe('salary-run structure dry runs', () => {
  it.each(CASES.map((c) => [c.op.id, c] as const))('%s previews and writes nothing', async (_id, { op, args, fixture }) => {
    const { client, writes } = recordingClient(fixture)
    const input = op.input.parse(args)

    const outcome = await op.run({ supabase: client as never, companyId: COMPANY_ID, userId: USER_ID, log }, input, {
      dryRun: true,
    })

    expect(outcome).toMatchObject({ ok: true, dryRun: true })
    expect(writes).toEqual([])
  })

  it('refuses at the preview what the generic draft row cannot satisfy, still writing nothing', async () => {
    const { client, writes } = recordingClient({})
    const outcome = await salaryRunsMarkPaid.run(
      { supabase: client as never, companyId: COMPANY_ID, userId: USER_ID, log },
      { salary_run_id: SOME_UUID },
      { dryRun: true },
    )
    expect(outcome).toMatchObject({ ok: false, code: 'SALARY_RUN_MARK_PAID_NOT_APPROVED' })
    expect(writes).toEqual([])
  })
})
