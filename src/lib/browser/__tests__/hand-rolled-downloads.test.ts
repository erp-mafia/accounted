import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Every file the browser saves goes through lib/browser/download-file: the
 * hand-rolled copies revoked the object URL in the same tick as the click
 * (which can abort the save in Firefox and Safari), some clicked a detached
 * anchor, none had a deadline, and each read a refusal its own way. An anchor
 * `download` assignment anywhere else is a new copy of that boilerplate.
 */

const SRC = resolve(__dirname, '../../..')
const ALLOWED = new Set(['lib/browser/download-file.ts'])

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(full))
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full)
  }
  return out
}

describe('browser downloads', () => {
  it('save files only through lib/browser/download-file', () => {
    const offenders = sourceFiles(SRC)
      .map((file) => relative(SRC, file))
      .filter((file) => !ALLOWED.has(file))
      .filter((file) => /\.download\s*=(?!=)/.test(readFileSync(join(SRC, file), 'utf8')))

    expect(offenders).toEqual([])
  })
})
