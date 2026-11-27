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

  /**
   * A file route opened in a new tab: the route answers
   * Content-Disposition: attachment, so the tab starts a download and closes
   * itself, and a browser that asks where to save each file (Opera with that
   * setting on) loses the download with the tab. Exports go through
   * useExportDownload, which saves from the page. Opening a document to view
   * it (an /inline route) is not a download.
   */
  it('never open a file route in a new tab', () => {
    const offenders = sourceFiles(SRC)
      .map((file) => relative(SRC, file))
      .flatMap((file) =>
        [...readFileSync(join(SRC, file), 'utf8').matchAll(/window\.open\(\s*([^,)]*)/g)]
          .map((match) => match[1])
          .filter((target) => /\/api\/|[eE]xport|\.href\b/.test(target) && !target.includes('/inline'))
          .map((target) => `${file}: ${target.trim()}`),
      )

    expect(offenders).toEqual([])
  })
})
