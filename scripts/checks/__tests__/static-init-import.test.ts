/**
 * Proof that the static-init-import guard flags every server entry point
 * whose import graph, static or dynamic, reaches lib/init or the extension
 * list other than through instrumentation.ts's dynamic import of lib/init (so
 * the pre-2026-10-16 shape, lib/initialized.ts importing lib/init
 * dynamically, is an offender), and every client module that reaches the
 * event bus's lib/initialized.ts; that it lets through the sanctioned shapes
 * (instrumentation.ts's dynamic import, type-only imports, a client module
 * calling a server action); and that findInitReach lists the server entries
 * that reach lib/init following dynamic imports, the count the
 * lazy-init-reach ratchet holds down because each of them compiles every
 * extension. The fixture trees live in an OS temp directory created and
 * deleted here; the last block pins the real tree.
 */
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findInitReach, findStaticInitImports } from '../static-init-import.mjs'

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

const BASE_FILES: Record<string, string> = {
  'lib/extensions/_generated/extension-list.ts': 'export const FIRST_PARTY_EXTENSIONS = []\n',
  'lib/extensions/loader.ts': `import { FIRST_PARTY_EXTENSIONS } from './_generated/extension-list'
export function loadExtensions() { return FIRST_PARTY_EXTENSIONS }
`,
  'lib/init.ts': `import { loadExtensions } from '@/lib/extensions/loader'
export function ensureInitialized() { loadExtensions() }
`,
  // The sanctioned way in: register() is the one importer of lib/init.
  'instrumentation.ts': `export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { registerInitLoader } = await import('@/lib/initialized')
    registerInitLoader(() => import('@/lib/init').then((m) => m.ensureInitialized()))
  }
}
`,
  'lib/initialized.ts': `let load: (() => Promise<void>) | null = null
export function registerInitLoader(l: () => Promise<void>) { load = l }
export function whenInitialized() { return load ? load() : Promise.resolve() }
`,
  'lib/events/bus.ts': `import { whenInitialized } from '@/lib/initialized'
export const eventBus = { emit: async () => { await whenInitialized() } }
`,
  'lib/core/lock.ts': `import { eventBus } from '@/lib/events/bus'
export async function lockPeriod() { await eventBus.emit() }
`,
  // A helper that initialises eagerly: everything that imports it is an offender.
  'lib/api/eager-wrapper.ts': `import { ensureInitialized } from '../init'
ensureInitialized()
export function wrap(handler: () => Promise<Response>) { return handler }
`,
  // The pre-2026-10-16 shape: a dynamic import of lib/init behind the bus.
  'lib/legacy-initialized.ts': `export function whenInitialized() {
  return import('@/lib/init').then((m) => m.ensureInitialized())
}
`,
  'lib/types-only.ts': `import type { ensureInitialized } from '@/lib/init'
export type Init = typeof ensureInitialized
`,
  // The sanctioned shapes.
  'app/api/lock/route.ts': `import { lockPeriod } from '@/lib/core/lock'
export async function POST() { await lockPeriod(); return new Response() }
`,
  'app/api/typed/route.ts': `import type { Init } from '@/lib/types-only'
export async function GET() { return new Response() }
`,
  'app/(public)/privacy/page.tsx': 'export default function Page() { return null }\n',
  // The offenders.
  'app/api/direct/route.ts': `import { ensureInitialized } from '@/lib/init'
ensureInitialized()
export async function GET() { return new Response() }
`,
  'app/api/wrapped/route.ts': `import { wrap } from '@/lib/api/eager-wrapper'
export const GET = wrap(async () => new Response())
`,
  'app/api/legacy/route.ts': `import { whenInitialized } from '@/lib/legacy-initialized'
export async function POST() { await whenInitialized(); return new Response() }
`,
  'app/api/required/route.ts': `export async function GET() {
  const { loadExtensions } = require('@/lib/extensions/loader')
  loadExtensions()
  return new Response()
}
`,
  'app/(dashboard)/settings/page.tsx': `export { FIRST_PARTY_EXTENSIONS as list } from '@/lib/extensions/_generated/extension-list'
export default function Page() { return null }
`,
  'lib/company/actions.ts': `'use server'
import { loadExtensions } from '@/lib/extensions/loader'
export async function act() { loadExtensions() }
`,
  // Client modules: a pure helper is fine, one re-exported by an emitting
  // server module ships the bus to the browser, statically or dynamically; a
  // server action is a reference, not the module's code.
  'lib/core/period-label.ts': 'export function periodLabel(id: string) { return id }\n',
  'lib/core/lock-helpers.ts': `import { lockPeriod } from './lock'
export function canLock(locked: boolean) { return !locked }
export { lockPeriod }
`,
  'lib/core/lock-action.ts': `'use server'
import { lockPeriod } from './lock'
export async function lockAction() { await lockPeriod() }
`,
  'components/PeriodBadge.tsx': `'use client'
import { periodLabel } from '@/lib/core/period-label'
export function PeriodBadge() { return periodLabel('p1') }
`,
  'components/LockButton.tsx': `'use client'
import { canLock } from '@/lib/core/lock-helpers'
export function LockButton() { return canLock(false) }
`,
  'components/LazyLockButton.tsx': `'use client'
export async function onClick() { const { lockPeriod } = await import('@/lib/core/lock'); await lockPeriod() }
`,
  'components/ActionLockButton.tsx': `'use client'
import { lockAction } from '@/lib/core/lock-action'
export function ActionLockButton() { return lockAction }
`,
}

