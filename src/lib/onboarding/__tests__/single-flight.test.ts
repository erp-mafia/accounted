import { describe, expect, it, vi } from 'vitest'
import { singleFlight } from '../single-flight'

function deferredRun() {
  const resolvers: ((v: number) => void)[] = []
  const run = vi.fn(() => new Promise<number>((resolve) => resolvers.push(resolve)))
  return { run, resolvers }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('singleFlight', () => {
  it('shares one outstanding run and follows it with exactly one fresh run', async () => {
    const { run, resolvers } = deferredRun()
    const load = singleFlight(run)
    const first = load()
    const second = load()
    const third = load()
    expect(run).toHaveBeenCalledTimes(1)
    expect(second).toBe(first)
    expect(third).toBe(first)

    // The read that started before the triggers is stale: one rerun, not two.
    resolvers[0](1)
    await tick()
    expect(run).toHaveBeenCalledTimes(2)
    resolvers[1](2)
    await expect(first).resolves.toBe(2)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('runs once when nothing arrives meanwhile, and again on the next call', async () => {
    const run = vi.fn().mockResolvedValueOnce('a').mockResolvedValueOnce('b')
    const load = singleFlight(run)
    await expect(load()).resolves.toBe('a')
    await expect(load()).resolves.toBe('b')
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('recovers after a run that throws', async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('ok')
    const load = singleFlight(run)
    await expect(load()).rejects.toThrow('boom')
    await expect(load()).resolves.toBe('ok')
  })
})
