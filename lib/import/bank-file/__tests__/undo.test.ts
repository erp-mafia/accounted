/**
 * Tests for undoBankFileImport (lib/import/bank-file/undo.ts).
 *
 * The RPC itself (owner/admin gate, scoped delete, skip counting) is covered
 * by the pg-real suite (lib/import/__tests__/undo-bank-file-import.pg.test.ts);
 * this file covers the service wrapper: the session-client pre-checks, the
 * RPC error mapping (42501 → forbidden), and the report shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { SupabaseClient } from '@supabase/supabase-js'

// The bulk-delete escalation helper would swap in a service client when
// SUPABASE_SERVICE_ROLE_KEY is set; pin it to the fallback so the queued mock
// observes the rpc call.
vi.mock('@/lib/import/sie-import', () => ({
  rpcClientForBulkDelete: async (fallback: SupabaseClient) => fallback,
}))

import { undoBankFileImport } from '../undo'

const { supabase, enqueue, reset } = createQueuedMockSupabase()
const client = supabase as unknown as SupabaseClient

describe('undoBankFileImport', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
  })

  it('fails with the notFound flag, without calling the RPC, when the import is not found', async () => {
    // PGRST116 is PostgREST's ".single() matched zero rows": the one error
    // code that positively means the row does not exist.
    enqueue({
      data: null,
      error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' },
    })

    const result = await undoBankFileImport(client, 'company-1', 'import-1', 'user-1')

    expect(result.success).toBe(false)
    // The route maps this to 404 BANK_FILE_UNDO_NOT_FOUND (not the generic 400).
    expect(result.notFound).toBe(true)
    expect(result.error).toBe('Importen hittades inte')
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('reports a non-PGRST116 lookup failure as an error, never as notFound (fail closed)', async () => {
    enqueue({
      data: null,
      error: { code: '57014', message: 'canceling statement due to statement timeout' },
    })

    const result = await undoBankFileImport(client, 'company-1', 'import-1', 'user-1')

    expect(result.success).toBe(false)
    // A transient fault must not become a permanent-looking 404.
    expect(result.notFound).toBeUndefined()
    expect(result.error).toMatch(/Kunde inte läsa importen/)
    expect(result.error).toMatch(/statement timeout/)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('fails without calling the RPC when the import is not completed', async () => {
    enqueue({ data: { id: 'import-1', status: 'processing' } })

    const result = await undoBankFileImport(client, 'company-1', 'import-1', 'user-1')

    expect(result.success).toBe(false)
    expect(result.error).toBe('Kan bara ångra slutförda importer (status: processing)')
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('maps the RPC 42501 rejection to forbidden', async () => {
    enqueue({ data: { id: 'import-1', status: 'completed' } })
    enqueue({ data: null, error: { code: '42501', message: 'permission denied' } })

    const result = await undoBankFileImport(client, 'company-1', 'import-1', 'user-1')

    expect(result.success).toBe(false)
    expect(result.forbidden).toBe(true)
  })

  it('surfaces other RPC errors with the message', async () => {
    enqueue({ data: { id: 'import-1', status: 'completed' } })
    enqueue({ data: null, error: { code: 'P0001', message: 'boom' } })

    const result = await undoBankFileImport(client, 'company-1', 'import-1', 'user-1')

    expect(result.success).toBe(false)
    expect(result.forbidden).toBeUndefined()
    expect(result.error).toBe('Kunde inte ångra importen: boom')
  })

  it('returns the deletion report and passes the authorising user to the RPC', async () => {
    enqueue({ data: { id: 'import-1', status: 'completed' } })
    enqueue({
      data: { deleted: 42, skipped_booked: 3, skipped_match_history: 1 },
    })

    const result = await undoBankFileImport(client, 'company-1', 'import-1', 'user-1')

    expect(result).toEqual({
      success: true,
      deletedTransactions: 42,
      skippedBooked: 3,
      skippedMatchHistory: 1,
    })
    expect(supabase.rpc).toHaveBeenCalledWith('undo_bank_file_import', {
      p_company_id: 'company-1',
      p_import_id: 'import-1',
      p_user_id: 'user-1',
    })
  })
})
