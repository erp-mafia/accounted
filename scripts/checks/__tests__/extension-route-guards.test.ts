import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findExtensionRouteFindings } from '../extension-route-guards.mjs'

let root: string

function writeRoute(extensionId: string, source: string) {
  const dir = path.join(root, 'app', 'api', 'extensions', extensionId, 'sync', 'cron')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'route.ts'), source)
}

const IMPORT = (id: string) => `import { run } from '@/extensions/general/${id}/lib/run'\n`

afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true })
})

describe('ungated-extension-route', () => {
  it('counts a cron wrapper with requireExtension for its own extension as gated', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-guard-'))
    writeRoute('foo', `${IMPORT('foo')}export const GET = withServiceCronContext('cron.foo', async () => run(), { requireExtension: 'foo' })\n`)

    expect(findExtensionRouteFindings(root).ungated).toEqual([])
  })

  it('flags requireExtension naming another extension', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-guard-'))
    writeRoute('foo', `${IMPORT('foo')}export const GET = withCronContext('cron.foo', async () => run(), { requireExtension: 'bar' })\n`)

    expect(findExtensionRouteFindings(root).ungated).toEqual(['app/api/extensions/foo/sync/cron/route.ts'])
  })

  it('does not count a runner spec extensionId as the gate', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-guard-'))
    writeRoute('foo', `${IMPORT('foo')}export const GET = withServiceCronContext('cron.foo', async (_r, ctx) => runWebshopOrderCron(ctx, { extensionId: 'foo' }))\n`)

    expect(findExtensionRouteFindings(root).ungated).toEqual(['app/api/extensions/foo/sync/cron/route.ts'])
  })

  it('still accepts the inline registry gate', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-guard-'))
    writeRoute('foo', `${IMPORT('foo')}export async function GET() { if (!(await extensionRegistry.get('foo'))) return null; return run() }\n`)

    expect(findExtensionRouteFindings(root).ungated).toEqual([])
  })
})
