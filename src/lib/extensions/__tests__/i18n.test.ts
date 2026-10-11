import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Puzzle } from 'lucide-react'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import { resolveIcon } from '../icon-resolver'
import {
  extensionDescriptionKey,
  extensionLongDescriptionKey,
  extensionNameKey,
} from '../i18n'

/**
 * An extension card reads its icon from the manifest by name and its texts
 * from the `extensions` messages by slug. A name the icon map lacks renders
 * the generic puzzle piece, and a slug the key lookup lacks shows the Swedish
 * manifest text in an English UI; both went unnoticed for the extensions
 * enabled after the maps were written.
 */

const EXTENSIONS_DIR = resolve(__dirname, '../../../extensions/general')
const ENABLED: string[] = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../extensions.config.json'), 'utf8'),
).extensions

type Manifest = { id: string; definition: { icon: string; quickAction?: { icon?: string } } }

/** Every real manifest; directories starting with _ are templates. */
const MANIFESTS: Manifest[] = readdirSync(EXTENSIONS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
  .map((entry) => join(EXTENSIONS_DIR, entry.name, 'manifest.json'))
  .filter((file) => existsSync(file))
  .map((file) => JSON.parse(readFileSync(file, 'utf8')) as Manifest)

describe('extension icons', () => {
  it.each(MANIFESTS.map((m) => [m.id, m] as const))('%s has its own icon', (_id, manifest) => {
    expect(resolveIcon(manifest.definition.icon)).not.toBe(Puzzle)
    if (manifest.definition.quickAction?.icon) {
      expect(resolveIcon(manifest.definition.quickAction.icon)).not.toBe(Puzzle)
    }
  })
})

describe('extension texts', () => {
  const svTexts = sv.extensions as Record<string, string>
  const enTexts = en.extensions as Record<string, string>

  it.each(ENABLED)('%s is translated in both languages', (slug) => {
    const keys = [extensionNameKey(slug), extensionDescriptionKey(slug), extensionLongDescriptionKey(slug)]
    for (const key of keys) {
      expect(key).not.toBeNull()
      expect(svTexts[key!]).toEqual(expect.any(String))
      expect(enTexts[key!]).toEqual(expect.any(String))
    }
  })

  it('falls back to the manifest for a slug it does not know', () => {
    expect(extensionNameKey('no-such-extension')).toBeNull()
  })
})
