/**
 * insertStagedOperation (the v1 stage mode and the grant actions) stamps the
 * trace id of the request that staged the operation (migration
 * 20261109090000), names no trace outside a request scope, and stages without
 * it while the column is not there yet.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'
import { runWithTrace } from '@/lib/observability/trace-context-node'
import { insertStagedOperation, type StagedOperationInsert } from '../stage'

const COMPANY = '11111111-1111-4111-8111-111111111111'
const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736'
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() } as never

const insertEcho: TableMockResolver = (calls) => {
  const insert = calls.find((c) => c.method === 'insert')
  if (!insert) return { data: null }
  return { data: { id: 'op-1', ...(insert.args[0] as Record<string, unknown>) } }
}

const INPUT: StagedOperationInsert = {
  companyId: COMPANY,
  userId: 'user-1',
  operationType: 'create_supplier',
  title: 'Skapa leverantör',
  params: { name: 'Acme AB' },
  previewData: { name: 'Acme AB' },
  actor: { type: 'api_key', id: 'key-1', label: 'Live Key' },
}

function stage() {
  const mock = createTableMockSupabase({ pending_operations: insertEcho })
  return { mock, run: () => insertStagedOperation(mock.supabase as unknown as SupabaseClient, INPUT, log) }
}

describe('insertStagedOperation trace id', () => {
  beforeEach(() => vi.clearAllMocks())

  it('stamps the trace id of the staging request', async () => {
    const { mock, run } = stage()
    const { row } = await runWithTrace(TRACE_ID, run)
    expect(mock.payloads('pending_operations', 'insert')).toEqual([
      expect.objectContaining({ company_id: COMPANY, operation_type: 'create_supplier', trace_id: TRACE_ID }),
    ])
    expect(row).toMatchObject({ id: 'op-1', trace_id: TRACE_ID })
  })

  it('does not name the column outside a request scope', async () => {
    const { mock, run } = stage()
    await run()
    const payloads = mock.payloads('pending_operations', 'insert')
    expect(payloads).toHaveLength(1)
    expect(payloads[0]).not.toHaveProperty('trace_id')
  })

  it('stages without the trace while the column is missing (code live before the migration)', async () => {
    const mock = createTableMockSupabase({
      pending_operations: (calls) => {
        const payload = calls.find((c) => c.method === 'insert')?.args[0] as Record<string, unknown> | undefined
        if (payload && 'trace_id' in payload) {
          return { data: null, error: { code: 'PGRST204', message: "Could not find the 'trace_id' column of 'pending_operations' in the schema cache" } }
        }
        return insertEcho(calls)
      },
    })
    const { row } = await runWithTrace(TRACE_ID, () =>
      insertStagedOperation(mock.supabase as unknown as SupabaseClient, INPUT, log),
    )
    expect(row).toMatchObject({ id: 'op-1', company_id: COMPANY, operation_type: 'create_supplier' })
    const payloads = mock.payloads('pending_operations', 'insert')
    expect(payloads).toHaveLength(2)
    expect(payloads[0]).toMatchObject({ trace_id: TRACE_ID })
    expect(payloads[1]).not.toHaveProperty('trace_id')
  })
})
