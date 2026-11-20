import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const SRC = path.resolve(__dirname, '../../..')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

/**
 * Every postgres_changes subscription must filter on the active company.
 *
 * Realtime applies the table's SELECT policy, which is membership-wide
 * (user_company_ids()), not the active company. An unfiltered channel on
 * /pending or the Underlag workspace therefore delivered the other company's
 * row changes to a user in two companies and refetched on each of them.
 */
describe('realtime subscriptions', () => {
  const subscriptions = sourceFiles(SRC).flatMap((file) => {
    const src = readFileSync(file, 'utf8')
    const found: { file: string; options: string }[] = []
    let at = src.indexOf("'postgres_changes'")
    while (at !== -1) {
      const open = src.indexOf('{', at)
      found.push({ file: path.relative(SRC, file), options: src.slice(open, src.indexOf('}', open) + 1) })
      at = src.indexOf("'postgres_changes'", at + 1)
    }
    return found
  })

  it('finds the subscriptions it guards', () => {
    expect(subscriptions.length).toBeGreaterThan(0)
  })

  it.each(subscriptions.map((s) => [s.file, s.options]))(
    '%s filters on company_id',
    (_file, options) => {
      expect(options).toMatch(/filter:\s*`company_id=eq\.\$\{/)
    },
  )
})
