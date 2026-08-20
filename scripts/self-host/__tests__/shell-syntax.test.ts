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
  }

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
