#!/usr/bin/env node
/**
 * Guard: a 'use client' module whose static import closure reaches a Node
 * builtin (crypto, buffer, vm, stream, fs, ...).
 *
 * Turbopack polyfills those for the browser (crypto-browserify, vm-browserify,
 * Buffer: ~327 KB uncompressed) the moment ANY client module can reach them,
 * and the polyfill chunk then ships with every route that renders the
 * component. Before the 2026-08-26 split, lib/auth/bankid.ts (login,
 * register, security settings), lib/import/bank-file/parser.ts (bank import
 * history), lib/salary/personnummer.ts (via tax-column, the employee forms)
 * and lib/auth/api-keys.ts (the API key panel) each did this for a function
 * that never touched crypto. The fix is always the same: move the pure part
 * into a sibling module without the Node import and import that from the
 * client (see bankid-flags.ts, bank-file/formats.ts, personnummer-format.ts,
 * api-key-scopes.ts).
 *
 * No baseline: the count is 0, any new reacher is a hard failure. The walk
 * is the same static closure scripts/perf/client-import-closure.mjs prints.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildGraph, clientReachers } from '../perf/client-import-closure.mjs'

export const NODE_BUILTINS = ['crypto', 'node:crypto', 'buffer', 'node:buffer', 'vm', 'node:vm', 'stream', 'node:stream', 'fs', 'node:fs', 'path', 'node:path', 'child_process', 'node:child_process']

/** [{ file, builtin, chain }] for every client file reaching a builtin. */
export function findClientNodeBuiltins(root) {
  const graph = buildGraph(root)
  const findings = []
  for (const builtin of NODE_BUILTINS) {
    for (const [file, chain] of clientReachers(graph, `bare:${builtin}`, root)) {
      findings.push({ file, builtin, chain })
    }
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.builtin.localeCompare(b.builtin))
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const findings = findClientNodeBuiltins(root)
  for (const f of findings) console.log(`${f.file} -> ${f.builtin}\n    ${f.chain.join('\n    > ')}`)
  console.log(`${findings.length} client file(s) reach a Node builtin`)
  process.exit(findings.length ? 1 : 0)
}
