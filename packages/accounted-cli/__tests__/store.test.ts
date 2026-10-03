import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AuthError, UnavailableError } from '../lib/errors.mjs'
import { createStore } from '../lib/store.mjs'
import { ORIGIN, tempDir } from './helpers'

const credentials = (token = 'gnubok_sk_aaaaaaaaaaaaaaaa') => ({
  access_token: token,
  refresh_token: 'gnubok_rt_1',
  token_endpoint: `${ORIGIN}/api/mcp-oauth/token`,
  issuer: ORIGIN,
  scope: 'invoices:read invoices:write',
  created_at: '2026-10-02T10:00:00.000Z',
  updated_at: '2026-10-02T10:00:00.000Z',
})

const posix = process.platform !== 'win32'
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0

let tmp: ReturnType<typeof tempDir>
let dir: string

beforeEach(() => {
  tmp = tempDir()
  dir = path.join(tmp.dir, 'accounted')
})

afterEach(() => {
  try {
    fs.chmodSync(tmp.dir, 0o700)
  } catch {
    // Already writable.
  }
  tmp.cleanup()
})

describe('credentials file', () => {
  it('stores one sign-in per server and reads it back', async () => {
    const store = createStore({ dir })
    expect(await store.read(ORIGIN)).toBeNull()
    await store.write(ORIGIN, credentials())
    await store.write('http://localhost:3000', credentials('gnubok_sk_local'))
    expect(await store.read(ORIGIN)).toEqual(credentials())
    expect((await store.read('http://localhost:3000'))?.access_token).toBe('gnubok_sk_local')
  })

  it.runIf(posix)('keeps the file readable only by the user', async () => {
    const store = createStore({ dir })
    await store.write(ORIGIN, credentials())
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
    expect(fs.statSync(store.file).mode & 0o777).toBe(0o600)
    expect(fs.readdirSync(dir)).toEqual(['credentials.json'])
  })

  it('removes one server and deletes the file with the last one', async () => {
    const store = createStore({ dir })
    await store.write(ORIGIN, credentials())
    await store.write('http://localhost:3000', credentials('gnubok_sk_local'))
    expect((await store.remove(ORIGIN))?.access_token).toBe('gnubok_sk_aaaaaaaaaaaaaaaa')
    expect(await store.read(ORIGIN)).toBeNull()
    expect(fs.existsSync(store.file)).toBe(true)
    await store.remove('http://localhost:3000')
    expect(fs.existsSync(store.file)).toBe(false)
    expect(await store.remove(ORIGIN)).toBeNull()
  })

  it('refuses a damaged file or one from a newer CLI instead of overwriting it', async () => {
    const store = createStore({ dir })
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(store.file, '{not json')
    await expect(store.read(ORIGIN)).rejects.toThrow(AuthError)
    fs.writeFileSync(store.file, JSON.stringify({ version: 99, servers: {} }))
    await expect(store.read(ORIGIN)).rejects.toThrow(/newer version/)
  })

  it('retries a rename that Windows refuses while a scanner holds the file', async () => {
    let failures = 2
    const flakyFs = {
      ...fs,
      renameSync: (from: fs.PathLike, to: fs.PathLike) => {
        if (failures-- > 0) throw Object.assign(new Error('busy'), { code: 'EPERM' })
        return fs.renameSync(from, to)
      },
    } as typeof fs
    const store = createStore({ dir, fs: flakyFs, sleep: async () => {} })
    await store.write(ORIGIN, credentials())
    expect(await store.read(ORIGIN)).toEqual(credentials())
    expect(fs.readdirSync(dir)).toEqual(['credentials.json'])
  })

  it.runIf(posix && !isRoot)('says so before a sign-in when the directory cannot be written', async () => {
    fs.chmodSync(tmp.dir, 0o500)
    const store = createStore({ dir })
    await expect(store.ensureWritable()).rejects.toThrow(/Cannot save the sign-in/)
  })
})

describe('refresh lock', () => {
  it('makes a second holder wait until the first releases', async () => {
    const store = createStore({ dir, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) })
    const release = await store.lock()
    let secondHolds = false
    const second = store.lock().then((r) => {
      secondHolds = true
      return r
    })
    await new Promise((r) => setTimeout(r, 30))
    expect(secondHolds).toBe(false)
    release()
    const releaseSecond = await second
    expect(secondHolds).toBe(true)
    releaseSecond()
  })

  it('breaks a lock whose process is gone', async () => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'credentials.lock'), JSON.stringify({ pid: 999_999 }))
    const store = createStore({ dir, isAlive: () => false })
    const release = await store.lock()
    release()
    expect(fs.existsSync(path.join(dir, 'credentials.lock'))).toBe(false)
  })

  it('gives up on a lock that a live process keeps holding', async () => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'credentials.lock'), JSON.stringify({ pid: 4242 }))
    let clock = 0
    const store = createStore({
      dir,
      isAlive: () => true,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
    })
    await expect(store.lock(1000)).rejects.toThrow(UnavailableError)
    expect(fs.existsSync(path.join(dir, 'credentials.lock'))).toBe(true)
  })

  it('treats a lock that is still being written as held for a moment', async () => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'credentials.lock'), '')
    let clock = 0
    const store = createStore({
      dir,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
    })
    const release = await store.lock()
    // Broken only after waiting about five seconds.
    expect(clock).toBeGreaterThanOrEqual(5000)
    release()
  })
})
