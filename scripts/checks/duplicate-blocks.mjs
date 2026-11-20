#!/usr/bin/env node
/**
 * Guard: duplicated code blocks across files.
 *
 * Agents insert a new block more readily than they find the function that
 * already does the job: GitClear's 2026 Maintainability Gap (623M changes,
 * 2023 to 2026) measured duplicated blocks up 81% and cross-file reuse down
 * 35%, and the October 2026 coherence audit found the same shape here (twelve
 * posting-line types, five payment dialogs, three inbox proposal generators,
 * each a copy that drifted). This sensor makes a new copy visible the moment
 * it lands, with both locations, so the fix is "reuse it", not "find it".
 *
 * How: every scanned file (src/**\/*.{ts,tsx}, tests, fixtures and generated
 * files excluded) is normalised to its meaningful lines: trimmed, inner
 * whitespace collapsed, and blank lines, comments, import/re-export
 * statements, "use client"/"use server" directives and lines that are only
 * punctuation or a closing JSX tag dropped. A window of WINDOW consecutive
 * normalised lines is hashed; a window that occurs in two or more different
 * files is a duplicate, and overlapping windows of one file pair merge into
 * one block. Copies inside a single file are out of scope.
 *
 * The ratchet is per file pair, on the number of normalised lines the pair
 * shares: a new pair fails, an existing pair may not grow. Per pair (not one
 * global count) so that one team deleting a copy cannot hide another team's
 * new one; on lines (not blocks) so that editing a line in the middle of an
 * existing copy, which splits one block into two, does not read as growth.
 *
 * WINDOW is 10: at 8, JSX form rows and route-handler preambles dominate the
 * findings; at 12, real copied helpers of 10-11 meaningful lines slip through
 * (counts measured on main 2026-10-18 in the decision file).
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const WINDOW = 10

export const DUPLICATE_BLOCK_HINT =
  'Reuse or extract the shared code (search for an existing helper first); do not copy.'

const IGNORE_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'coverage', '__tests__', '__fixtures__', '_generated'])
const GENERATED_HEADER = /AUTO-GENERATED|@generated|DO NOT EDIT/

function* walk(dir) {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) yield full
  }
}

const PUNCTUATION_ONLY = /^[\][(){};,]+$/
const CLOSING_JSX = /^(?:<\/[\w.:-]*>|\/?>|<>)$/
const DIRECTIVE = /^['"]use (?:client|server)['"];?$/

/**
 * The meaningful lines of a source file, each with its 1-based line number.
 * Exported for the tests.
 */
