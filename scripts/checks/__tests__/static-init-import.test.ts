/**
 * Proof that the static-init-import guard flags a server entry point whose
 * static import graph reaches lib/init or the extension list, directly or
 * through a module it imports, and a client module that reaches the event
 * bus's way in (lib/initialized.ts); and that it lets through the sanctioned
 * way in on the server (a dynamic import, as lib/initialized.ts does) and
 * type-only imports. Also that findInitReach lists the server entries that
 * reach lib/initialized.ts, the count the lazy-init-reach ratchet holds down
 * because each of them compiles every extension. The fixture tree lives in an OS temp directory created
 * and deleted here; the last block pins the real tree.
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

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-init-import-'))
  tempDirs.push(root)
  const files: Record<string, string> = {
    'lib/extensions/_generated/extension-list.ts': 'export const FIRST_PARTY_EXTENSIONS = []\n',
    'lib/extensions/loader.ts': `import { FIRST_PARTY_EXTENSIONS } from './_generated/extension-list'
export function loadExtensions() { return FIRST_PARTY_EXTENSIONS }
`,
    'lib/init.ts': `import { loadExtensions } from '@/lib/extensions/loader'
export function ensureInitialized() { loadExtensions() }
`,
    'lib/initialized.ts': `export function whenInitialized() {
  return import('@/lib/init').then((m) => m.ensureInitialized())
}
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
    'app/(dashboard)/settings/page.tsx': `export { FIRST_PARTY_EXTENSIONS as list } from '@/lib/extensions/_generated/extension-list'
export default function Page() { return null }
`,
    'lib/company/actions.ts': `'use server'
import { loadExtensions } from '@/lib/extensions/loader'
export async function act() { loadExtensions() }
`,
    'instrumentation.ts': `import '@/lib/init'
export async function register() {}
`,
    // Client modules: a pure helper is fine, one re-exported by an emitting
    // server module drags the bus (and its import of lib/init) into the browser.
    'lib/core/period-label.ts': 'export function periodLabel(id: string) { return id }\n',
    'lib/core/lock-helpers.ts': `import { lockPeriod } from './lock'
export function canLock(locked: boolean) { return !locked }
export { lockPeriod }
`,
    'components/PeriodBadge.tsx': `'use client'
import { periodLabel } from '@/lib/core/period-label'
export function PeriodBadge() { return periodLabel('p1') }
`,
    'components/LockButton.tsx': `'use client'
import { canLock } from '@/lib/core/lock-helpers'
export function LockButton() { return canLock(false) }
`,
  }
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, body)
  }
  return root
}

describe('static-init-import', () => {
  it('flags every entry whose static import graph reaches lib/init or the extension list', () => {
    const offenders = findStaticInitImports(fixture())

    expect(offenders.filter((o) => o.kind === 'server').map((o) => o.entry).sort()).toEqual([
      'app/(dashboard)/settings/page.tsx',
      'app/api/direct/route.ts',
      'app/api/wrapped/route.ts',
      'instrumentation.ts',
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
    expect(chain('lib/company/actions.ts')).toEqual(['lib/company/actions.ts', 'lib/extensions/loader.ts'])
  })

  it('flags a client module that reaches the event bus, not one that imports a pure helper', () => {
    const client = findStaticInitImports(fixture()).filter((o) => o.kind === 'client')

    expect(client).toEqual([
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

  it('does not follow dynamic imports or type-only imports', () => {
    const entries = findStaticInitImports(fixture()).map((o) => o.entry)

    expect(entries).not.toContain('app/api/lock/route.ts')
    expect(entries).not.toContain('app/api/typed/route.ts')
    expect(entries).not.toContain('app/(public)/privacy/page.tsx')
  })
})

describe('lazy-init reach', () => {
  it('lists every server entry whose static graph reaches lib/initialized.ts, with a chain', () => {
    expect(findInitReach(fixture()).lazyInitEntries).toEqual([
      {
        kind: 'server',
        entry: 'app/api/lock/route.ts',
        chain: ['app/api/lock/route.ts', 'lib/core/lock.ts', 'lib/events/bus.ts', 'lib/initialized.ts'],
      },
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
  it('finds no entry point that imports lib/init statically', () => {
    expect(findStaticInitImports(SOURCE_ROOT)).toEqual([])
  }, 60_000)
})
