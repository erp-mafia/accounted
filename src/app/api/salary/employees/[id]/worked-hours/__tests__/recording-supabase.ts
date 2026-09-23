/**
 * Supabase mock that records what each query actually did.
 *
 * `createQueuedMockSupabase()` in tests/helpers.ts throws call arguments away,
 * so it cannot tell "the route wrote start_time" apart from "the route silently
 * dropped it": both produce the same 201. The worked-hours bug was exactly that
 * shape (validated, documented, never written), so these tests assert on the
 * payload handed to `.insert()` and on the column list handed to `.select()`.
 *
 * Result queue semantics match createQueuedMockSupabase: one enqueued result is
 * consumed per `.from()` / `.rpc()` call, in order.
 *
 * Not a `*.test.ts` file, so Vitest does not collect it as a suite.
 */
import { vi } from 'vitest'

/** One `.from()` chain, flattened. */
export interface RecordedOp {
  table: string
  /** First data verb seen on the chain: select / insert / update / upsert / delete. */
  verb: string
  /** Column list passed to `.select('...')`, if any. */
  columns: string | null
  /** Payload passed to `.insert()` / `.update()` / `.upsert()`, if any. */
  payload: Record<string, unknown> | null
}

const DATA_VERBS = new Set(['select', 'insert', 'update', 'upsert', 'delete'])

export function createRecordingSupabase() {
  const queue: { data: unknown; error: unknown }[] = []
  const ops: RecordedOp[] = []

  const enqueue = (result: { data?: unknown; error?: unknown } = {}) => {
    queue.push({ data: result.data ?? null, error: result.error ?? null })
  }

  const reset = () => {
    queue.length = 0
    ops.length = 0
  }

  const buildChain = (op: RecordedOp, result: { data: unknown; error: unknown }): unknown =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) => resolve(result)
          }
          const name = String(prop)
          return (...args: unknown[]) => {
            if (DATA_VERBS.has(name)) {
              if (op.verb === '') op.verb = name
              if (name === 'select' && typeof args[0] === 'string') {
                op.columns = args[0]
              }
              if (
                (name === 'insert' || name === 'update' || name === 'upsert') &&
                args[0] !== undefined
              ) {
                op.payload = args[0] as Record<string, unknown>
              }
            }
            return buildChain(op, result)
          }
        },
      },
    )

  const start = (table: string): unknown => {
    const op: RecordedOp = { table, verb: '', columns: null, payload: null }
    ops.push(op)
    return buildChain(op, queue.shift() ?? { data: null, error: null })
  }

  const supabase = {
    from: vi.fn((table: string) => start(table)),
    rpc: vi.fn((fn: string) => start(`rpc:${fn}`)),
    auth: { getUser: vi.fn() },
  }

  /** Payloads of every recorded insert, in call order. */
  const insertedRows = () =>
    ops.filter((op) => op.verb === 'insert' && op.payload).map((op) => op.payload!)

  /** Column lists of every recorded read (select-first chains), in call order. */
  const selectedColumns = () =>
    ops.filter((op) => op.verb === 'select').map((op) => op.columns)

  return { supabase, enqueue, reset, ops, insertedRows, selectedColumns }
}
