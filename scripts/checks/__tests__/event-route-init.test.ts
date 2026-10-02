/**
 * Proof that the uninitialized-event-route guard flags a route that can emit
 * without wiring the bus at module scope, and accepts the sanctioned ways of
 * wiring it. The fixture tree lives in an OS temp directory created and
 * deleted here; the last block pins the real tree's lead case.
 */
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findUninitializedEmittingRoutes } from '../event-route-init.mjs'

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

// The production wrapper: it does not wire the bus.
const WRAPPER = `export function withRouteContext(op: string, handler: () => Promise<Response>) {
  return async () => handler()
}
`
// A wrapper that wires the bus per request. The guard is route-level, so this
// must not excuse a route that has no module-scope call of its own.
const WRAPPER_WITH_REQUEST_INIT = `import { ensureInitialized } from '@/lib/init'
export function withRouteContext(op: string, handler: () => Promise<Response>) {
  return async () => {
    ensureInitialized()
    return handler()
  }
}
`

function fixture(wrapperSource: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'event-route-init-'))
  tempDirs.push(root)
  const files: Record<string, string> = {
    'lib/events/bus.ts': 'export const eventBus = { emit: async (_e: unknown) => {} }\n',
    'lib/core/lock.ts': `import { eventBus } from '@/lib/events/bus'
export async function lockPeriod() {
  await eventBus.emit({ type: 'period.locked', payload: {} })
}
export type Lock = { id: string }
`,
    'lib/core/quiet.ts': 'export function add(a: number, b: number) { return a + b }\n',
    // Hands the emitter to a callback without calling it here: still an emitter.
    'lib/core/bound.ts': `import { eventBus } from '@/lib/events/bus'
export function syncWith(run: (emit: (e: unknown) => Promise<void>) => Promise<void>) {
  return run(eventBus.emit.bind(eventBus))
}
`,
    // A longer member name that starts with emit is not an emit.
    'lib/core/stats.ts': `const eventBus = { emitted: 0 }
export function seen() { return eventBus.emitted }
`,
    // init pulls in an emitter (as it does through the extensions); it must
    // not make every importer of init look like an emitting route.
    'lib/init.ts': `import '@/lib/core/lock'
export function ensureInitialized() {}
`,
    'lib/api/with-route-context.ts': wrapperSource,
    'lib/api/v1/with-api-v1.ts': `import { ensureInitialized } from '@/lib/init'
ensureInitialized()
export function withApiV1(op: string, handler: () => Promise<Response>) { return handler }
`,
    // The period lock route as it was: wrapped, no module-scope call.
    'app/api/wrapped/route.ts': `import { withRouteContext } from '@/lib/api/with-route-context'
import { lockPeriod } from '@/lib/core/lock'
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>('period.lock', async () => {
  await lockPeriod()
  return new Response()
})
`,
    // The period lock route as it is now: wrapped, with the module-scope call.
    'app/api/wrapped-init/route.ts': `import { withRouteContext } from '@/lib/api/with-route-context'
import { lockPeriod } from '@/lib/core/lock'
import { ensureInitialized } from '@/lib/init'

ensureInitialized()

export const POST = withRouteContext('period.lock', async () => {
  await lockPeriod()
  return new Response()
})
`,
    'app/api/raw/route.ts': `import { lockPeriod } from '@/lib/core/lock'
export async function POST() { await lockPeriod(); return new Response() }
`,
    'app/api/module-init/route.ts': `import { ensureInitialized } from '@/lib/init'
import { lockPeriod } from '@/lib/core/lock'
ensureInitialized()
export async function POST() { await lockPeriod(); return new Response() }
`,
    // Wiring the bus inside the handler is not the pattern the guard accepts.
    'app/api/handler-init/route.ts': `import { ensureInitialized } from '@/lib/init'
import { lockPeriod } from '@/lib/core/lock'
export async function POST() { ensureInitialized(); await lockPeriod(); return new Response() }
`,
    'app/api/v1/route.ts': `import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { lockPeriod } from '@/lib/core/lock'
export const POST = withApiV1('period.lock', async () => { await lockPeriod(); return new Response() })
`,
    'app/api/type-only/route.ts': `import type { Lock } from '@/lib/core/lock'
import { type Lock as L2 } from '@/lib/core/lock'
export async function GET() { const x: Lock | L2 | null = null; return Response.json(x) }
`,
    'app/api/dynamic/route.ts': `export async function POST() {
  const { lockPeriod } = await import('../../../lib/core/lock')
  await lockPeriod()
  return new Response()
}
`,
    'app/api/bound/route.ts': `import { syncWith } from '@/lib/core/bound'
export async function POST() { await syncWith(async () => {}); return new Response() }
`,
    'app/api/quiet/route.ts': `import { add } from '@/lib/core/quiet'
import { seen } from '@/lib/core/stats'
import { ensureInitialized } from '@/lib/init'
export async function GET() { return Response.json(add(seen(), 2)) }
export const warm = ensureInitialized
`,
    'app/api/raw/__tests__/route.ts': `import { lockPeriod } from '@/lib/core/lock'
export async function POST() { await lockPeriod(); return new Response() }
`,
  }
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, text)
  }
  return root
}

const EMITTING = [
  'app/api/bound/route.ts',
  'app/api/dynamic/route.ts',
  'app/api/handler-init/route.ts',
  'app/api/module-init/route.ts',
  'app/api/raw/route.ts',
  'app/api/v1/route.ts',
  'app/api/wrapped-init/route.ts',
  'app/api/wrapped/route.ts',
]
const UNINITIALIZED = [
  'app/api/bound/route.ts',
  'app/api/dynamic/route.ts',
  'app/api/handler-init/route.ts',
  'app/api/raw/route.ts',
  'app/api/wrapped/route.ts',
]

describe('uninitialized-event-route', () => {
  it('flags every route that can emit without a module-scope ensureInitialized()', () => {
    const result = findUninitializedEmittingRoutes(fixture(WRAPPER))

    expect(result.emittingRoutes).toEqual(EMITTING)
    expect(result.uninitialized).toEqual(UNINITIALIZED)
  })

  it('does not let a per-request call in withRouteContext excuse the route', () => {
    const result = findUninitializedEmittingRoutes(fixture(WRAPPER_WITH_REQUEST_INIT))

    expect(result.uninitialized).toEqual(UNINITIALIZED)
  })
})

describe('uninitialized-event-route on the real tree', () => {
  const SOURCE_ROOT = path.resolve(__dirname, '..', '..', '..', 'src')
  const LOCK_ROUTE = 'app/api/bookkeeping/fiscal-periods/[id]/lock/route.ts'

  it('wires the bus in the period lock route, whose period.locked events were dropped', () => {
    const result = findUninitializedEmittingRoutes(SOURCE_ROOT)

    expect(result.emittingRoutes).toContain(LOCK_ROUTE)
    expect(result.uninitialized).not.toContain(LOCK_ROUTE)
  })

  it('keeps lib/init out of withRouteContext, so non-emitting routes stay light on a cold start', () => {
    const wrapper = fs.readFileSync(path.join(SOURCE_ROOT, 'lib/api/with-route-context.ts'), 'utf8')

    expect(wrapper).not.toMatch(/from '@\/lib\/init'/)
  })
})