export function normalizeSource(src) {
  const out = []
  const lines = src.split('\n')
  let inBlockComment = false
  let inModuleList = false
  for (let i = 0; i < lines.length; i++) {
    let text = lines[i].trim()
    if (inBlockComment) {
      if (text.includes('*/')) inBlockComment = false
      continue
    }
    if (inModuleList) {
      // A multi-line import or re-export list ends at its `from '...'` or at
      // the closing brace of a local `export { ... }`.
      if (/\bfrom\s+['"]/.test(text) || /^\}/.test(text)) inModuleList = false
      continue
    }
    if (!text) continue
    if (text.startsWith('//')) continue
    if (text.startsWith('/*')) {
      if (!text.includes('*/')) inBlockComment = true
      continue
    }
    if (/^import\b/.test(text) || /^export\s+(?:\*|\{|type\s+\{)/.test(text)) {
      const complete = /\bfrom\s+['"]/.test(text) || /^import\s+['"]/.test(text) || (text.includes('{') && text.includes('}'))
      if (!complete) inModuleList = true
      continue
    }
    if (DIRECTIVE.test(text) || PUNCTUATION_ONLY.test(text) || CLOSING_JSX.test(text)) continue
    text = text.replace(/\s+/g, ' ')
    out.push({ text, line: i + 1 })
  }
  return out
}

/** 32-bit FNV-1a of a string. */
function fnv(str, seed) {
  let h = seed >>> 0
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h
}

/** A 53-bit hash of `window` consecutive line hashes starting at `start`. */
function windowKey(lo, hi, start, window) {
  let a = 2166136261
  let b = 0x9747b28c
  for (let k = start; k < start + window; k++) {
    a = Math.imul(a ^ lo[k], 16777619) >>> 0
    b = Math.imul(b ^ hi[k], 2246822519) >>> 0
  }
  return (a >>> 0) * 2097152 + (b >>> 11)
}

/** Files to scan under `root` (the src directory), as repo-relative paths with their text. */
function scannedFiles(root) {
  const files = []
  for (const full of walk(root)) {
    const src = fs.readFileSync(full, 'utf8')
    if (GENERATED_HEADER.test(src.slice(0, 600))) continue
    files.push({ file: path.relative(root, full).split(path.sep).join('/'), src })
  }
  return files.sort((a, b) => a.file.localeCompare(b.file))
}

/**
 * Duplicated blocks between different files under `root`.
 *
 * Returns { pairs, blocks }: `pairs` is { "a.ts <-> b.ts": shared normalised
 * lines } with keys sorted, `blocks` is one entry per merged block,
 * { a, aLine, b, bLine, lines }, sorted by size, largest first.
 */
export function findDuplicateBlocks(root, { window = WINDOW } = {}) {
  const files = scannedFiles(root).map(({ file, src }) => {
    const norm = normalizeSource(src)
    return {
      file,
      norm,
      lo: Uint32Array.from(norm, (l) => fnv(l.text, 2166136261)),
      hi: Uint32Array.from(norm, (l) => fnv(l.text, 0x811c9dc5 ^ 0x5bd1e995)),
    }
  })

  // First pass: the first occurrence of every window; a window seen again in
  // another file moves to `dups` with all its occurrences.
  const first = new Map()
  const dups = new Map()
  files.forEach((f, fi) => {
    for (let s = 0; s + window <= f.norm.length; s++) {
      const key = windowKey(f.lo, f.hi, s, window)
      const seen = first.get(key)
      if (seen === undefined) {
        first.set(key, fi * 1048576 + s)
        continue
      }
      let occ = dups.get(key)
      if (!occ) {
        occ = [seen]
        dups.set(key, occ)
      }
      occ.push(fi * 1048576 + s)
    }
  })

  // Matching windows per file pair, verified line by line (a hash collision
  // must never surface as a finding).
  const sameWindow = (fa, sa, fb, sb) => {
    for (let k = 0; k < window; k++) if (fa.norm[sa + k].text !== fb.norm[sb + k].text) return false
    return true
  }
  const matchesByPair = new Map()
  for (const occ of dups.values()) {
    for (let x = 0; x < occ.length; x++) {
      for (let y = x + 1; y < occ.length; y++) {
        let fa = Math.floor(occ[x] / 1048576)
        let fb = Math.floor(occ[y] / 1048576)
        if (fa === fb) continue
        let sa = occ[x] % 1048576
        let sb = occ[y] % 1048576
        if (fa > fb) [fa, fb, sa, sb] = [fb, fa, sb, sa]
        if (!sameWindow(files[fa], sa, files[fb], sb)) continue
        const pairKey = fa * 1048576 + fb
        let set = matchesByPair.get(pairKey)
        if (!set) {
          set = new Set()
          matchesByPair.set(pairKey, set)
        }
        set.add(sa * 1048576 + sb)
      }
    }
  }

  // Merge consecutive windows of one pair into blocks.
  const pairs = {}
  const blocks = []
  for (const [pairKey, set] of matchesByPair) {
    const fa = files[Math.floor(pairKey / 1048576)]
    const fb = files[pairKey % 1048576]
    const starts = [...set].sort((p, q) => p - q)
    const consumed = new Set()
    let shared = 0
    for (const m of starts) {
      if (consumed.has(m)) continue
      let run = 0
      while (set.has(m + run * 1048577)) {
        consumed.add(m + run * 1048577)
        run++
      }
      const sa = Math.floor(m / 1048576)
      const sb = m % 1048576
      const lines = window + run - 1
      shared += lines
      blocks.push({
        a: fa.file,
        aLine: fa.norm[sa].line,
        aEnd: fa.norm[sa + lines - 1].line,
        b: fb.file,
        bLine: fb.norm[sb].line,
        bEnd: fb.norm[sb + lines - 1].line,
        lines,
      })
    }
    pairs[`${fa.file} <-> ${fb.file}`] = shared
  }

  blocks.sort((p, q) => q.lines - p.lines || p.a.localeCompare(q.a) || p.aLine - q.aLine)
  return {
    pairs: Object.fromEntries(Object.entries(pairs).sort(([p], [q]) => p.localeCompare(q))),
    blocks,
  }
}

/** The guard's message for one block. */
export function formatDuplicateBlock(block) {
  return `Duplicated block (${block.lines} lines) in ${block.a}:${block.aLine} also in ${block.b}:${block.bLine}. ${DUPLICATE_BLOCK_HINT}`
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')
  const windowArg = process.argv.find((a) => a.startsWith('--window='))
  const window = windowArg ? Number(windowArg.slice('--window='.length)) : WINDOW
  const started = Date.now()
  const { pairs, blocks } = findDuplicateBlocks(root, { window })
  const top = Number((process.argv.find((a) => a.startsWith('--top=')) ?? '--top=20').slice('--top='.length))
  for (const b of blocks.slice(0, top)) console.log(formatDuplicateBlock(b))
  const shared = Object.values(pairs).reduce((n, v) => n + v, 0)
  console.log(
    `window ${window}: ${blocks.length} duplicated block(s), ${Object.keys(pairs).length} file pair(s), ${shared} shared line(s), ${Date.now() - started} ms`,
  )
}
