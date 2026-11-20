import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { getClient } from '@/tests/pg/setup'
import { stripSqlComments } from '@/scripts/checks/functiondef-patch.mjs'

/**
 * Covers 20261012100100_restate_patched_functions: the repository holds the
 * code that runs.
 *
 * Each function that migration restates is installed exactly as written in
 * the file: pg_get_functiondef equals its block byte for byte. A function a
 * LATER migration redefines (CREATE, ALTER or DROP FUNCTION) is skipped, since
 * that later file then holds its code; a legitimate change never has to touch
 * this test.
 */

const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'supabase', 'migrations')
const MIGRATION = '20261012100100_restate_patched_functions.sql'

// Every block is pg_get_functiondef output: the header, `AS $function$`, the
// body (which cannot contain the delimiter) and `$function$` plus a newline.
const BLOCK_RE = /^CREATE OR REPLACE FUNCTION public\.([a-z_][a-z0-9_]*)\([\s\S]*?^AS \$function\$[\s\S]*?\$function\$\n/gm

const restated = [...fs.readFileSync(path.join(MIGRATIONS_DIR, MIGRATION), 'utf8').matchAll(BLOCK_RE)].map(
  (m) => ({ name: m[1]!, definition: m[0] }),
)

const laterMigrations = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql') && f > MIGRATION)
  .map((f) => stripSqlComments(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8')))

const redefinedLater = (name: string) => {
  const re = new RegExp(
    String.raw`\b(?:create\s+(?:or\s+replace\s+)?|alter\s+|drop\s+)function\s+(?:if\s+exists\s+)?(?:"?public"?\s*\.\s*)?"?${name}"?\s*\(`,
    'i',
  )
  return laterMigrations.some((sql) => re.test(sql))
}

describe('20261012100100_restate_patched_functions', () => {
  it('restates the 20 functions that existed only as patches', () => {
    expect(restated).toHaveLength(20)
    expect(new Set(restated.map((f) => f.name)).size).toBe(20)
  })

  it.each(restated.filter((f) => !redefinedLater(f.name)))(
    'public.$name is installed exactly as the migration states it',
    async ({ name, definition }) => {
      const client = await getClient()
      try {
        await client.query('BEGIN')
        // pg_get_functiondef prints a type unqualified when it is visible on
        // the search_path (RETURNS company_inboxes), as it was when the
        // definitions were taken.
        await client.query('SET LOCAL search_path TO public')
        const { rows } = await client.query<{ definition: string }>(
          `SELECT pg_get_functiondef(p.oid) AS definition
             FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace
              AND p.proname = $1`,
          [name],
        )
        expect(rows.map((r) => r.definition)).toEqual([definition])
      } finally {
        await client.query('ROLLBACK')
        client.release()
      }
    },
  )
})
