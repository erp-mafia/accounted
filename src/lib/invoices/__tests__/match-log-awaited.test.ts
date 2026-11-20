import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * payment_match_log is the append-only trail of every match, unmatch and
 * suggestion. An un-awaited logMatchEvent races the response: on Vercel the
 * function can freeze once the route returns, and the insert never lands.
 * Every call site awaits it (or returns its promise).
 */

const SRC = resolve(__dirname, '../../..')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path))
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path)
  }
  return out
}

function unawaitedCalls(): string[] {
  const found: string[] = []
  for (const file of sourceFiles(SRC)) {
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (!/\blogMatchEvent\(/.test(line)) return
      if (/function logMatchEvent\(/.test(line)) return
      if (/\b(await|return)\s+logMatchEvent\(/.test(line)) return
      found.push(`${relative(SRC, file)}:${i + 1}`)
    })
  }
  return found
}

describe('logMatchEvent call sites', () => {
  it('finds the call sites it guards', () => {
    const total = sourceFiles(SRC).filter((file) =>
      /\blogMatchEvent\(/.test(readFileSync(file, 'utf8')),
    )
    expect(total.length).toBeGreaterThan(5)
  })

  it('awaits every logMatchEvent so the audit row lands before the response', () => {
    expect(unawaitedCalls()).toEqual([])
  })
})
