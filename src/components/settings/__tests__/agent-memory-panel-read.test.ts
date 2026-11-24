/**
 * What the memory panel asks its route for. The plain list (beside the agent
 * picture) asks for the facts an agent is given, which leaves out a row a
 * later fact replaced; the full list asks as it always has.
 *
 * The panel reads in an effect, and a server render runs none: useEffect is
 * collected here and run by hand after the render, with fetch recorded.
 */
import { createElement, type ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderInLocale } from '@/tests/i18n-render'

const effects = vi.hoisted(() => ({ run: [] as Array<() => unknown> }))
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useEffect: (effect: () => unknown) => {
      effects.run.push(effect)
    },
  }
})
vi.mock('@/lib/hooks/use-can-write', () => ({ useCanWrite: () => ({ canWrite: true }) }))
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: () => {} }) }))

import { AgentMemoryPanel, memoryListQuery } from '../AgentMemoryPanel'

const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify({ data: [] }), { status: 200 }))

/** The addresses the panel read when it was first shown. */
async function firstReads(plain: boolean): Promise<string[]> {
  effects.run = []
  // The panel's props have a default, so its type is narrowed to a component that always takes them.
  const Panel: (props: { plain?: boolean }) => ReactElement = AgentMemoryPanel
  renderInLocale(createElement(Panel, { plain }), 'sv')
  await Promise.all(effects.run.map((effect) => effect()))
  return fetchMock.mock.calls.map(([url]) => url)
}

beforeEach(() => {
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

describe('the read of the memory panel', () => {
  it('asks for the facts an agent is given in the plain list', async () => {
    expect(await firstReads(true)).toEqual(['/api/agent/memory?given=true'])
  })

  it('asks as before in the full list', async () => {
    expect(await firstReads(false)).toEqual(['/api/agent/memory?'])
  })
})

describe('memoryListQuery', () => {
  it('names the given facts, the hidden rows and the kind only when asked for', () => {
    expect(memoryListQuery({ given: false, includeDismissed: false, kind: 'all' })).toBe('')
    expect(memoryListQuery({ given: true, includeDismissed: false, kind: 'all' })).toBe('given=true')
    expect(memoryListQuery({ given: true, includeDismissed: true, kind: 'all' })).toBe('given=true&include_dismissed=true')
    expect(memoryListQuery({ given: false, includeDismissed: true, kind: 'pattern' })).toBe('include_dismissed=true&kind=pattern')
  })
})
