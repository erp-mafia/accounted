/**
 * A script that loads lib/init stops loudly when it cannot, instead of
 * posting with every event reaching no handler. Until 2026-10-16 every script
 * run under plain tsx did the latter: `server-only` throws outside the
 * react-server condition, lib/init never loaded, and the event bus (which on
 * the server logs a failed load and retries it) let the script carry on.
 *
 * These pin the script contract of scripts/lib/register-init-loader.ts: the
 * condition is checked before the script does anything, a failed load ends
 * the script even when it surfaces inside eventBus.emit(), and the messages
 * name the fix. The last block runs a real script process under tsx, with and
 * without the condition; its fixture lives in an OS temp directory created and
 * deleted here.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resetGlobalSingletons } from '@/lib/global-singleton'
import {
  fatalInitLoader,
  initLoadFailedMessage,
  missingConditionMessage,
  resolvesReactServer,
} from '../register-init-loader'

const ROOT = path.resolve(__dirname, '../../..')

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

/** Stands in for process.exit: records the error and stops the caller. */
function exitSpy() {
  return vi.fn((err: unknown): never => {
    throw new Error(`exited: ${err instanceof Error ? err.message : String(err)}`)
  })
}

describe('resolvesReactServer', () => {
  it('is true when server-only loads, as its empty react-server entry does', () => {
    expect(resolvesReactServer(() => ({}))).toBe(true)
  })

  it('is false when server-only throws, as its default entry does', () => {
    const load = () => {
      throw new Error('This module cannot be imported from a Client Component module.')
    }
    expect(resolvesReactServer(load)).toBe(false)
  })
})

describe('fatalInitLoader', () => {
  it('loads and never calls fail when lib/init loads', async () => {
    const load = vi.fn(async () => {})
    const fail = exitSpy()
    await fatalInitLoader(load, fail)()
    expect(load).toHaveBeenCalledTimes(1)
    expect(fail).not.toHaveBeenCalled()
  })

  it('hands a failed load to fail instead of rejecting into the caller', async () => {
    const cause = new Error('Missing required environment variables: CRON_SECRET')
    const fail = exitSpy()
    await expect(fatalInitLoader(() => Promise.reject(cause), fail)()).rejects.toThrow('exited: Missing required')
    expect(fail).toHaveBeenCalledWith(cause)
  })

  it('ends the script from inside eventBus.emit(), where the server contract would log and dispatch to no handler', async () => {
    vi.resetModules()
    resetGlobalSingletons()
    const { registerInitLoader } = await import('@/lib/initialized')
    const { eventBus } = await import('@/lib/events/bus')
    const cause = new Error('This module cannot be imported from a Client Component module.')
    const fail = exitSpy()
    registerInitLoader(fatalInitLoader(() => Promise.reject(cause), fail))

    await eventBus.emit({
      type: 'period.locked',
      payload: { userId: 'user-1', companyId: 'company-1' },
    } as unknown as Parameters<typeof eventBus.emit>[0])

    expect(fail).toHaveBeenCalledTimes(1)
    expect(fail).toHaveBeenCalledWith(cause)
    resetGlobalSingletons()
  })
})

describe('messages', () => {
  it('names the script and the flag when the condition is missing', () => {
    const message = missingConditionMessage('scripts/undo-year-end-closing.ts')
    expect(message).toContain('scripts/undo-year-end-closing.ts must run under the react-server condition')
    expect(message).toContain('node --import tsx --conditions react-server scripts/undo-year-end-closing.ts')
    expect(message).toContain('npx tsx --conditions react-server scripts/undo-year-end-closing.ts')
    expect(message).toContain('Nothing was done.')
  })

  it('names the cause of a failed load, and the flag only when it is missing', () => {
    const cause = new Error('Missing required environment variables: CRON_SECRET')
    const withCondition = initLoadFailedMessage('scripts/x.ts', cause, true)
    expect(withCondition).toContain('cause: Missing required environment variables: CRON_SECRET')
    expect(withCondition).toContain('the react-server condition is in place')
    expect(withCondition).not.toContain('--conditions react-server')

    const withoutCondition = initLoadFailedMessage('scripts/x.ts', 'server-only', false)
    expect(withoutCondition).toContain('cause: server-only')
    expect(withoutCondition).toContain('node --import tsx --conditions react-server scripts/x.ts')
  })
})

describe('registerScriptInitLoader in a real script process', () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'script-init-loader-'))
  tempDirs.push(fixtureDir)
  const fixture = path.join(fixtureDir, 'fixture-script.ts')
  fs.writeFileSync(
    fixture,
    `import { registerScriptInitLoader } from ${JSON.stringify(path.join(ROOT, 'scripts/lib/register-init-loader.ts'))}
registerScriptInitLoader()
console.log('after-register')
`,
  )

  const run = (nodeArgs: string[]) => {
    const env = { ...process.env }
    delete env.NODE_OPTIONS
    return spawnSync(process.execPath, [...nodeArgs, fixture], { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000 })
  }

  it('exits 1 before doing anything when run under plain tsx, naming the fix', () => {
    const result = run(['--import', 'tsx'])
    expect(result.status).toBe(1)
    expect(result.stdout).not.toContain('after-register')
    expect(result.stderr).toContain('must run under the react-server condition')
    expect(result.stderr).toContain('--conditions react-server')
  }, 60_000)

  it('carries on under --conditions react-server', () => {
    const result = run(['--import', 'tsx', '--conditions', 'react-server'])
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('after-register')
  }, 60_000)
})
