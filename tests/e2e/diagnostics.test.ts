import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'

it.each(['postgres://[broken', 'postgres://role:bad%ZZ@localhost/postgres'])(
  'keeps diagnostics available with malformed connection value %s', value => {
    const directory = mkdtempSync(path.join(tmpdir(), 'accounted-diagnostics-'))
    try {
      const scripts = path.join(directory, 'scripts/e2e')
      mkdirSync(scripts, { recursive: true })
      mkdirSync(path.join(directory, '.e2e'))
      mkdirSync(path.join(directory, 'bin'))
      for (const name of ['diagnostics.mjs', 'runtime.mjs']) {
        copyFileSync(path.resolve('scripts/e2e', name), path.join(scripts, name))
      }
      writeFileSync(path.join(directory, '.e2e/db.env'), `DATABASE_URL=${value}\n`, { mode: 0o600 })
      // No real container engine is called by this failure-path regression.
      writeFileSync(path.join(directory, 'bin/podman'), '#!/bin/sh\nexit 1\n', { mode: 0o700 })
      const result = spawnSync(process.execPath, [path.join(scripts, 'diagnostics.mjs')], {
        env: { PATH: path.join(directory, 'bin'), NODE_ENV: 'test' }, encoding: 'utf8', timeout: 5000,
      })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      expect(result.stderr).toBe('')
      expect(result.stdout).not.toContain(value)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  },
)
