/**
 * Proof that the functiondef-patch guard flags a migration that reads a
 * function's installed definition to patch it, wherever the call stands, and
 * is not fooled by the call named in a comment. Offending fixtures live only
 * in these strings and in an OS temp directory the end-to-end case creates
 * and deletes.
 */
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findFunctiondefPatches, functiondefCallLines, stripSqlComments } from '../functiondef-patch.mjs'

const ROOT = path.resolve(__dirname, '..', '..', '..')

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

describe('functiondef-patch: a function body patched instead of stated', () => {
  it('flags the shape the 19 grandfathered migrations used, inside a DO block', () => {
    const sql = [
      'DO $migration$',
      'DECLARE',
      '  v_def text := pg_get_functiondef(',
      "    'public.widget(uuid)'::regprocedure);",
      'BEGIN',
      "  EXECUTE replace(v_def, 'old', 'new');",
      'END',
      '$migration$;',
    ].join('\n')
    expect(functiondefCallLines(sql)).toEqual([3])
  })

  it('flags a call at top level, in a function body and in an EXECUTE string, any case and spacing', () => {
    const sql = [
      "SELECT PG_GET_FUNCTIONDEF ('public.a()'::regprocedure);",
      'CREATE FUNCTION public.b() RETURNS text LANGUAGE sql AS $fn$',
      "  SELECT pg_catalog.pg_get_functiondef('public.a()'::regprocedure)",
      '$fn$;',
      "DO $$ BEGIN EXECUTE 'SELECT pg_get_functiondef(1)'; END $$;",
    ].join('\n')
    expect(functiondefCallLines(sql)).toEqual([1, 3, 5])
  })

  it('ignores the call named in line and block comments, also inside a dollar-quoted body', () => {
    const sql = [
      '-- 20260703180000 patched this with pg_get_functiondef(fn.oid).',
      '/* outer /* nested pg_get_functiondef( */ still comment pg_get_functiondef( */',
      'DO $$',
      'BEGIN',
      '  -- do not read pg_get_functiondef() here',
      '  PERFORM 1; /* pg_get_functiondef( */',
      'END $$;',
    ].join('\n')
    expect(functiondefCallLines(sql)).toEqual([])
  })

  it('does not treat -- inside a string literal as the start of a comment', () => {
    const sql = "SELECT '--', pg_get_functiondef('public.a()'::regprocedure);"
    expect(functiondefCallLines(sql)).toEqual([1])
    // E'' strings escape with a backslash: \' does not close the literal.
    expect(functiondefCallLines("SELECT E'it\\'s --', pg_get_functiondef(1);")).toEqual([1])
  })

  it('accepts the read-only alternative: hashing prosrc', () => {
    const sql = "SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = 'public.a()'::regprocedure;"
    expect(functiondefCallLines(sql)).toEqual([])
  })

  it('keeps offsets and newlines when it blanks comments', () => {
    const sql = "SELECT 1; -- a comment\n/* two\nlines */ SELECT '--x';\nDO $$ -- c\n$$;"
    const stripped = stripSqlComments(sql)
    expect(stripped).toHaveLength(sql.length)
    expect(stripped.split('\n')).toHaveLength(sql.split('\n').length)
    expect(stripped).not.toMatch(/comment|two|lines \*\/| c\n/)
    expect(stripped).toContain("SELECT '--x';")
  })
})

describe('functiondef-patch: the repository', () => {
  it('finds exactly the grandfathered files, so the frozen set is neither stale nor short', () => {
    const baseline = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'scripts', 'checks', 'antipatterns-baseline.json'), 'utf8'),
    )
    const files = [...new Set(findFunctiondefPatches(ROOT).map((f) => f.file))].sort()
    expect(files).toEqual(baseline.functiondefPatch.files)
    expect(baseline.functiondefPatch.count).toBe(19)
  })

  it('reports file and line for a new migration end to end', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'functiondef-patch-'))
    tempDirs.push(dir)
    fs.mkdirSync(path.join(dir, 'supabase', 'migrations'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'supabase', 'migrations', '20990101000000_patch.sql'),
      "-- header\nDO $$ BEGIN\n  EXECUTE replace(pg_get_functiondef('public.a()'::regprocedure), 'x', 'y');\nEND $$;\n",
    )
    expect(findFunctiondefPatches(dir)).toEqual([{ file: 'supabase/migrations/20990101000000_patch.sql', line: 3 }])
  })
})
