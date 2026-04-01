import { resolve, join } from 'path'
import { readdirSync, readFileSync } from 'fs'

/**
 * Build EXTENSION_DEFINITIONS from manifest.json files so the test
 * is independent of extensions.config.json.
 */
function buildDefinitionsFromManifests(): Record<string, unknown[]> {
  const extensionsDir = resolve(__dirname, '../../../extensions')
  const result: Record<string, unknown[]> = {}

  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(fullPath)
      } else if (entry.name === 'manifest.json') {
        const manifest = JSON.parse(readFileSync(fullPath, 'utf-8'))
        const sector: string = manifest.sector
        if (!result[sector]) result[sector] = []
        result[sector].push({
          slug: manifest.id,
          sector: manifest.sector,
          ...manifest.definition,
        })
      }
    }
  }

  walk(extensionsDir)
  return result
}

vi.mock('@/lib/extensions/_generated/sector-definitions', () => ({
  EXTENSION_DEFINITIONS: buildDefinitionsFromManifests(),
}))

import {
  SECTORS,
  getSector,
  getExtensionDefinition,
  getAllExtensions,
  getExtensionsBySector,
} from '../sectors'

describe('sectors registry', () => {
  it('should have 1 sector', () => {
    expect(SECTORS.length).toBe(1)
  })

  it('should have 8 total extensions', () => {
    expect(getAllExtensions().length).toBe(8)
  })

  it('should have unique slugs within each sector', () => {
    for (const sector of SECTORS) {
      const slugs = sector.extensions.map(e => e.slug)
      const uniqueSlugs = new Set(slugs)
      expect(uniqueSlugs.size).toBe(slugs.length)
    }
  })

  it('should have at least one extension per sector', () => {
    for (const sector of SECTORS) {
      expect(sector.extensions.length).toBeGreaterThan(0)
    }
  })

  it('getSector returns correct sector', () => {
    const sector = getSector('general')
    expect(sector).toBeDefined()
    expect(sector!.slug).toBe('general')
    expect(sector!.name).toBe('Generella verktyg')
  })

  it('getSector returns undefined for unknown slug', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sector = getSector('invalid' as any)
    expect(sector).toBeUndefined()
  })

  it('getExtensionDefinition returns correct extension', () => {
    const ext = getExtensionDefinition('general', 'mcp-server')
    expect(ext).toBeDefined()
    expect(ext!.slug).toBe('mcp-server')
    expect(ext!.name).toBe('MCP-server (API)')
    expect(ext!.sector).toBe('general')
  })

  it('getExtensionDefinition returns undefined for unknown extension', () => {
    const ext = getExtensionDefinition('general', 'nonexistent')
    expect(ext).toBeUndefined()
  })

  it('getExtensionsBySector returns extensions for a sector', () => {
    const extensions = getExtensionsBySector('general')
    expect(extensions.length).toBe(8)
  })

  it('all extensions have required fields', () => {
    for (const ext of getAllExtensions()) {
      expect(ext.slug).toBeTruthy()
      expect(ext.name).toBeTruthy()
      expect(ext.sector).toBeTruthy()
      expect(ext.category).toBeTruthy()
      expect(ext.description).toBeTruthy()
      expect(ext.longDescription).toBeTruthy()
      expect(ext.icon).toBeTruthy()
      expect(ext.dataPattern).toBeTruthy()
    }
  })
})
