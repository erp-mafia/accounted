import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills', 'accounted-api')

/** Starts with the old name and is not a tool name: the API key prefix a caller holds, and example keys. */
const KEY_PREFIX = 'gnubok_sk_'

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? markdownFiles(join(dir, entry.name)) : entry.name.endsWith('.md') ? [join(dir, entry.name)] : [],
  )
}

describe('the published accounted-api skill', () => {
  const texts = markdownFiles(SKILL_DIR).map((file) => ({ file, text: readFileSync(file, 'utf8') }))

  it('names MCP tools by their public names, never by an internal id', () => {
    expect(texts.length).toBeGreaterThan(5)
    const leaked = texts.flatMap(({ file, text }) =>
      [...text.matchAll(/\bgnubok_[A-Za-z0-9_]+/g)].map((match) => match[0]).filter((token) => !token.startsWith(KEY_PREFIX)).map((token) => `${file.slice(SKILL_DIR.length + 1)}: ${token}`),
    )
    expect(leaked).toEqual([])
  })

  it('still shows the API key prefix as it is on the wire', () => {
    expect(texts.some(({ text }) => text.includes(KEY_PREFIX))).toBe(true)
    expect(texts.some(({ text }) => /\baccounted_[a-z0-9_]+/.test(text))).toBe(true)
  })
})
