import { describe, it, expect } from 'vitest'
import { execFileSync, type ExecFileSyncOptions } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The self-host backup/restore scripts are shipped product (docs/SOVEREIGN.md
// tells operators to run them on a schedule), so at least their syntax and
// their refusal paths are checked in CI. Behaviour against a real bucket and
// database is exercised by the operator's first dry run per the runbook.
const DIR = join(__dirname, '..')
const SCRIPTS = ['backup.sh', 'restore.sh']
// A clean environment: none of the BACKUP_* / RESTORE_* variables, so the
// scripts' own guards are what runs.
const BARE_ENV: ExecFileSyncOptions = { env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test' }, stdio: 'pipe' }

describe('self-host shell scripts', () => {
  for (const name of SCRIPTS) {
    it(`${name} parses under bash -n`, () => {
      expect(() => execFileSync('bash', ['-n', join(DIR, name)])).not.toThrow()
    })

    it(`${name} sets strict mode and a private umask`, () => {
      const src = readFileSync(join(DIR, name), 'utf8')
      expect(src).toContain('set -euo pipefail')
      expect(src).toContain('umask 077')
    })

    it(`${name} keeps ACLs in the dump (no --no-privileges), drops ownership (--no-owner), uses the ACL manifest`, () => {
      // The migrations REVOKE hardened SECURITY DEFINER RPCs from anon and
      // authenticated (REVOKE ... FROM PUBLIC, anon; GRANT ... TO service_role).
      // --no-privileges would strip that from the dump and a restored self-host
      // would re-expose those RPCs over PostgREST; --no-owner is what lets the
      // dump land in a stack whose roles were created by that stack.
      const src = readFileSync(join(DIR, name), 'utf8')
      // The invocation lines, not the comments that explain them.
      const commands = src.split('\n').filter((line) => /^\s*pg_(dump|restore) /.test(line))
      expect(commands.length).toBeGreaterThan(0)
      for (const command of commands) {
        expect(command).toContain('--no-owner')
        expect(command).not.toContain('--no-privileges')
      }
      expect(src).toContain('acl-manifest.sql')
    })
  }

  it('restore.sh neutralizes the restoring role default privileges before pg_restore and diffs the ACL manifest after it', () => {
    // pg_dump writes ACLs as a diff against acldefault(), so the dump never
    // says "REVOKE FROM anon"; a Supabase target's ALTER DEFAULT PRIVILEGES
    // would hand anon EXECUTE back to every restored function unless those
    // defaults are removed first. The manifest diff is what makes a restore
    // that lost the hardening fail instead of pass silently.
    const src = readFileSync(join(DIR, 'restore.sh'), 'utf8')
    const neutralize = src.indexOf('ALTER DEFAULT PRIVILEGES')
    const restore = src.indexOf('pg_restore --clean')
    const check = src.lastIndexOf('acl-manifest.sql')
    expect(neutralize).toBeGreaterThan(-1)
    expect(restore).toBeGreaterThan(neutralize)
    expect(check).toBeGreaterThan(restore)
    // Exactly the built-in default, not "no grants at all": a global entry
    // that took EXECUTE on functions away from PUBLIC gets it back, otherwise
    // a function the source never touched (NULL ACL, PUBLIC-executable)
    // restores as non-executable.
    expect(src).toContain('TO PUBLIC')
    expect(src).toContain('ACL MISMATCH')
  })

  it('acl-manifest.sql states every PostgREST role for functions and relations in public', () => {
    const sql = readFileSync(join(DIR, 'acl-manifest.sql'), 'utf8')
    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect(sql).toContain(`has_function_privilege('${role}'`)
      expect(sql).toContain(`has_table_privilege('${role}'`)
    }
    expect(sql).toContain("'public'::regnamespace")
    // Byte-identical output on both sides regardless of database collation.
    expect(sql).toContain('collate "C"')
  })

  it('restore.sh does not require RESTORE_DATABASE_URL for the db-config pass (RESTORE_SKIP_DATABASE=1)', () => {
    let status = 0
    let stderr = ''
    try {
      execFileSync('bash', [join(DIR, 'restore.sh'), 'nightly-20260101T000000Z', '--yes'], {
        ...BARE_ENV,
        env: { ...(BARE_ENV.env as Record<string, string>), RESTORE_SKIP_DATABASE: '1' },
      })
    } catch (err) {
      status = (err as { status?: number }).status ?? -1
      stderr = String((err as { stderr?: Buffer }).stderr ?? '')
    }
    expect(status).not.toBe(0)
    expect(stderr).not.toContain('RESTORE_DATABASE_URL')
    expect(stderr).toContain('BACKUP_S3_ENDPOINT is required')
  })

  it('backup.sh refuses to run without the required environment', () => {
    let status = 0
    try {
      execFileSync('bash', [join(DIR, 'backup.sh')], BARE_ENV)
    } catch (err) {
      status = (err as { status?: number }).status ?? -1
    }
    expect(status).not.toBe(0)
  })

  it('restore.sh rejects a backup name with shell metacharacters before doing anything', () => {
    let status = 0
    let stderr = ''
    try {
      execFileSync('bash', [join(DIR, 'restore.sh'), 'nightly-2026; rm -rf /', '--yes'], BARE_ENV)
    } catch (err) {
      status = (err as { status?: number }).status ?? -1
      stderr = String((err as { stderr?: Buffer }).stderr ?? '')
    }
    expect(status).toBe(2)
    expect(stderr).toContain('invalid backup name')
  })

  it('neither script runs a shell inside the docker helper container', () => {
    // `docker run ... sh -c "<string with ${NAME}>"` would let a crafted
    // backup name execute inside the container; tar must get the path as a
    // direct argument. (The operator-supplied quiesce/resume hooks in
    // backup.sh run through bash on the host by design; they are config.)
    const dockerShell = /docker run[^\n]*(\\\n[^\n]*)*?\bsh -c/
    expect(readFileSync(join(DIR, 'restore.sh'), 'utf8')).not.toMatch(dockerShell)
    expect(readFileSync(join(DIR, 'backup.sh'), 'utf8')).not.toMatch(dockerShell)
  })

  it('restore.sh refuses to run without --yes', () => {
    let status = 0
    let stderr = ''
    try {
      execFileSync('bash', [join(DIR, 'restore.sh'), 'nightly-20260101T000000Z'], BARE_ENV)
    } catch (err) {
      status = (err as { status?: number }).status ?? -1
      stderr = String((err as { stderr?: Buffer }).stderr ?? '')
    }
    expect(status).toBe(2)
    expect(stderr).toContain('--yes')
  })
})
