import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import type { CloudSchedule } from '../../types'

/**
 * One schedule record (an extension_data row) behind the compare-and-set the
 * way PostgREST runs it: an update matches only while updated_at is the
 * version read, and every write moves it (update_updated_at_column). Shared
 * by the run claim's tests and the schedule route's.
 */
export function scheduleRecordDb(initial: CloudSchedule | null, options: { failRead?: boolean } = {}) {
  let serial = 0
  const stamp = () => `2026-07-12T12:00:00.${String(++serial).padStart(6, '0')}+00:00`
  /** `user_id`: the member the record belongs to (the failure mail goes to them). */
  const row: { value: CloudSchedule | null; updated_at: string; user_id: string } = {
    value: initial,
    updated_at: stamp(),
    user_id: 'owner-before',
  }
  /** `afterRead` runs once a read has been answered: someone writing between a read and a write. */
  const hooks: { afterRead: (() => void) | null } = { afterRead: null }
  const mock = createTableMockSupabase({
    extension_data: (chain) => {
      const update = chain.find((call) => call.method === 'update')
      if (!update) {
        if (options.failRead) return { error: { message: 'connection reset' } }
        const answer = { data: row.value ? { value: row.value, updated_at: row.updated_at } : null }
        hooks.afterRead?.()
        return answer
      }
      const filters = Object.fromEntries(
        chain.filter((call) => call.method === 'eq').map((call) => [call.args[0], call.args[1]])
      )
      if (!row.value || filters.updated_at !== row.updated_at) return { data: [] }
      const written = update.args[0] as { value: CloudSchedule; user_id?: string }
      row.value = written.value
      if (written.user_id !== undefined) row.user_id = written.user_id
      row.updated_at = stamp()
      return { data: [{ updated_at: row.updated_at }] }
    },
  })
  return {
    supabase: mock.supabase as unknown as SupabaseClient,
    mock,
    row,
    hooks,
    /** Someone else writes the record: its version moves. */
    writeElsewhere: (change: Partial<CloudSchedule>) => {
      row.value = { ...(row.value as CloudSchedule), ...change }
      row.updated_at = stamp()
    },
    /** The destination is disconnected: the record is removed. */
    remove: () => {
      row.value = null
      row.updated_at = stamp()
    },
  }
}
