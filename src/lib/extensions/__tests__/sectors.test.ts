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
  getExtensionDefinition,
  getAllExtensions,
} from '../sectors'

describe('extension definitions', () => {
  it('should have 18 total extensions', () => {
    expect(getAllExtensions().length).toBe(18)
  })

  it('should have unique slugs', () => {
    const slugs = getAllExtensions().map(e => e.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
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

  it('getExtensionDefinition returns undefined for an unknown sector', () => {
    expect(getExtensionDefinition('invalid', 'mcp-server')).toBeUndefined()
    expect(getExtensionDefinition('constructor', 'mcp-server')).toBeUndefined()
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
