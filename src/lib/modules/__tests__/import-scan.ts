/**
 * Dependency-free scanner for the boundary ratchet (boundary.test.ts): the
 * RUNTIME imports between files under src/lib, as module-to-module edges.
 *
 * Runtime only, by design: `import type`, `export type`, an import whose
 * every named specifier is `type`, and type-position `import('x').T` /
 * `typeof import('x')` are erased at build time and never make one module
 * execute another's code, so they are not counted. A shared type the kernel
 * needs from a block still belongs in the kernel or `@/types`, but that is a
 * cleanup, not a coupling the ratchet tracks.
 *
 * Counted: static `import ... from`, side-effect `import '...'`,
 * `export ... from`, dynamic `import('...')` and `require('...')` with a
 * string literal, for `@/lib/...` and relative specifiers. An edge is one
 * (importing file, imported path) pair, so two statements importing the same
 * file count once.
 *
 * Regex, not a parser: static statements are matched only at the start of a
 * line (JSDoc ` * import ...` and `// import ...` lines never match), and
 * dynamic imports on comment lines are skipped. An import spelled inside a
 * template literal at the start of a line would be miscounted; src/lib has
 * none today, and the ratchet compares the scanner with itself.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { getModule, moduleForLibPath } from '../resolve'
import type { ModuleId } from '../manifest'

export interface ImportSpecifier {
  specifier: string
  line: number
}

const STATIC_FROM = /^[ \t]*(?:import|export)\s+([\w*${},\s]*?)\s*from\s*(['"])([^'"\n]+)\2/gm
const SIDE_EFFECT = /^[ \t]*import\s*(['"])([^'"\n]+)\1/gm
const CALL = /\b(import|require)\s*\(\s*(['"])([^'"\n]+)\2\s*\)/g

function isTypeOnlyClause(clause: string): boolean {
  const c = clause.trim()
  // `type { A }`, `type A`, `type * as A` (but not a default import named `type`).
  if (/^type\b/.test(c) && !/^type\s*,/.test(c) && c !== 'type') return true
  const braces = /^\{([\s\S]*)\}$/.exec(c)
  if (!braces) return false
  const specs = braces[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return specs.length > 0 && specs.every((s) => /^type\s/.test(s))
}

function lineStarts(source: string): number[] {
  const starts = [0]
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1)
  return starts
}

function lineOf(starts: number[], index: number): number {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= index) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

/** The runtime import specifiers in one source file, with 1-based line numbers. */
export function extractRuntimeSpecifiers(source: string): ImportSpecifier[] {
  const starts = lineStarts(source)
  const out: ImportSpecifier[] = []

  for (const m of source.matchAll(STATIC_FROM)) {
    if (isTypeOnlyClause(m[1])) continue
    out.push({ specifier: m[3], line: lineOf(starts, m.index ?? 0) })
  }
  for (const m of source.matchAll(SIDE_EFFECT)) {
    out.push({ specifier: m[2], line: lineOf(starts, m.index ?? 0) })
  }
  for (const m of source.matchAll(CALL)) {
    const index = m.index ?? 0
    const line = lineOf(starts, index)
    const lineText = source.slice(starts[line - 1], index).trim()
    if (lineText.startsWith('*') || lineText.startsWith('//') || lineText.startsWith('/*')) continue
    if (m[1] === 'import') {
      if (/\btypeof\s*$/.test(source.slice(Math.max(0, index - 16), index))) continue
      const after = /^\s*\.\s*([A-Za-z_$][\w$]*)/.exec(source.slice(index + m[0].length, index + m[0].length + 64))
      if (after && !['then', 'catch', 'finally'].includes(after[1])) continue
    }
    out.push({ specifier: m[3], line })
  }
  return out
}

export interface LibImportEdge {
  /** Importing file, relative to src/lib with forward slashes (e.g. `bookkeeping/engine.ts`). */
  from: string
  /** Imported path, relative to src/lib, without extension (e.g. `invoices/book-service`). */
  to: string
  line: number
}

function listSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue
      listSourceFiles(join(dir, entry.name), acc)
    } else if (/\.tsx?$/.test(entry.name) && !/\.d\.ts$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      acc.push(join(dir, entry.name))
    }
  }
  return acc
}

const toPosix = (p: string) => p.split(sep).join('/')

