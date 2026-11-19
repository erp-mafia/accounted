import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PACKS_DIR } from '../../src/lib/packs/load'

/**
 * Two self-host defaults that only broke inside the container:
 *
 * 1. The booking-template packs (packs/*.yaml) are read off disk at runtime,
 *    relative to process.cwd() (/app in the image). The runner stage copied only
 *    the standalone server, so the nightly booking-template sync refused with
 *    "no packs found" and the MCP booking-packs resource was empty.
 * 2. PERSONNUMMER_ENCRYPTION_KEY is required in production (the image sets
 *    NODE_ENV=production), but docker/setup.sh never wrote one, so storing any
 *    personnummer failed. Generating it is only safe if setup.sh never replaces
 *    a key that already encrypts data: rows sealed with a lost key are gone.
 */
const ROOT = process.cwd()
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8')

describe('docker/Dockerfile: runtime files the app reads off disk', () => {
  const dockerfile = read('docker/Dockerfile')
  const runner = dockerfile.slice(dockerfile.search(/^FROM\s+\S+\s+AS\s+runner\s*$/m))

  it('has a runner stage working in /app', () => {
    expect(runner.length).toBeGreaterThan(0)
    expect(runner).toMatch(/^WORKDIR\s+\/app\s*$/m)
  })

  it(`copies ${PACKS_DIR}/ next to server.js, where the loader looks for it`, () => {
    const copy = new RegExp(
      `^COPY\\s+(?:--\\S+\\s+)*(?:/app/)?${PACKS_DIR}/?\\s+(?:\\./|/app/)${PACKS_DIR}/?\\s*$`,
      'm',
    )
    expect(runner).toMatch(copy)
  })

  it(`does not drop ${PACKS_DIR}/ from the build context`, () => {
    const ignored = read('.dockerignore')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
    const dropsPacks = ignored.filter((line) =>
      [PACKS_DIR, `${PACKS_DIR}/`, `/${PACKS_DIR}`, `/${PACKS_DIR}/`, '*.yaml', '**/*.yaml'].includes(line),
    )
    expect(dropsPacks).toEqual([])
  })
})

describe('docker/setup.sh: PERSONNUMMER_ENCRYPTION_KEY', () => {
  let root = ''

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
    root = ''
  })

  /** A copy of the repo's setup.sh and env template in a throwaway directory, with a stub docker. */
  function sandbox(existingEnv?: string): string {
    root = mkdtempSync(path.join(tmpdir(), 'accounted-setup-'))
    mkdirSync(path.join(root, 'docker'))
    mkdirSync(path.join(root, 'bin'))
    writeFileSync(path.join(root, 'docker', 'setup.sh'), read('docker/setup.sh'))
    writeFileSync(path.join(root, 'docker', '.env.example'), read('docker/.env.example'))
    writeFileSync(path.join(root, 'bin', 'docker'), '#!/bin/sh\nexit 0\n')
    chmodSync(path.join(root, 'bin', 'docker'), 0o755)
    if (existingEnv !== undefined) writeFileSync(path.join(root, '.env'), existingEnv)
    return root
  }

  /** Runs setup.sh, answering the overwrite question (if asked) and leaving every prompt at its default. */
  function runSetup(overwrite?: 'y' | 'n'): string {
    const answers = [...(overwrite ? [overwrite] : []), '', '', '', '']
    execFileSync('sh', [path.join(root, 'docker', 'setup.sh')], {
      input: answers.join('\n') + '\n',
      env: { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH ?? ''}` },
      stdio: 'pipe',
    })
    return readFileSync(path.join(root, '.env'), 'utf8')
  }

  const keyLines = (env: string) => env.split('\n').filter((l) => l.startsWith('PERSONNUMMER_ENCRYPTION_KEY='))

  it('generates a random key on a fresh install', () => {
    sandbox()
    const env = runSetup()
    const lines = keyLines(env)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^PERSONNUMMER_ENCRYPTION_KEY=[0-9a-f]{64}$/)
  })

  it('generates a different key per install', () => {
    sandbox()
    const first = keyLines(runSetup())[0]
    rmSync(root, { recursive: true, force: true })
    sandbox()
    const second = keyLines(runSetup())[0]
    expect(first).not.toEqual(second)
  })

  it('keeps the existing key byte for byte when .env is overwritten', () => {
    // Characters that break a naive sed replacement (&, /, |, backslash).
    const key = 'old+key/with&odd|chars\\and="quotes"'
    sandbox(`CRON_SECRET=x\nPERSONNUMMER_ENCRYPTION_KEY=${key}\n`)
    const env = runSetup('y')
    expect(keyLines(env)).toEqual([`PERSONNUMMER_ENCRYPTION_KEY=${key}`])
  })

  it('leaves an existing .env with a key untouched when it is kept', () => {
    const before = 'CRON_SECRET=x\nPERSONNUMMER_ENCRYPTION_KEY=abc\n'
    sandbox(before)
    expect(runSetup('n')).toBe(before)
  })

  it('adds a key to a kept .env that has none, without changing anything else', () => {
    const before = 'CRON_SECRET=x\nNEXT_PUBLIC_SELF_HOSTED=true\n'
    sandbox(before)
    const env = runSetup('n')
    expect(env.startsWith(before)).toBe(true)
    expect(keyLines(env)).toHaveLength(1)
    expect(keyLines(env)[0]).toMatch(/^PERSONNUMMER_ENCRYPTION_KEY=[0-9a-f]{64}$/)
  })

  it('fills an empty key line instead of adding a second one', () => {
    sandbox('PERSONNUMMER_ENCRYPTION_KEY=\n')
    const env = runSetup('n')
    expect(keyLines(env)).toHaveLength(1)
    expect(keyLines(env)[0]).toMatch(/^PERSONNUMMER_ENCRYPTION_KEY=[0-9a-f]{64}$/)
  })

  it('documents the key in docker/.env.example without a usable placeholder value', () => {
    const lines = keyLines(read('docker/.env.example'))
    // Empty on purpose: a placeholder would be used as a real key by a manual
    // `cp`, and replacing it later makes every stored personnummer unreadable.
    expect(lines).toEqual(['PERSONNUMMER_ENCRYPTION_KEY='])
  })

  it('leaves no temporary files next to .env', () => {
    sandbox('CRON_SECRET=x\n')
    runSetup('n')
    expect(existsSync(path.join(root, '.env.tmp'))).toBe(false)
    expect(existsSync(path.join(root, '.env.bak'))).toBe(false)
  })
})
