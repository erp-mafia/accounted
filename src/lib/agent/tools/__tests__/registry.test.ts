import { describe, it, expect, vi, beforeEach } from 'vitest'
import { agentToolRegistry, registerAgentToolLoader } from '../registry'
import type { AgentTool } from '../types'

function tool(name: string): AgentTool {
  return {
    name,
    description: `desc ${name}`,
    inputSchema: { type: 'object', properties: {} },
    execute: vi.fn(),
  }
}

beforeEach(() => {
  agentToolRegistry.clear()
})

describe('agentToolRegistry loaders', () => {
  it('does not run a loader until a tool is looked up', async () => {
    const loader = vi.fn().mockResolvedValue([tool('a')])
    registerAgentToolLoader(loader)
    expect(loader).not.toHaveBeenCalled()

    expect((await agentToolRegistry.get('a'))?.name).toBe('a')
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('runs the loader once for concurrent and later lookups', async () => {
    const loader = vi.fn().mockResolvedValue([tool('a'), tool('b')])
    registerAgentToolLoader(loader)

    const [one, many] = await Promise.all([
      agentToolRegistry.get('a'),
      agentToolRegistry.getMany(['b', 'missing', 'a']),
    ])
    expect(one?.name).toBe('a')
    expect(many.map((t) => t.name)).toEqual(['b', 'a'])

    await agentToolRegistry.getMany(['a'])
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('does not cache a failed load: the next lookup retries', async () => {
    const loader = vi
      .fn()
      .mockRejectedValueOnce(new Error('chunk load failed'))
      .mockResolvedValueOnce([tool('a')])
    registerAgentToolLoader(loader)

    const [first, second] = await Promise.allSettled([
      agentToolRegistry.get('a'),
      agentToolRegistry.get('a'),
    ])
    expect(first.status).toBe('rejected')
    expect(second.status).toBe('rejected')
    expect(loader).toHaveBeenCalledTimes(1)

    expect((await agentToolRegistry.get('a'))?.name).toBe('a')
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it('answers with no tools when nothing is registered (core-only build)', async () => {
    expect(await agentToolRegistry.get('a')).toBeUndefined()
    expect(await agentToolRegistry.getMany(['a'])).toEqual([])
  })
})
