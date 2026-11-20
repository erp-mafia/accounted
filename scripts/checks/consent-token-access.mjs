#!/usr/bin/env node
/**
 * Guard: provider_consent_tokens read or written outside its sealed accessor.
 *
 * The table holds the tokens that open a customer's books at Fortnox, Visma,
 * Bokio, Björn Lundén, Briox and WINT. Its first migration called it
 * "Encrypted token storage", yet four hand-written queries in two files wrote
 * the raw tokens, so every row was plaintext until accounted#58. The sealing
 * now lives in one module, lib/providers/consent-tokens.ts, which seals every
 * token it writes and opens every token it reads. A query anywhere else that
 * writes the table (insert, upsert, update) or reads a token column
 * (`select()`, `select('*')`, a select naming access_token or refresh_token,
 * or an embed `provider_consent_tokens(*)`) is the same bug again.
 *
 * Reads of the non-secret columns (consent_id, provider_company_id) and
 * deletes stay allowed. No baseline: the count is 0, any finding is a hard
 * failure.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const CONSENT_TOKEN_SANCTIONED = new Set(['lib/providers/consent-tokens.ts'])

export const CONSENT_TOKEN_HINT =
  '  -> read and write provider_consent_tokens through lib/providers/consent-tokens.ts\n' +
  '     (readConsentTokens, saveConsentTokens, updateConsentTokens): it seals every token\n' +
  '     at rest and opens legacy plaintext rows (accounted#58).'

const SCAN_DIRS = ['app', 'components', 'extensions', 'lib']
const IGNORE_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'coverage', '__tests__'])

const FROM_TABLE = String.raw`\.from\(\s*['"\x60]provider_consent_tokens['"\x60]\s*\)\s*\.\s*`
const WRITE_RE = new RegExp(String.raw`${FROM_TABLE}(?:insert|upsert|update)\(`, 'g')
const TOKEN_SELECT_RE = new RegExp(
  String.raw`${FROM_TABLE}select\(\s*(?:\)|['"\x60][^'"\x60]*(?:\*|access_token|refresh_token))`,
  'g',
)
const TOKEN_EMBED_RE = /provider_consent_tokens\s*(?:![\w]+\s*)?\(\s*(?:\*|[^)]*(?:access_token|refresh_token))/g

/** Findings for one file's source: `{ kind: 'write' | 'read', line }`. */
export function findConsentTokenAccessInSource(source) {
  const findings = []
  const lineOf = (index) => source.slice(0, index).split('\n').length
  for (const match of source.matchAll(WRITE_RE)) findings.push({ kind: 'write', line: lineOf(match.index ?? 0) })
  for (const re of [TOKEN_SELECT_RE, TOKEN_EMBED_RE]) {
    for (const match of source.matchAll(re)) findings.push({ kind: 'read', line: lineOf(match.index ?? 0) })
  }
  return findings.sort((a, b) => a.line - b.line)
}

function walk(dir, out) {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.(?:ts|tsx|js|mjs)$/.test(entry.name) && !/\.test\.(?:ts|tsx|js|mjs)$/.test(entry.name)) out.push(full)
  }
}

/** `[{ file, line, kind }]` for every token read or write outside the accessor. */
export function findConsentTokenAccess(root) {
  const files = []
  for (const dir of SCAN_DIRS) walk(path.join(root, dir), files)
  const findings = []
  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep).join('/')
    if (CONSENT_TOKEN_SANCTIONED.has(rel)) continue
    for (const f of findConsentTokenAccessInSource(fs.readFileSync(file, 'utf8'))) findings.push({ file: rel, ...f })
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')
  const findings = findConsentTokenAccess(root)
  for (const f of findings) console.log(`${f.file}:${f.line} (${f.kind})`)
  console.log(`${findings.length} provider_consent_tokens token access(es) outside the accessor`)
  process.exit(findings.length ? 1 : 0)
}
