/**
 * Regression suite for saveMappings (P0, 2026-07-26).
 *
 * The bug: after the 2026-03-30 multi-tenant refactor added company_id to
 * sie_account_mappings, saveMappings() built its upsert payload WITHOUT
 * user_id. That column is NOT NULL with no default and no BEFORE INSERT
 * trigger, and PostgREST sends an upsert as INSERT ... ON CONFLICT DO UPDATE
 * (NOT NULL is checked on the proposed tuple before conflict resolution), so
 * every row was rejected with 23502 on both the insert and the update path.
 * The function then discarded the result instead of destructuring { error },
 * and supabase-js does not throw on Postgres errors, so 834 imports between
 * 2026-03-30 and 2026-07-26 reported success while persisting zero mappings.
 *
 * These tests therefore assert on the ACTUAL upsert payload. The shared queued
 * mock is a Proxy that discards call arguments, so it cannot see a missing
 * column: that blindness is exactly what let the bug survive four months.
 */
import { describe, it, expect } from 'vitest'
import { saveMappings } from '../sie-import'
import type { AccountMapping } from '../types'
import type { SupabaseClient } from '@supabase/supabase-js'

type UpsertCall = {
  table: string
  rows: Record<string, unknown>[]
  options: { onConflict?: string } | undefined
}

/**
 * Supabase double that records every upserted row verbatim.
 *
 * `sessionUserId` mirrors a cookie-session client (auth.getUser() resolves a
 * user); pass null for the cookieless service-role clients the API-key/MCP
 * paths use, where auth.uid() is NULL and there is no session to read.
 * `upsertError` mirrors a Postgres rejection: supabase-js returns it in the
 * result envelope and never throws.
 */
function createRecordingSupabase(options?: {
  sessionUserId?: string | null
  upsertError?: { code: string; message: string }
  failOnCall?: number
}) {
  const upserts: UpsertCall[] = []
  const sessionUserId = options?.sessionUserId ?? null
  const failOnCall = options?.failOnCall ?? 1

  const supabase = {
    auth: {
      getUser: async () => ({
        data: { user: sessionUserId ? { id: sessionUserId } : null },
        error: null,
      }),
    },
    from: (table: string) => ({
      upsert: async (
        rows: Record<string, unknown>[],
        upsertOptions?: { onConflict?: string },
      ) => {
        upserts.push({ table, rows, options: upsertOptions })
        const shouldFail = options?.upsertError && upserts.length === failOnCall
        return { data: null, error: shouldFail ? options.upsertError : null }
      },
    }),
  }

  return { supabase: supabase as unknown as SupabaseClient, upserts }
}

function makeMapping(
  source: string,
  target: string,
  overrides?: Partial<AccountMapping>,
): AccountMapping {
  return {
    sourceAccount: source,
    sourceName: `Konto ${source}`,
    targetAccount: target,
    targetName: `BAS ${target}`,
    confidence: 1,
    matchType: 'exact',
    isOverride: false,
    ...overrides,
  }
}