/** Every runtime import from one src/lib file to another, deduplicated per (from, to). */
export function scanLibImports(libRoot: string): LibImportEdge[] {
  const edges: LibImportEdge[] = []
  for (const file of listSourceFiles(libRoot).sort()) {
    const from = toPosix(relative(libRoot, file))
    const seen = new Set<string>()
    for (const { specifier, line } of extractRuntimeSpecifiers(readFileSync(file, 'utf8'))) {
      let to: string | undefined
      if (specifier.startsWith('@/lib/')) to = specifier.slice('@/lib/'.length)
      else if (specifier.startsWith('./') || specifier.startsWith('../')) {
        const target = toPosix(relative(libRoot, resolve(dirname(file), specifier)))
        if (!target.startsWith('../')) to = target
      }
      if (!to) continue
      to = to.replace(/\.(tsx?|mjs|cjs|js)$/, '')
      if (seen.has(to)) continue
      seen.add(to)
      edges.push({ from, to, line })
    }
  }
  return edges
}

export interface BoundaryReport {
  /** `kernel -> block` edge counts. */
  kernelToBlock: Record<string, number>
  /** `block -> block` edge counts where the target is not in the importer's dependsOn. */
  undeclaredBlockToBlock: Record<string, number>
  /** `kernel -> kernel` edge counts against the declared direction (platform must not import ledger). */
  undeclaredKernelToKernel: Record<string, number>
  /** The edges behind every key, for the failure message. */
  edgesByKey: Record<string, LibImportEdge[]>
}

/**
 * Classifies scanned edges with the manifest. Imports inside a module, into
 * infrastructure, and from a block into the kernel are always allowed; what
 * is left is a kernel reaching into a block, a block reaching into a block
 * it does not declare, or a kernel importing a kernel it does not declare.
 */
export function boundaryReport(edges: readonly LibImportEdge[]): BoundaryReport {
  const kernelToBlock: Record<string, number> = {}
  const undeclaredBlockToBlock: Record<string, number> = {}
  const undeclaredKernelToKernel: Record<string, number> = {}
  const edgesByKey: Record<string, LibImportEdge[]> = {}
  for (const edge of edges) {
    const fromId = moduleForLibPath(edge.from)
    const toId = moduleForLibPath(edge.to)
    if (!fromId || !toId || fromId === toId) continue
    const from = getModule(fromId)
    const to = getModule(toId)
    const declared = from.dependsOn.includes(toId as ModuleId)
    let bucket: Record<string, number>
    if (from.kind === 'kernel' && to.kind === 'block') bucket = kernelToBlock
    else if (from.kind === 'kernel' && !declared) bucket = undeclaredKernelToKernel
    else if (from.kind === 'block' && to.kind === 'block' && !declared) bucket = undeclaredBlockToBlock
    else continue
    const key = `${fromId} -> ${toId}`
    bucket[key] = (bucket[key] ?? 0) + 1
    ;(edgesByKey[key] ??= []).push(edge)
  }
  return { kernelToBlock, undeclaredBlockToBlock, undeclaredKernelToKernel, edgesByKey }
}

/** The src/lib folder whose seams compositionSeamReport watches. */
export const COMPOSITION_FOLDER = 'lib/composition/'

export interface CompositionSeamReport {
  /**
   * `importer -> composition module` edges from anywhere under src
   * (`lib/bookkeeping/engine.ts -> lib/composition/reversal-hooks`), the
   * composition folder itself excluded.
   */
  importers: string[]
  /**
   * `composition file -> imported module` edges for every runtime import a
   * composition file makes: src-relative paths for code under src
   * (`lib/composition/reversal-hooks.ts -> lib/bookkeeping/payment-sync`),
   * the bare specifier for a package.
   */
  imports: string[]
}

/**
 * Who imports the composition seams under src/lib/composition, and what
 * they import. Scans every runtime import under src (routes, components and
 * extensions too, not only src/lib), with the same counting rules as
 * scanLibImports. Sorted, deduplicated.
 */
export function compositionSeamReport(srcRoot: string): CompositionSeamReport {
  const importers = new Set<string>()
  const imports = new Set<string>()
  for (const file of listSourceFiles(srcRoot).sort()) {
    const from = toPosix(relative(srcRoot, file))
    const inComposition = from.startsWith(COMPOSITION_FOLDER)
    for (const { specifier } of extractRuntimeSpecifiers(readFileSync(file, 'utf8'))) {
      let to: string
      if (specifier.startsWith('@/tests/') || specifier.startsWith('@/scripts/')) to = specifier
      else if (specifier.startsWith('@/')) to = specifier.slice(2)
      else if (specifier.startsWith('./') || specifier.startsWith('../')) {
        to = toPosix(relative(srcRoot, resolve(dirname(file), specifier)))
      } else to = specifier
      to = to.replace(/\.(tsx?|mjs|cjs|js)$/, '').replace(/\/index$/, '')
      if (inComposition) imports.add(`${from} -> ${to}`)
      else if (`${to}/`.startsWith(COMPOSITION_FOLDER)) importers.add(`${from} -> ${to}`)
    }
  }
  return { importers: [...importers].sort(), imports: [...imports].sort() }
}
