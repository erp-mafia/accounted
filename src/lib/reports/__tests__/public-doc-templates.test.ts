/**
 * Guard for the downloadable templates under public/docs (Hjälp > Dokument &
 * Mallar). They restate menu paths that live in the app, and nothing else
 * ties the two together, so renamed menus silently left the templates
 * pointing at places that no longer exist. Every bold "A > B" path must be
 * built from labels that still exist in sv.json.
 *
 * The templates are customer documents: detailed behandlingsregler and their
 * change history belong in the generated systemdokumentation in the full
 * archive (full-archive-export.ts), not as PR or issue references here.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import sv from '@/messages/sv.json'

const DOCS_DIR = fileURLToPath(new URL('../../../../public/docs/', import.meta.url))

function collectStrings(value: unknown, out: Set<string>): Set<string> {
  if (typeof value === 'string') out.add(value)
  else if (value && typeof value === 'object') {
    for (const child of Object.values(value)) collectStrings(child, out)
  }
  return out
}

const LABELS = collectStrings(sv, new Set())
const TEMPLATES = readdirSync(DOCS_DIR)
  .filter((name) => name.endsWith('.md'))
  .map((name) => ({ name, text: readFileSync(join(DOCS_DIR, name), 'utf8') }))

describe('public/docs templates', () => {
  it('finds the templates', () => {
    expect(TEMPLATES.map((t) => t.name)).toEqual(
      expect.arrayContaining(['arkivplan-mall.md', 'systemdokumentation-mall.md'])
    )
  })

  it.each(TEMPLATES)('$name names only menu labels that exist in sv.json', ({ text }) => {
    const paths = [...text.matchAll(/\*\*([^*]+ > [^*]+)\*\*/g)].map((m) => m[1])
    const missing = paths.flatMap((p) => p.split(' > ').filter((segment) => !LABELS.has(segment)))
    expect(missing).toEqual([])
  })

  it.each(TEMPLATES)('$name cites no internal PR or issue numbers', ({ text }) => {
    expect(text.match(/(?:\bPR|ärende|issue)\s*#\d+|#\d{3,}/gi)).toBeNull()
  })
})
