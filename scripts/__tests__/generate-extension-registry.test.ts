/**
 * The branding list: the one generated module the root layout and the web
 * manifest import so a fork's branding extension registers before
 * getBranding() is read, without loading every enabled extension.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateBrandingList, type Manifest } from '../generate-extension-registry'

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

function manifest(id: string, extra: Partial<Manifest> = {}): Manifest {
  return {
    id,
    sector: 'general',
    exportName: `${id}Extension`,
    entryPoint: `@/extensions/general/${id}`,
    workspace: null,
    requiredEnvVars: [],
    optionalEnvVars: [],
    npmDependencies: [],
    definition: {
      name: id,
      category: 'operations',
      icon: 'Box',
      dataPattern: 'core',
      description: '',
      longDescription: '',
    },
    ...extra,
  }
}

function imports(source: string): string[] {
  return source.split('\n').filter((line) => line.startsWith('import '))
}

describe('generateBrandingList', () => {
  it('imports nothing when no enabled extension declares branding', () => {
    const source = generateBrandingList([manifest('email'), manifest('mcp-server')])

    expect(imports(source)).toEqual([])
    // Still a module, so `import '.../branding-list'` type-checks.
    expect(source).toContain('export {}')
  })

  it('imports only the enabled extensions that declare "branding": true, for their side effect', () => {
    const source = generateBrandingList([
      manifest('email'),
      manifest('your-brand', { branding: true }),
      manifest('stripe', { branding: false }),
    ])

    expect(imports(source)).toEqual(["import '@/extensions/general/your-brand'"])
  })

  it('refuses a branding extension with no entry point to import', () => {
    expect(() => generateBrandingList([manifest('your-brand', { branding: true, entryPoint: null })])).toThrow(
      /your-brand/,
    )
  })

  it('lists the example branding extension a fork copies, once it is enabled', () => {
    const example = JSON.parse(
      readFileSync(join(ROOT, 'src/extensions/general/_example-branding/manifest.json'), 'utf8'),
    ) as Manifest

    expect(example.branding).toBe(true)
    expect(imports(generateBrandingList([example]))).toEqual([
      "import '@/extensions/general/_example-branding'",
    ])
  })
})
