#!/usr/bin/env node
/**
 * Guard: a 'use client' module whose static import closure reaches the
 * bookkeeping engine (lib/bookkeeping/engine.ts) or the BAS reference data
 * (lib/bookkeeping/bas-reference.ts, lib/bookkeeping/bas-data/).
 *
 * Neither belongs in a browser bundle. The engine writes journal entries
 * through RPCs and drags the accruals service, the error classes and the
 * account backfill (and with it the whole BAS chart) along; the BAS
 * reference is the full 2026 kontoplan, several hundred kilobytes of account
 * rows. Before 2026-10-11 the invoice page and the send dialog pulled the
 * engine for a one-line booking-mode helper (via lib/invoices/
 * issue-credit-note.ts), the ROT/RUT page for computeRefusedShares (via
 * lib/invoices/rot-rut-reclaim.ts), and the invoice editor and the bank
 * settings pulled the chart for two payee predicates (via
 * lib/cash-accounts/invoice-payee.ts). The fix is always the same: move the
 * pure part into a sibling module and import that from the client (see
 * lib/bookkeeping/booking-mode.ts, lib/invoices/rot-rut-refused-shares.ts,
 * lib/cash-accounts/invoice-payee-rules.ts). A client that needs an account
 * name asks the company's chart (lib/reference-data) or the server.
 *
 * No baseline: the count is 0, any new reacher is a hard failure. The walk
 * is the same static closure scripts/perf/client-import-closure.mjs prints:
 * dynamic import() and `import type` are not edges.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildGraph } from '../perf/client-import-closure.mjs'

/** Repo-relative (to src) targets; a trailing slash means every file below it. */
export const SERVER_ONLY_TARGETS = [
  'lib/bookkeeping/engine.ts',
  'lib/bookkeeping/bas-reference.ts',
  'lib/bookkeeping/bas-data/',
]

function targetOf(relativeFile) {
  return SERVER_ONLY_TARGETS.find((t) => (t.endsWith('/') ? relativeFile.startsWith(t) : relativeFile === t))
}

/**
 * [{ file, target, chain }] for every client file reaching a server-only
 * target: one finding per (client file, target) with the shortest chain.
 */
export function findClientServerOnlyReachers(root) {
  const graph = buildGraph(root)
  const targetByFile = new Map()
  for (const file of graph.keys()) {
    const target = targetOf(path.relative(root, file).split(path.sep).join('/'))
    if (target) targetByFile.set(file, target)
  }
  const findings = []
  for (const [file, node] of graph) {
    if (!node.client) continue
    const prev = new Map([[file, null]])
    const queue = [file]
    const reached = new Map()
    while (queue.length) {
      const cur = queue.shift()
      const target = targetByFile.get(cur)
      if (target && !reached.has(target)) reached.set(target, cur)
      for (const next of graph.get(cur)?.edges ?? []) {
        if (next.startsWith('bare:') || prev.has(next)) continue
        prev.set(next, cur)
        queue.push(next)
      }
    }
    for (const [target, hit] of reached) {
      const chain = []
      for (let n = hit; n; n = prev.get(n)) chain.unshift(path.relative(root, n))
      findings.push({ file: path.relative(root, file), target, chain })
    }
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.target.localeCompare(b.target))
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')
  const findings = findClientServerOnlyReachers(root)
  for (const f of findings) console.log(`${f.file} -> ${f.target}\n    ${f.chain.join('\n    > ')}`)
  console.log(`${findings.length} client file(s) reach server-only bookkeeping code`)
  process.exit(findings.length ? 1 : 0)
}
