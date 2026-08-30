import { describe, it, expect } from 'vitest'
import { execFileSync, type ExecFileSyncOptions } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The self-host backup/restore scripts are shipped product (docs/SOVEREIGN.md
// tells operators to run them on a schedule), so at least their syntax and
// their refusal paths are checked in CI. Behaviour against a real bucket and
// database is exercised by the operator's first dry run per the runbook.
const DIR = join(__dirname, '..')
const SCRIPTS = ['backup.sh', 'restore.sh']
// A clean environment: none of the BACKUP_* / RESTORE_* variables, so the
// scripts' own guards are what runs. Typed as ProcessEnv (the repo's
// augmentation makes NODE_ENV a required key) so it can be spread into the
// per-test environments below without a cast.
const BARE_PROCESS_ENV: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '', NODE_ENV: 'test' }
const BARE_ENV: ExecFileSyncOptions = { env: BARE_PROCESS_ENV, stdio: 'pipe' }
// Enough environment for backup.sh to get past its required-variable guards;
// nothing here is ever contacted (the tests below stop before any tool runs).
const BACKUP_REQUIRED_ENV: NodeJS.ProcessEnv = {
  ...BARE_PROCESS_ENV,
  BACKUP_DATABASE_URL: 'postgresql://postgres:x@127.0.0.1:1/postgres',
  BACKUP_S3_ENDPOINT: 'https://s3.invalid',
  BACKUP_S3_BUCKET: 'bucket',
  AWS_ACCESS_KEY_ID: 'key',
  AWS_SECRET_ACCESS_KEY: 'secret',
}

function runBash(args: string[], env: NodeJS.ProcessEnv): { status: number; stderr: string } {
  try {
    execFileSync('bash', args, { env, stdio: 'pipe' })
    return { status: 0, stderr: '' }
  } catch (err) {
    return {
      status: (err as { status?: number }).status ?? -1,
      stderr: String((err as { stderr?: Buffer }).stderr ?? ''),
    }
  }
}

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

  it('acl-manifest.sql states every PostgREST role for functions, relations and sequences in public', () => {
    const sql = readFileSync(join(DIR, 'acl-manifest.sql'), 'utf8')
    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect(sql).toContain(`has_function_privilege('${role}'`)
      expect(sql).toContain(`has_table_privilege('${role}'`)
      // Sequences have their own privilege set (USAGE, SELECT, UPDATE) that
      // has_table_privilege does not see; a restore that hands anon nextval
      // on an id sequence must show up in the diff like any other object.
      for (const privilege of ['USAGE', 'SELECT', 'UPDATE']) {
        expect(sql).toContain(`has_sequence_privilege('${role}', c.oid, '${privilege}')`)
      }
    }
    expect(sql).toMatch(/relkind = 'S'/)
    expect(sql).toContain("'public'::regnamespace")
    // Byte-identical output on both sides regardless of database collation.
    expect(sql).toContain('collate "C"')
    // restore.sh shows the mismatching lines by object kind; a sequence line
    // must not be filtered out of that excerpt.
    const restore = readFileSync(join(DIR, 'restore.sh'), 'utf8')
    expect(restore).toContain('(function|relation|sequence) ')
  })

  it('restore.sh does not require RESTORE_DATABASE_URL for the db-config pass (RESTORE_SKIP_DATABASE=1)', () => {
    let status = 0
    let stderr = ''
    try {
      execFileSync('bash', [join(DIR, 'restore.sh'), 'nightly-20260101T000000Z', '--yes'], {
        ...BARE_ENV,
        env: { ...BARE_PROCESS_ENV, RESTORE_SKIP_DATABASE: '1' },
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

  it('backup.sh refuses a quiesce hook without its resume hook, and the reverse, before running anything', () => {
    // A quiesce command with no resume command would leave the operator's app
    // stopped after every run; refusing up front is the only safe answer.
    const quiesceOnly = runBash([join(DIR, 'backup.sh')], { ...BACKUP_REQUIRED_ENV, BACKUP_QUIESCE_CMD: 'true' })
    expect(quiesceOnly.status).toBe(2)
    expect(quiesceOnly.stderr).toContain('BACKUP_QUIESCE_CMD is set but BACKUP_RESUME_CMD is not')
    const resumeOnly = runBash([join(DIR, 'backup.sh')], { ...BACKUP_REQUIRED_ENV, BACKUP_RESUME_CMD: 'true' })
    expect(resumeOnly.status).toBe(2)
    expect(resumeOnly.stderr).toContain('BACKUP_RESUME_CMD is set but BACKUP_QUIESCE_CMD is not')
  })

  it('backup.sh runs the resume hook when the quiesce hook fails part-way', () => {
    // `docker compose stop app cron` can stop `app` and then fail on `cron`;
    // set -e ends the script right there, and the EXIT trap must still run
    // the resume hook or the operator's app stays down after a failed backup.
    // The required tools are stubbed on PATH so the script reaches the hook;
    // none of them is ever executed because the hook fails first.
    const stubs = mkdtempSync(join(tmpdir(), 'accounted-backup-stubs-'))
    try {
      for (const tool of ['pg_dump', 'psql', 'tar', 'gzip', 'aws']) {
        const stub = join(stubs, tool)
        writeFileSync(stub, '#!/bin/sh\nexit 0\n')
        chmodSync(stub, 0o755)
      }
      const marker = join(stubs, 'resumed')
      const result = runBash([join(DIR, 'backup.sh')], {
        ...BACKUP_REQUIRED_ENV,
        PATH: `${stubs}:${process.env.PATH ?? ''}`,
        BACKUP_QUIESCE_CMD: 'exit 3',
        BACKUP_RESUME_CMD: `touch "${marker}"`,
      })
      expect(result.status).not.toBe(0)
      expect(existsSync(marker)).toBe(true)
    } finally {
      rmSync(stubs, { recursive: true, force: true })
    }
  })

  it('backup.sh marks the quiesce attempt before running the hook, not after it succeeds', () => {
    const src = readFileSync(join(DIR, 'backup.sh'), 'utf8')
    const attempted = src.indexOf('QUIESCE_ATTEMPTED=1')
    const hook = src.indexOf('bash -c "$BACKUP_QUIESCE_CMD"')
    expect(attempted).toBeGreaterThan(-1)
    expect(hook).toBeGreaterThan(attempted)
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
