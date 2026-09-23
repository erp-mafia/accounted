import { describe, it, expect } from 'vitest'
import { runWithActor } from '../actor-context-node'
import { getActor } from '../actor-context'

describe('actor-context (AsyncLocalStorage commit attribution)', () => {
  it('returns undefined outside a runWithActor scope', () => {
    expect(getActor()).toBeUndefined()
  })

  it('exposes the actor inside the scope, across awaits', async () => {
    const seen: Array<ReturnType<typeof getActor>> = []
    await runWithActor({ type: 'api_key', label: 'Test Key' }, async () => {
      seen.push(getActor())
      await new Promise((resolve) => setTimeout(resolve, 0))
      seen.push(getActor())
    })
    expect(seen).toEqual([
      { type: 'api_key', label: 'Test Key' },
      { type: 'api_key', label: 'Test Key' },
    ])
    expect(getActor()).toBeUndefined()
  })

  it('keeps concurrent scopes isolated', async () => {
    const results = await Promise.all([
      runWithActor({ type: 'api_key', label: 'A' }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        return getActor()?.label
      }),
      runWithActor({ type: 'user', label: 'B' }, async () => {
        return getActor()?.label
      }),
    ])
    expect(results).toEqual(['A', 'B'])
  })

  it('propagates into nested calls without parameter threading', async () => {
    const deepRead = async () => getActor()
    const middle = async () => deepRead()
    const actor = await runWithActor({ type: 'agent_chat' }, middle)
    expect(actor).toEqual({ type: 'agent_chat' })
  })
})