function fixture(overrides: Record<string, string> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-init-import-'))
  tempDirs.push(root)
  for (const [rel, body] of Object.entries({ ...BASE_FILES, ...overrides })) {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, body)
  }
  return root
}

describe('static-init-import', () => {
  it('flags every server entry whose import graph, static or dynamic, reaches lib/init or the extension list', () => {
    const offenders = findStaticInitImports(fixture())

    expect(offenders.filter((o) => o.kind === 'server').map((o) => o.entry).sort()).toEqual([
      'app/(dashboard)/settings/page.tsx',
      'app/api/direct/route.ts',
      'app/api/legacy/route.ts',
      'app/api/required/route.ts',
      'app/api/wrapped/route.ts',
      'lib/company/actions.ts',
    ])
  })

  it('reports a shortest chain from the entry to the forbidden module', () => {
    const offenders = findStaticInitImports(fixture())
    const chain = (entry: string) => offenders.find((o) => o.entry === entry)?.chain

    expect(chain('app/api/direct/route.ts')).toEqual(['app/api/direct/route.ts', 'lib/init.ts'])
    expect(chain('app/api/wrapped/route.ts')).toEqual([
      'app/api/wrapped/route.ts',
      'lib/api/eager-wrapper.ts',
      'lib/init.ts',
    ])
    expect(chain('app/api/legacy/route.ts')).toEqual([
      'app/api/legacy/route.ts',
      'lib/legacy-initialized.ts',
      'lib/init.ts',
    ])
    expect(chain('app/api/required/route.ts')).toEqual(['app/api/required/route.ts', 'lib/extensions/loader.ts'])
    expect(chain('lib/company/actions.ts')).toEqual(['lib/company/actions.ts', 'lib/extensions/loader.ts'])
  })

  it("lets through instrumentation.ts's dynamic import of lib/init, and no other import of it there", () => {
    expect(findStaticInitImports(fixture()).map((o) => o.entry)).not.toContain('instrumentation.ts')

    const eager = findStaticInitImports(
      fixture({ 'instrumentation.ts': "import '@/lib/init'\nexport async function register() {}\n" }),
    )
    expect(eager.find((o) => o.entry === 'instrumentation.ts')?.chain).toEqual(['instrumentation.ts', 'lib/init.ts'])

    const throughLoader = findStaticInitImports(
      fixture({
        'instrumentation.ts': "export async function register() { await import('@/lib/extensions/loader') }\n",
      }),
    )
    expect(throughLoader.find((o) => o.entry === 'instrumentation.ts')?.chain).toEqual([
      'instrumentation.ts',
      'lib/extensions/loader.ts',
    ])
  })

  it('flags a client module that reaches the event bus, statically or dynamically, not one that imports a pure helper or calls a server action', () => {
    const client = findStaticInitImports(fixture()).filter((o) => o.kind === 'client')

    expect(client).toEqual([
      {
        kind: 'client',
        entry: 'components/LazyLockButton.tsx',
        chain: ['components/LazyLockButton.tsx', 'lib/core/lock.ts', 'lib/events/bus.ts', 'lib/initialized.ts'],
      },
      {
        kind: 'client',
        entry: 'components/LockButton.tsx',
        chain: [
          'components/LockButton.tsx',
          'lib/core/lock-helpers.ts',
          'lib/core/lock.ts',
          'lib/events/bus.ts',
          'lib/initialized.ts',
        ],
      },
    ])
  })

  it('does not follow type-only imports, and lets an entry that only reaches the bus through', () => {
    const entries = findStaticInitImports(fixture()).map((o) => o.entry)

    expect(entries).not.toContain('app/api/lock/route.ts')
    expect(entries).not.toContain('app/api/typed/route.ts')
    expect(entries).not.toContain('app/(public)/privacy/page.tsx')
    expect(entries).not.toContain('lib/core/lock-action.ts')
  })
})

describe('lazy-init reach', () => {
  it('lists every server entry whose graph reaches lib/init following dynamic imports, with a chain', () => {
    expect(findInitReach(fixture()).lazyInitEntries).toEqual([
      { kind: 'server', entry: 'app/api/direct/route.ts', chain: ['app/api/direct/route.ts', 'lib/init.ts'] },
      {
        kind: 'server',
        entry: 'app/api/legacy/route.ts',
        chain: ['app/api/legacy/route.ts', 'lib/legacy-initialized.ts', 'lib/init.ts'],
      },
      {
        kind: 'server',
        entry: 'app/api/wrapped/route.ts',
        chain: ['app/api/wrapped/route.ts', 'lib/api/eager-wrapper.ts', 'lib/init.ts'],
      },
      { kind: 'server', entry: 'instrumentation.ts', chain: ['instrumentation.ts', 'lib/init.ts'] },
    ])
  })

  it('answers the static question the same way findStaticInitImports does', () => {
    const root = fixture()
    expect(findInitReach(root).staticInitImports).toEqual(findStaticInitImports(root))
  })
})

describe('static-init-import on the real tree', () => {
  const SOURCE_ROOT = path.resolve(__dirname, '../../../src')

  // Walks the whole import graph: seconds on a loaded CI runner, so the same
  // headroom as the other real-tree guard tests.
  it('finds no module that imports lib/init outside instrumentation.ts, and only instrumentation.ts reaches it', () => {
    const reach = findInitReach(SOURCE_ROOT)
    expect(reach.staticInitImports).toEqual([])
    expect(reach.lazyInitEntries.map((o) => o.entry)).toEqual(['instrumentation.ts'])
  }, 60_000)
})
