/**
 * The pg coverage gate, run for real in a git repository the test creates:
 * a comment-only edit of a migration passes, any change to its SQL does not.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const GATE = path.resolve(process.cwd(), 'scripts/check-pg-test-coverage.mjs')
const MIGRATION = 'supabase/migrations/20260101000000_f.sql'
const ORIGINAL = [
  '-- Adds f().',
  '-- An older note.',
  'CREATE FUNCTION public.f() RETURNS int LANGUAGE sql AS $$',
  '  -- inside the body',
  '  SELECT 1;',
  '$$;',
  '',
].join('\n')

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

function git(root: string, ...args: string[]) {
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd: root, stdio: 'pipe' })
}

/** A repository with ORIGINAL on `main` and `files` committed on a branch; returns the gate's result there. */
function runGate(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-gate-'))
  tempDirs.push(root)
  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), content)
  }
  git(root, 'init', '-q', '-b', 'main')
  write(MIGRATION, ORIGINAL)
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'base')
  git(root, 'checkout', '-q', '-b', 'change')
  for (const [file, content] of Object.entries(files)) write(file, content)
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'change')
  const result = spawnSync('node', [GATE], { cwd: root, encoding: 'utf8', env: { ...process.env, PG_GATE_BASE: 'main' } })
  return { status: result.status, out: `${result.stdout}${result.stderr}` }
}

describe('pg coverage gate', () => {
  it('passes a migration whose comments were reworded or removed', () => {
    const edited = ORIGINAL.replace('-- Adds f().', '-- Adds the function f.').replace('-- An older note.\n', '')
    const { status, out } = runGate({ [MIGRATION]: edited })
    expect(out).toContain('1 migration(s) differ from the base in comments only')
    expect(status).toBe(0)
  })

  it('fails when the SQL of an existing function migration changes', () => {
    const { status, out } = runGate({ [MIGRATION]: ORIGINAL.replace('SELECT 1;', 'SELECT 2;') })
    expect(status).toBe(1)
    expect(out).toContain(MIGRATION)
  })

  it('fails when a comment inside the function body changes: the body is the stored source', () => {
    const { status } = runGate({ [MIGRATION]: ORIGINAL.replace('-- inside the body', '-- reworded') })
    expect(status).toBe(1)
  })

  it('does not read a commented-out function as a comment-only edit', () => {
    const { status, out } = runGate({ [MIGRATION]: ORIGINAL.split('\n').map((l) => (l ? `-- ${l}` : l)).join('\n') })
    expect(out).not.toContain('differ from the base in comments only')
    // Nothing risky is left in the file, so the gate has nothing to ask a test for.
    expect(status).toBe(0)
  })

  it('still asks for a test when a new function migration rides along with a comment edit', () => {
    const added = 'supabase/migrations/20260102000000_g.sql'
    const { status, out } = runGate({
      [MIGRATION]: ORIGINAL.replace('-- Adds f().', '-- Adds the function f.'),
      [added]: 'CREATE FUNCTION public.g() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;\n',
    })
    expect(status).toBe(1)
    expect(out).toContain(added)
    expect(out).not.toContain(`  ${MIGRATION}  (`)
  })

  it('passes a changed function migration that comes with a pg test, as before', () => {
    const { status } = runGate({
      [MIGRATION]: ORIGINAL.replace('SELECT 1;', 'SELECT 2;'),
      'tests/pg/f.pg.test.ts': '// test\n',
    })
    expect(status).toBe(0)
  })
})
