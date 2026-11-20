/**
 * whenInitialized() waits for the loader of lib/init that the process
 * registered (instrumentation.ts under Next.js, registerInitLoader() in a
 * script or test suite). These pin the loader contract: one load however many
 * callers race for it, a failed load retried by the next caller, no loader
 * meaning "resolve without initialising and warn once", a background start
 * that never surfaces a rejection, and one loader per process however many
 * copies of lib/initialized.ts the process holds.
 *
 * Every test starts from a fresh process: new module copies
 * (vi.resetModules) and no process-wide state (resetGlobalSingletons), so the
 * loader the unit setup registers is gone too.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetGlobalSingletons } from '@/lib/global-singleton'

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('@/lib/logger', () => ({ createLogger: () => log }))

async function freshInitialized() {
  vi.resetModules()
  resetGlobalSingletons()
  return import('@/lib/initialized')
}

beforeEach(() => {
  log.warn.mockReset()
  log.error.mockReset()
})

describe('whenInitialized with a registered loader', () => {
  it('runs the loader once however many callers race for it, and not again after it resolved', async () => {
    const { registerInitLoader, whenInitialized } = await freshInitialized()
    let finish!: () => void
    const load = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)))
    registerInitLoader(load)

    const callers = [whenInitialized(), whenInitialized(), whenInitialized()]
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1))
    finish()
    await Promise.all(callers)
    await whenInitialized()

    expect(load).toHaveBeenCalledTimes(1)
  })

  it('rejects a caller whose load failed, and runs the loader again for the next caller', async () => {
    const { registerInitLoader, whenInitialized } = await freshInitialized()
    const load = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('missing env'))
      .mockResolvedValue(undefined)
    registerInitLoader(load)

    await expect(whenInitialized()).rejects.toThrow('missing env')
    await expect(whenInitialized()).resolves.toBeUndefined()
    await whenInitialized()
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('treats a loader that throws synchronously as a failed load', async () => {
    const { registerInitLoader, whenInitialized } = await freshInitialized()
    registerInitLoader(() => {
      throw new Error('boom')
    })

    await expect(whenInitialized()).rejects.toThrow('boom')
  })

  it('registering again replaces the loader and forgets the finished load', async () => {
    const { registerInitLoader, whenInitialized } = await freshInitialized()
    const first = vi.fn(async () => {})
    const second = vi.fn(async () => {})
    registerInitLoader(first)
    await whenInitialized()
    registerInitLoader(second)
    await whenInitialized()

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })
})

describe('whenInitialized with no loader registered', () => {
  it('resolves without initialising and warns once per process, never throwing', async () => {
    const { whenInitialized } = await freshInitialized()

    await expect(whenInitialized()).resolves.toBeUndefined()
    await expect(whenInitialized()).resolves.toBeUndefined()

    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(log.warn.mock.calls[0][0]).toContain('registerInitLoader')
  })

  it('warns once per process, not once per copy of the module', async () => {
    const first = await freshInitialized()
    await first.whenInitialized()
    vi.resetModules()
    const second = await import('@/lib/initialized')
    await second.whenInitialized()

    expect(log.warn).toHaveBeenCalledTimes(1)
  })
})

describe('startInitializing', () => {
  it('starts the load without waiting for it, and the next caller shares it', async () => {
    const { registerInitLoader, startInitializing, whenInitialized } = await freshInitialized()
    let finish!: () => void
    const load = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)))
    registerInitLoader(load)

    expect(startInitializing()).toBeUndefined()
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1))
    const caller = whenInitialized()
    finish()
    await caller

    expect(load).toHaveBeenCalledTimes(1)
  })

  it('logs a failed background load instead of rejecting, and the next caller retries it', async () => {
    const { registerInitLoader, startInitializing, whenInitialized } = await freshInitialized()
    const load = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('missing env'))
      .mockResolvedValue(undefined)
    registerInitLoader(load)

    startInitializing()
    await vi.waitFor(() => expect(log.error).toHaveBeenCalledTimes(1))
    await expect(whenInitialized()).resolves.toBeUndefined()

    expect(load).toHaveBeenCalledTimes(2)
  })
})

describe('one loader per process', () => {
  it('a copy of the module registered in (instrumentation) is the one every other copy waits for', async () => {
    const instrumentationCopy = await freshInitialized()
    const load = vi.fn(async () => {})
    instrumentationCopy.registerInitLoader(load)

    vi.resetModules()
    const routeCopy = await import('@/lib/initialized')
    expect(routeCopy).not.toBe(instrumentationCopy)
    await routeCopy.whenInitialized()
    await instrumentationCopy.whenInitialized()

    expect(load).toHaveBeenCalledTimes(1)
  })
})