describe('saveMappings: the row that actually reaches Postgres', () => {
  it('writes both company_id and user_id into every mapping row', async () => {
    const { supabase, upserts } = createRecordingSupabase()

    await saveMappings(
      supabase,
      'company-1',
      [makeMapping('1910', '1930')],
      'user-1',
    )

    expect(upserts).toHaveLength(1)
    expect(upserts[0].table).toBe('sie_account_mappings')
    // Full column set, not toMatchObject: a missing NOT NULL column is the bug
    // being pinned, and toMatchObject cannot see an absent key. id, created_at
    // and updated_at are deliberately absent (DB default / trigger).
    expect(upserts[0].rows).toEqual([
      {
        user_id: 'user-1',
        company_id: 'company-1',
        source_account: '1910',
        source_name: 'Konto 1910',
        target_account: '1930',
        confidence: 1,
        match_type: 'exact',
      },
    ])
    expect(upserts[0].options?.onConflict).toBe('company_id,source_account')
  })

  it('keeps user_id distinct from company_id', async () => {
    // Both are UUID strings, so the compiler cannot tell them apart: this is
    // the same class of mistake that once put a user id in company_id.
    const { supabase, upserts } = createRecordingSupabase()

    await saveMappings(supabase, 'company-1', [makeMapping('1910', '1930')], 'user-1')

    expect(upserts[0].rows[0].company_id).toBe('company-1')
    expect(upserts[0].rows[0].user_id).toBe('user-1')
    expect(upserts[0].rows[0].user_id).not.toBe(upserts[0].rows[0].company_id)
  })

  it('stamps user_id on every row of every batch past the 100-row chunk', async () => {
    const { supabase, upserts } = createRecordingSupabase()
    const mappings = Array.from({ length: 250 }, (_, i) =>
      makeMapping(String(4000 + i), String(4000 + i)),
    )

    await saveMappings(supabase, 'company-1', mappings, 'user-1')

    expect(upserts).toHaveLength(3)
    expect(upserts.map((u) => u.rows.length)).toEqual([100, 100, 50])
    for (const call of upserts) {
      for (const row of call.rows) {
        expect(row.user_id).toBe('user-1')
        expect(row.company_id).toBe('company-1')
      }
    }
  })

  it('skips unmapped accounts but still stamps the ones it keeps', async () => {
    const { supabase, upserts } = createRecordingSupabase()

    await saveMappings(
      supabase,
      'company-1',
      [
        makeMapping('1910', '1930'),
        makeMapping('9999', '', { targetName: '', confidence: 0, matchType: 'manual' }),
      ],
      'user-1',
    )

    expect(upserts[0].rows).toHaveLength(1)
    expect(upserts[0].rows[0].source_account).toBe('1910')
    expect(upserts[0].rows[0].user_id).toBe('user-1')
  })

  it('does not touch the table when nothing is mapped', async () => {
    const { supabase, upserts } = createRecordingSupabase()

    await saveMappings(
      supabase,
      'company-1',
      [makeMapping('9999', '', { confidence: 0, matchType: 'manual' })],
      'user-1',
    )

    expect(upserts).toHaveLength(0)
  })
})

describe('saveMappings: failures are surfaced, never swallowed', () => {
  it('throws when the upsert is rejected by Postgres', async () => {
    // supabase-js resolves with { error } instead of throwing. The old code
    // never destructured it, so this exact rejection was invisible.
    const { supabase } = createRecordingSupabase({
      upsertError: { code: '23502', message: 'null value in column "user_id"' },
    })

    await expect(
      saveMappings(supabase, 'company-1', [makeMapping('1910', '1930')], 'user-1'),
    ).rejects.toThrow(/kunde inte spara kontomappningar/i)
  })

  it('reports how many rows landed before the failing batch', async () => {
    const { supabase } = createRecordingSupabase({
      upsertError: { code: '23503', message: 'violates foreign key constraint' },
      failOnCall: 2,
    })
    const mappings = Array.from({ length: 150 }, (_, i) =>
      makeMapping(String(4000 + i), String(4000 + i)),
    )

    await expect(
      saveMappings(supabase, 'company-1', mappings, 'user-1'),
    ).rejects.toThrow(/100 av 150/)
  })

  it('resolves quietly when every batch succeeds', async () => {
    const { supabase, upserts } = createRecordingSupabase()

    await expect(
      saveMappings(supabase, 'company-1', [makeMapping('1910', '1930')], 'user-1'),
    ).resolves.toBeUndefined()
    expect(upserts).toHaveLength(1)
  })
})

describe('saveMappings: where user_id comes from', () => {
  it('prefers the explicitly passed userId over the session', async () => {
    // executeSIEImport and the MCP/API-key paths must win: their client is
    // often a cookieless service client whose session would resolve to nobody.
    const { supabase, upserts } = createRecordingSupabase({ sessionUserId: 'session-user' })

    await saveMappings(supabase, 'company-1', [makeMapping('1910', '1930')], 'explicit-user')

    expect(upserts[0].rows[0].user_id).toBe('explicit-user')
  })

  it('falls back to the session user when the caller omits userId', async () => {
    // The POST /api/import/sie/mappings handler still calls with three
    // arguments; its client is the cookie-session server client, so the
    // fallback resolves a real user there.
    const { supabase, upserts } = createRecordingSupabase({ sessionUserId: 'session-user' })

    await saveMappings(supabase, 'company-1', [makeMapping('1910', '1930')])

    expect(upserts[0].rows[0].user_id).toBe('session-user')
  })

  it('refuses to upsert at all when no user id can be resolved', async () => {
    // Better a loud failure than a 23502 the caller cannot see: user_id is
    // NOT NULL, so there is no row to write here.
    const { supabase, upserts } = createRecordingSupabase({ sessionUserId: null })

    await expect(
      saveMappings(supabase, 'company-1', [makeMapping('1910', '1930')]),
    ).rejects.toThrow(/user_id saknas/i)
    expect(upserts).toHaveLength(0)
  })
})
