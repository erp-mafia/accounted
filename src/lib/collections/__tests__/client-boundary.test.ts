/**
 * Client components must never reach server-only code. The payment writers
 * schedule a collections forward drain with `after` from next/server, and the
 * bookkeeping engine reaches those writers, so a client page that imports a
 * pure helper from a module beside the engine (creditNoteNeedsJournalEntry,
 * computeRefusedShares) pulls next/server into the browser bundle and the
 * page answers 500. Pure helpers live in client-safe modules instead; this
 * walks every 'use client' file's runtime imports to pin it.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const SRC = join(ROOT, 'src')
const SERVER_SPECIFIERS = new Set([
  'next/server',
  'next/headers',
  'next/cache',
  'server-only',
  '@/lib/supabase/server',
  ...builtinModules.flatMap((name) => [name, `node:${name}`]),
])
/** Server modules no client file may reach at all. */
const SERVER_MODULES = ['src/lib/bookkeeping/engine.ts', 'src/lib/collections/forward-hook.ts']

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue
      sourceFiles(path, out)
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(path)
    }
  }
  return out
}

const sources = new Map<string, string>()
const read = (file: string) => {
  let text = sources.get(file)
  if (text === undefined) {
    text = readFileSync(file, 'utf8')
    sources.set(file, text)
  }
  return text
}

const isClient = (file: string) =>
  /^\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*['"]use client['"]/.test(read(file))

/**
 * A 'use server' module never reaches the browser: a client file that imports
 * one gets a reference to the server action, not its code, so the walk stops
 * there as the bundler does.
 */
const isServerAction = (file: string) =>
  /^\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*['"]use server['"]/.test(read(file))

function resolveSpecifier(from: string, specifier: string): string | null {
  let base: string
  if (specifier.startsWith('@/')) base = join(SRC, specifier.slice(2))
  else if (specifier.startsWith('.')) base = resolve(dirname(from), specifier)
  else return null
  if (existsSync(base) && statSync(base).isFile()) return base
  for (const ext of ['.ts', '.tsx', '/index.ts', '/index.tsx']) {
    if (existsSync(base + ext)) return base + ext
  }
  return null
}

/** Runtime import specifiers: type-only imports and re-exports are erased. */
function runtimeImports(file: string): string[] {
  const out: string[] = []
  const pattern =
    /(?:^|\n)\s*(?:import|export)\s+([^'";]*?)\s*from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const match of read(file).matchAll(pattern)) {
    const bare = match[3] ?? match[4]
    if (bare) {
      out.push(bare)
      continue
    }
    const clause = match[1].trim()
    if (/^type\s/.test(clause)) continue
    const braces = clause.match(/^\{([\s\S]*)\}$/)
    if (braces) {
      const names = braces[1].split(',').map((part) => part.trim()).filter(Boolean)
      if (names.length > 0 && names.every((name) => name.startsWith('type '))) continue
    }
    out.push(match[2])
  }
  return out
}

/** For each client file, the first chain to a forbidden module, if any. */
function forbiddenChains(): string[] {
  const offenders: string[] = []
  for (const start of sourceFiles(SRC).filter(isClient)) {
    const parent = new Map<string, string | null>([[start, null]])
    const queue = [start]
    let found: { file: string; target: string } | null = null
    while (queue.length > 0 && !found) {
      const file = queue.shift() as string
      for (const specifier of runtimeImports(file)) {
        const target = resolveSpecifier(file, specifier)
        const rel = target ? relative(ROOT, target) : null
        const viaCollections = relative(ROOT, file).startsWith('src/lib/collections/')
        if ((viaCollections && SERVER_SPECIFIERS.has(specifier)) || (rel && SERVER_MODULES.includes(rel))) {
          found = { file, target: rel ?? specifier }
          break
        }
        if (target && !parent.has(target) && !isServerAction(target)) {
          parent.set(target, file)
          queue.push(target)
        }
      }
    }
    if (found) {
      const chain = [found.target]
      for (let at: string | null | undefined = found.file; at; at = parent.get(at)) chain.unshift(relative(ROOT, at))
      offenders.push(chain.join(' > '))
    }
  }
  return offenders
}

describe('client components and server-only code', () => {
  it('no client file reaches the bookkeeping engine, the forward drain or a server import in collections', () => {
    expect(forbiddenChains()).toEqual([])
    // It walks the import graph of every client file; under a busy CI runner
    // that takes well over vitest's 5 s default.
  }, 120_000)

  it('catches the chain this guards against', () => {
    // The pure predicate's old home re-exports it beside the engine.
    expect(runtimeImports(join(SRC, 'lib/invoices/issue-credit-note.ts'))).toContain('@/lib/bookkeeping/invoice-entries')
    expect(runtimeImports(join(SRC, 'lib/bookkeeping/payment-sync.ts'))).toContain('@/lib/collections/forward-hook')
    expect(runtimeImports(join(SRC, 'lib/collections/forward-hook.ts'))).toContain('next/server')
  })
})
