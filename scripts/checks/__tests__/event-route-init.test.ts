/**
 * Proof that the uninitialized-event-route guard flags an entry point (API
 * route, page, other App Router entry, server action module) that can emit or
 * read an extension registry without wiring init at module scope, and accepts
 * the sanctioned ways of wiring it. The fixture tree lives in an OS temp directory created and
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
    // Registries the extensions fill: reading one before init answers empty.
    'lib/extensions/registry.ts': 'export const extensionRegistry = { get: (_id: string) => undefined }\n',
    'lib/core/ombud.ts': `import { extensionRegistry } from '@/lib/extensions/registry'
export function ombudEnabled() { return Boolean(extensionRegistry.get('skatteverket')) }
`,
    // Defines a getter without calling it: importing it for its register
    // function or types is not a read.
    'lib/email/service.ts': `export function getEmailService() { return null }
export function registerEmailService(_svc: unknown) {}
`,
    'app/api/email-register/route.ts': `import { registerEmailService } from '@/lib/email/service'
export async function POST() { registerEmailService(null); return new Response() }
`,
    'app/api/ombud/route.ts': `import { ombudEnabled } from '@/lib/core/ombud'
export async function GET() { return Response.json(ombudEnabled()) }
`,
    // Pages, layouts and server actions are entry points too: the root
    // layout no longer initialises on their behalf.
    'app/layout.tsx': `import '@/lib/extensions/_generated/branding-list'
export default function RootLayout({ children }: { children: unknown }) { return children }
`,
    'lib/extensions/_generated/branding-list.ts': 'export {}\n',
    'app/(dashboard)/page.tsx': `import { ombudEnabled } from '@/lib/core/ombud'
export default async function Hem() { return ombudEnabled() }
`,
    'app/(dashboard)/init/page.tsx': `import { ombudEnabled } from '@/lib/core/ombud'
import { ensureInitialized } from '@/lib/init'
ensureInitialized()
export default async function Page() { return ombudEnabled() }
`,
    'app/(public)/privacy/page.tsx': `import { add } from '@/lib/core/quiet'
export default function Privacy() { return add(1, 2) }
`,
    'app/.well-known/thing/route.ts': `import { lockPeriod } from '@/lib/core/lock'
export async function POST() { await lockPeriod(); return new Response() }
`,
    'lib/company/actions.ts': `'use server'
import { lockPeriod } from '@/lib/core/lock'
export async function lockAction() { await lockPeriod() }
`,
    'lib/company/init-actions.ts': `// Server actions.
'use server'
import { lockPeriod } from '@/lib/core/lock'
import { ensureInitialized } from '@/lib/init'
ensureInitialized()
export async function lockAction() { await lockPeriod() }
`,
    // Mentions 'use server' but is not a server action module.
    'lib/company/not-actions.ts': `import { lockPeriod } from '@/lib/core/lock'
export const directive = 'use server'
export const run = lockPeriod
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
  'app/(dashboard)/init/page.tsx',
  'app/(dashboard)/page.tsx',
  'app/.well-known/thing/route.ts',
  'app/api/bound/route.ts',
  'app/api/dynamic/route.ts',
  'app/api/handler-init/route.ts',
  'app/api/module-init/route.ts',
  'app/api/ombud/route.ts',
  'app/api/raw/route.ts',
  'app/api/v1/route.ts',
  'app/api/wrapped-init/route.ts',
  'app/api/wrapped/route.ts',
  'lib/company/actions.ts',
  'lib/company/init-actions.ts',
]
const UNINITIALIZED = [
  'app/(dashboard)/page.tsx',
  'app/.well-known/thing/route.ts',
  'app/api/bound/route.ts',
  'app/api/dynamic/route.ts',
  'app/api/handler-init/route.ts',
  'app/api/ombud/route.ts',
  'app/api/raw/route.ts',
  'app/api/wrapped/route.ts',
  'lib/company/actions.ts',
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

  it('reports which entry points load every extension, and a branded root layout is not one', () => {
    const result = findUninitializedEmittingRoutes(fixture(WRAPPER))

    expect(result.initializing).toContain('app/(dashboard)/init/page.tsx')
    expect(result.initializing).toContain('lib/company/init-actions.ts')
    expect(result.initializing).not.toContain('app/layout.tsx')
    expect(result.initializing).not.toContain('app/(public)/privacy/page.tsx')
  })
})

describe('uninitialized-event-route on the real tree', () => {
  const SOURCE_ROOT = path.resolve(__dirname, '..', '..', '..', 'src')
  const LOCK_ROUTE = 'app/api/bookkeeping/fiscal-periods/[id]/lock/route.ts'

  it('wires the bus in the period lock route, whose period.locked events were dropped', () => {
    const result = findUninitializedEmittingRoutes(SOURCE_ROOT)

    expect(result.emittingRoutes).toContain(LOCK_ROUTE)
    expect(result.uninitialized).not.toContain(LOCK_ROUTE)
  }, 60_000)

  it('keeps public and auth pages, the root layout and the web manifest from loading every extension', () => {
    const result = findUninitializedEmittingRoutes(SOURCE_ROOT)

    for (const entry of [
      'app/layout.tsx',
      'app/manifest.ts',
      'app/(auth)/login/page.tsx',
      'app/(auth)/register/page.tsx',
      'app/(auth)/reset-password/page.tsx',
      'app/(public)/privacy/page.tsx',
      'app/(public)/dpa/page.tsx',
      'app/invite/[token]/page.tsx',
    ]) {
      expect(result.initializing).not.toContain(entry)
    }
    // Hem reads the skatteverket extension's services, so it wires itself.
    expect(result.initializing).toContain('app/(dashboard)/page.tsx')
  }, 60_000)

  it('keeps lib/init out of withRouteContext, so non-emitting routes stay light on a cold start', () => {
    const wrapper = fs.readFileSync(path.join(SOURCE_ROOT, 'lib/api/with-route-context.ts'), 'utf8')

    expect(wrapper).not.toMatch(/from '@\/lib\/init'/)
  })
})
