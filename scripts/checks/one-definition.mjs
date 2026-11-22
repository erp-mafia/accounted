#!/usr/bin/env node
/**
 * Guard: one business rule, one definition.
 *
 * A study of 200 random fix commits (2026-11-01) found that about half of the
 * real defects would not have existed, or would have been fixed by one
 * change, had the rule had one definition. Exact code clones are a fraction
 * of a percent of src: the defect is the same rule written differently behind
 * different doors, so a fix reaches the copy its author happened to touch.
 *
 * Each file in scripts/checks/one-definition/ is one rule and one default
 * export: what the rule says, where its one definition lives, why it has one,
 * and the shape of a line that writes the rule again. A file per rule keeps
 * parallel changes from conflicting, and the folder is the register of rules
 * that have a home. Add a rule file in the change that gives a rule its home.
 *
 *   rule        kebab-case name, the same as the file name
 *   says        the rule, one sentence
 *   home        the one definition, 'src/lib/x.ts: functionName'
 *   why         the failure that made it one rule, one sentence
 *   match       regexes that flag a line writing the rule by hand
 *   sanctioned  source-relative files that may match: the home and its parts
 *   allowed     { file: reason } for sites where a match is correct. May only
 *               shrink. An entry that no longer matches is reported as stale.
 *   scan        optional source-relative path prefixes, default everywhere
 *
 * Tests, comments and generated files are not scanned.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const RULE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'one-definition')
const SCAN_DIRS = ['app', 'components', 'extensions', 'lib']
const IGNORE_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'coverage', '__tests__'])
const SOURCE_FILE_RE = /\.(ts|tsx)$/
const TEST_FILE_RE = /\.test\.(ts|tsx)$/
const COMMENT_LINE_RE = /^\s*(\/\/|\/\*|\*)/
const REQUIRED_FIELDS = ['rule', 'says', 'home', 'why', 'match']

export const ONE_DEFINITION_HINT =
  '  This line writes a rule that already has one definition. Call the definition named above.\n' +
  '  If this site is truly a different rule, name the reason in the rule file under `allowed`.'

/** Rejects a rule file that could not teach the reader anything. */
export function validateRule(rule, fileName) {
  for (const field of REQUIRED_FIELDS) {
    if (!rule?.[field] || (Array.isArray(rule[field]) && rule[field].length === 0)) {
      throw new Error(`one-definition rule ${fileName}: missing ${field}`)
    }
  }
  if (`${rule.rule}.mjs` !== fileName) {
    throw new Error(`one-definition rule ${fileName}: rule is named ${rule.rule}`)
  }
  if (!rule.match.every((re) => re instanceof RegExp)) {
    throw new Error(`one-definition rule ${fileName}: match holds regexes only`)
  }
  return rule
}

export async function loadOneDefinitionRules(dir = RULE_DIR) {
  if (!fs.existsSync(dir)) return []
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort()
  return Promise.all(
    files.map(async (file) => {
      const mod = await import(pathToFileURL(path.join(dir, file)).href)
      return validateRule(mod.default, file)
    }),
  )
}

function listSourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) listSourceFiles(full, out)
    else if (SOURCE_FILE_RE.test(entry.name) && !TEST_FILE_RE.test(entry.name)) out.push(full)
  }
  return out
}

// A rule's regexes without the g flag (a g regex keeps lastIndex between
// test() calls), compiled once per rule rather than once per line.
const compiledMatchers = new WeakMap()
function matchersOf(rule) {
  let matchers = compiledMatchers.get(rule)
  if (!matchers) {
    matchers = rule.match.map((re) => new RegExp(re.source, re.flags.replace('g', '')))
    compiledMatchers.set(rule, matchers)
  }
  return matchers
}

/** The lines of a source text that are not comments, with their 0-based index. */
function codeLines(source) {
  const lines = []
  source.split('\n').forEach((text, index) => {
    if (!COMMENT_LINE_RE.test(text)) lines.push([index, text])
  })
  return lines
}

function ruleHits(lines, matchers) {
  const hits = []
  for (const [index, text] of lines) {
    if (
      matchers.some((re) => {
        re.lastIndex = 0
        return re.test(text)
      })
    ) {
      hits.push({ line: index + 1, text: text.trim() })
    }
  }
  return hits
}

/** The lines of one source text that write a rule by hand. */
export function findRuleLines(source, rule) {
  return ruleHits(codeLines(source), matchersOf(rule))
}

export function findOneDefinitionFindings(sourceRoot, rules) {
  const findings = []
  const stale = []
  if (rules.length === 0) return { findings, stale }

  // Every file is read and split into its code lines once, for all rules.
  const sources = new Map()
  for (const scanDir of SCAN_DIRS) {
    const absolute = path.join(sourceRoot, scanDir)
    if (!fs.existsSync(absolute)) continue
    for (const file of listSourceFiles(absolute)) {
      const relative = path.relative(sourceRoot, file).split(path.sep).join('/')
      sources.set(relative, codeLines(fs.readFileSync(file, 'utf8')))
    }
  }

  for (const rule of rules) {
    const sanctioned = new Set(rule.sanctioned ?? [])
    const allowed = new Set(Object.keys(rule.allowed ?? {}))
    const matched = new Set()
    const matchers = matchersOf(rule)
    for (const [file, lines] of sources) {
      if (rule.scan && !rule.scan.some((prefix) => file.startsWith(prefix))) continue
      const hits = ruleHits(lines, matchers)
      if (hits.length === 0) continue
      matched.add(file)
      if (sanctioned.has(file) || allowed.has(file)) continue
      for (const hit of hits) findings.push({ rule: rule.rule, home: rule.home, why: rule.why, file, ...hit })
    }
    for (const file of allowed) {
      if (!matched.has(file)) stale.push({ rule: rule.rule, file })
    }
  }
  return { findings, stale }
}
