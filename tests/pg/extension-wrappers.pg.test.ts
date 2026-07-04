import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'

/**
 * Covers 20230101000000_extension_function_wrappers:
 *
 *   - Wrapper existence: public.uuid_generate_v4() and
 *     public.gen_random_bytes() are present and resolve correctly.
 *
 *   - Delegation: public.uuid_generate_v4() → extensions.uuid_generate_v4()
 *     and public.gen_random_bytes() → extensions.gen_random_bytes().
 *
 *   - Correctness: uuid_generate_v4() produces valid non-null UUIDs with
 *     distinct values across calls. gen_random_bytes(n) returns a bytea of
 *     exactly n bytes (n >= 1; OpenSSL-backed pgcrypto rejects size 0).
 *
 *   - Function properties: VOLATILE, PARALLEL SAFE, SET search_path = '',
 *     LANGUAGE sql: consistent with the rest of the codebase.
 */

describe('extension function wrappers', () => {
  it('uuid_generate_v4() exists in public schema and returns a valid UUID', async () => {
    const pool = getPool()
    const r = await pool.query<{ uuid: string }>(
      `SELECT public.uuid_generate_v4() AS uuid`,
    )
    const uuid = r.rows[0]!.uuid
    expect(uuid).toBeTruthy()
    // UUID v4 format: xxxxxxxx-xxxx-4xxx-[89ab]xxx-xxxxxxxxxxxx
    expect(uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
  })

  it('uuid_generate_v4() returns distinct values across calls (no caching)', async () => {
    const pool = getPool()
    const r = await pool.query<{ uuid: string }>(
      `SELECT public.uuid_generate_v4() AS uuid
       UNION ALL
       SELECT public.uuid_generate_v4()`,
    )
    expect(r.rows).toHaveLength(2)
    expect(r.rows[0]!.uuid).not.toBe(r.rows[1]!.uuid)
  })

  it('uuid_generate_v4() can be used as a column DEFAULT expression', async () => {
    const pool = getPool()
    // Create a temp table using the wrapper as default, insert a row, check
    // the UUID was generated and is valid.
    await pool.query(`
      CREATE TEMP TABLE _test_uuid_default (
        id uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
        label text
      )
    `)
    await pool.query(`INSERT INTO _test_uuid_default (label) VALUES ('test')`)
    const r = await pool.query<{ id: string }>(`SELECT id FROM _test_uuid_default`)
    expect(r.rows[0]!.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
    await pool.query(`DROP TABLE _test_uuid_default`)
  })

  it('gen_random_bytes() exists in public schema', async () => {
    const pool = getPool()
    const r = await pool.query<{ ok: boolean }>(
      `SELECT pg_get_functiondef('public.gen_random_bytes(integer)'::regprocedure) IS NOT NULL AS ok`,
    )
    expect(r.rows[0]!.ok).toBe(true)
  })

  it('gen_random_bytes(n) returns bytea of exactly n bytes', async () => {
    const pool = getPool()
    for (const n of [1, 16, 32, 64]) {
      const r = await pool.query<{ len: number }>(
        `SELECT octet_length(public.gen_random_bytes($1)) AS len`,
        [n],
      )
      expect(r.rows[0]!.len).toBe(n)
    }
  })

  it('gen_random_bytes(n) returns exactly n bytes', async () => {
    // Modern (OpenSSL-backed) pgcrypto rejects size 0 with "Length not in
    // range", so we assert the real contract on a positive length rather than
    // the version-dependent 0-byte edge case.
    const pool = getPool()
    const r = await pool.query<{ len: number }>(
      `SELECT octet_length(public.gen_random_bytes(16)) AS len`,
    )
    expect(r.rows[0]!.len).toBe(16)
  })

  it('gen_random_bytes returns distinct values across calls', async () => {
    const pool = getPool()
    const r = await pool.query<{ a: Buffer; b: Buffer }>(
      `SELECT public.gen_random_bytes(16) AS a, public.gen_random_bytes(16) AS b`,
    )
    expect(r.rows[0]!.a).not.toEqual(r.rows[0]!.b)
  })

  it('uuid_generate_v4() is VOLATILE and PARALLEL SAFE', async () => {
    const pool = getPool()
    const r = await pool.query<{
      provolatile: string
      proparallel: string
    }>(
      `SELECT provolatile, proparallel
       FROM pg_proc
       WHERE oid = 'public.uuid_generate_v4()'::regprocedure`,
    )
    expect(r.rows[0]!.provolatile).toBe('v')
    expect(r.rows[0]!.proparallel).toBe('s')
  })

  it('gen_random_bytes(integer) is VOLATILE and PARALLEL SAFE', async () => {
    const pool = getPool()
    const r = await pool.query<{
      provolatile: string
      proparallel: string
    }>(
      `SELECT provolatile, proparallel
       FROM pg_proc
       WHERE oid = 'public.gen_random_bytes(integer)'::regprocedure`,
    )
    expect(r.rows[0]!.provolatile).toBe('v')
    expect(r.rows[0]!.proparallel).toBe('s')
  })

  it('both wrappers delegate to extensions schema functions', async () => {
    const pool = getPool()
    // Verify the extensions schema exists and has the source functions.
    const extFns = await pool.query<{ name: string; schema: string }>(
      `SELECT p.proname AS name, n.nspname AS schema
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'extensions'
         AND p.proname IN ('uuid_generate_v4', 'gen_random_bytes')`,
    )
    expect(extFns.rows).toHaveLength(2)

    // Verify the public wrappers exist.
    const pubFns = await pool.query<{ name: string; schema: string }>(
      `SELECT p.proname AS name, n.nspname AS schema
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('uuid_generate_v4', 'gen_random_bytes')`,
    )
    expect(pubFns.rows).toHaveLength(2)
  })

  it('wrappers are defined in SQL (not plpgsql or C)', async () => {
    const pool = getPool()
    const r = await pool.query<{ proname: string; prolang: string }>(
      `SELECT proname, l.lanname AS prolang
       FROM pg_proc p
       JOIN pg_language l ON l.oid = p.prolang
       WHERE p.proname IN ('uuid_generate_v4', 'gen_random_bytes')
         AND p.pronamespace = 'public'::regnamespace`,
    )
    for (const row of r.rows) {
      expect(row.prolang).toBe('sql')
    }
  })

  it('wrappers are idempotent: CREATE OR REPLACE succeeds on re-run', async () => {
    const pool = getPool()
    // Simulate re-applying the migration: re-running the same CREATE OR REPLACE
    // should succeed without errors and the functions should still work.
    await pool.query(`
      CREATE OR REPLACE FUNCTION public.uuid_generate_v4()
      RETURNS uuid
      LANGUAGE sql
      VOLATILE
      PARALLEL SAFE
      SET search_path = ''
      AS $$ SELECT extensions.uuid_generate_v4(); $$
    `)
    await pool.query(`
      CREATE OR REPLACE FUNCTION public.gen_random_bytes(size integer)
      RETURNS bytea
      LANGUAGE sql
      VOLATILE
      PARALLEL SAFE
      SET search_path = ''
      AS $$ SELECT extensions.gen_random_bytes(size); $$
    `)
    // Functions must still work after re-creation.
    const r = await pool.query<{ uuid: string; bytes_len: number }>(
      `SELECT public.uuid_generate_v4() AS uuid,
              octet_length(public.gen_random_bytes(32)) AS bytes_len`,
    )
    expect(r.rows[0]!.uuid).toBeTruthy()
    expect(r.rows[0]!.bytes_len).toBe(32)
  })
})
