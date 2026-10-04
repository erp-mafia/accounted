#!/usr/bin/env node
/**
 * Guard: the name of a provider whose contract is not signed yet, anywhere in
 * a public change.
 *
 * Collections and delivery run through a provider that lives only behind
 * Accounted Connect (the private repo). Until the founder confirms the
 * contract is signed, this public repository must not name it: not in code,
 * comments, tests, fixtures, migrations, translations, docs, scripts, file
 * paths, branch names, commit messages, PR titles or PR bodies. The
 * provider's name, terms and fee wording reach the product at runtime from
 * the Connect catalogue instead (lib/collections/catalogue.ts), and tests use
 * a made-up provider.
 *
 * Where the names come from: UNSIGNED_PROVIDER_NAMES, a comma-separated
 * secret held by the maintainers and by CI (a GitHub Actions secret), never
 * written into the repository. A pinned public fingerprint of a name (a hash
 * of a six-letter word, say) would not do: anyone can hash a guess and
 * confirm it, which discloses exactly what the guard exists to keep quiet.
 * Without the secret the check is skipped with a note.
 *
 * How it matches: case-insensitive substring search on the lower-cased text,
 * which catches the name inflected or compounded (a genitive, a name glued to
 * another word), in camelCase or PascalCase identifiers and inside host
 * names. Findings report where, never what: CI logs are public.
 *
 * Two entry points:
 *   - check:guards (no-new-antipatterns.mjs) scans the added lines and the
 *     file paths of the whole change against the merge base: committed
 *     changes, uncommitted ones and untracked files. Without a merge base (a
 *     shallow CI checkout) it says so and passes: the provider-names workflow
 *     scans the same change with full history.
 *   - .github/workflows/provider-names.yml runs this file with --pr-text,
 *     which also scans the PR title, body, branch name and every commit
 *     message of the PR range.
 *
 * Usage:
 *   UNSIGNED_PROVIDER_NAMES=<name>[,<name>...] \
 *     node scripts/checks/unsigned-provider-names.mjs [--base <ref>] [--pr-text]
 *     --base      ref to diff against (default: PROVIDER_NAMES_BASE, else
 *                 origin/$GITHUB_BASE_REF, else origin/main)
 *     --pr-text   also scan PR_TITLE, PR_BODY and PR_BRANCH (environment)
 *                 and the commit messages of <base>..HEAD
 *
 * Exit code 1 when anything matched.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** A shorter name would match inside ordinary words. */
export const MIN_NAME_LENGTH = 4

/**
 * Files allowed to name the provider. Empty until the contract is signed;
 * then the privacy policy and the data processing agreement pages gain the
 * provider as a named recipient, and exactly those two files are listed here
 * in the same PR.
 */
export const UNSIGNED_PROVIDER_NAME_ALLOWLIST = Object.freeze([])

/**
 * The guarded names from UNSIGNED_PROVIDER_NAMES: lower-cased, trimmed,
 * de-duplicated. Throws on a name shorter than MIN_NAME_LENGTH, so a typo in
 * the secret cannot turn the guard into one that matches everything.
 *
 * @param {Record<string, string | undefined>} [env]
 */
export function readGuardedNames(env = process.env) {
  const names = (env.UNSIGNED_PROVIDER_NAMES ?? '')
    .split(',')
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean)
  for (const name of names) {
    if (name.length < MIN_NAME_LENGTH) {
      throw new Error(`UNSIGNED_PROVIDER_NAMES holds a name shorter than ${MIN_NAME_LENGTH} characters`)
    }
  }
  return [...new Set(names)]
}

/** Every place in `text` where a guarded name starts, as { index, length }, in order. */
export function findGuardedNames(text, names) {
  const lower = text.toLowerCase()
  const found = []
  for (const name of names) {
    for (let at = lower.indexOf(name); at !== -1; at = lower.indexOf(name, at + 1)) {
      found.push({ index: at, length: name.length })
    }
  }
  return found.sort((a, b) => a.index - b.index || a.length - b.length)
}

/** Findings in a block of text, as { where, line, column, length }; `label` names the source. */
export function scanText(text, label, names) {
  const findings = []
  text.split('\n').forEach((lineText, i) => {
    for (const hit of findGuardedNames(lineText, names)) {
      findings.push({ where: label, line: i + 1, column: hit.index + 1, length: hit.length })
    }
  })
  return findings
}

/**
 * The added lines of a unified diff, as { file, line, text }, plus every path
 * the diff touches (old and new names of a rename) as { file, line: 0, text: path }.
 */
export function parseDiff(diffText) {
  const out = []
  let file = null
  let newLine = 0
  // File headers (---, +++, rename) only appear between `diff --git` and the
  // first hunk; inside a hunk a line "+++ x" is an added line "++ x".
  let inHeader = false
  // A binary file's header has no ---/+++ lines ("Binary files ... differ"),
  // so its paths come from the `diff --git` line instead.
  let gitLinePaths = null
  let headerNamedPaths = false
  const flushGitLinePaths = () => {
    if (gitLinePaths && !headerNamedPaths) {
      for (const p of gitLinePaths) out.push({ file: p, line: 0, text: p })
    }
    gitLinePaths = null
  }
  for (const raw of diffText.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      flushGitLinePaths()
      file = null
      inHeader = true
      headerNamedPaths = false
      const rest = raw.slice('diff --git '.length)
      const m = /^a\/(.+) b\/(.+)$/.exec(rest)
      gitLinePaths = m ? [...new Set([m[1], m[2]])] : [rest]
      continue
    }
    if (inHeader) {
      if (raw.startsWith('+++ ')) {
        const target = raw.slice(4).trim()
        if (target !== '/dev/null') {
          file = target.replace(/^b\//, '')
          out.push({ file, line: 0, text: file })
          headerNamedPaths = true
        }
        continue
      }
      if (raw.startsWith('--- ')) {
        const source = raw.slice(4).trim()
        if (source !== '/dev/null') {
          file = source.replace(/^a\//, '')
          out.push({ file, line: 0, text: file })
          headerNamedPaths = true
        }
        continue
      }
      if (raw.startsWith('rename from ') || raw.startsWith('rename to ')) {
        const p = raw.replace(/^rename (from|to) /, '')
        if (raw.startsWith('rename to ')) file = p
        out.push({ file: p, line: 0, text: p })
        headerNamedPaths = true
        continue
      }
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (hunk) {
      flushGitLinePaths()
      inHeader = false
      newLine = Number(hunk[1])
      continue
    }
    if (inHeader || !file) continue
    if (raw.startsWith('+')) {
      out.push({ file, line: newLine, text: raw.slice(1) })
      newLine++
    } else if (raw.startsWith(' ')) {
      newLine++
    }
  }
  flushGitLinePaths()
  return out
}

/** Findings in a unified diff's added lines and paths, allowlisted files skipped. */
export function scanDiff(diffText, options) {
  const allowlist = new Set(options.allowlist ?? UNSIGNED_PROVIDER_NAME_ALLOWLIST)
  const findings = []
  const seen = new Set()
  for (const entry of parseDiff(diffText)) {
    if (allowlist.has(entry.file)) continue
    const key = `${entry.file}:${entry.line}:${entry.text}`
    if (seen.has(key)) continue
    seen.add(key)
    for (const hit of findGuardedNames(entry.text, options.names)) {
      findings.push({
        where: entry.line === 0 ? `${entry.file} (path)` : entry.file,
        line: entry.line,
        column: hit.index + 1,
        length: hit.length,
      })
    }
  }
  return findings
}

/**
 * Findings in a PR's own text: title, body, branch name and commit messages
 * ({ title, body, branch, commits: [{ sha, message }] }).
 */
export function scanPrText(pr, names) {
  const findings = [
    ...scanText(pr.title ?? '', 'PR title', names),
    ...scanText(pr.body ?? '', 'PR body', names),
    ...scanText(pr.branch ?? '', 'branch name', names),
  ]
  for (const commit of pr.commits ?? []) {
    findings.push(...scanText(commit.message, `commit ${commit.sha.slice(0, 12)} message`, names))
  }
  return findings
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 })
}

/** @param {Record<string, string | undefined>} [env] */
export function defaultBaseRef(env = process.env) {
  if (env.PROVIDER_NAMES_BASE) return env.PROVIDER_NAMES_BASE
  if (env.GITHUB_BASE_REF) return `origin/${env.GITHUB_BASE_REF}`
  return 'origin/main'
}

/** The merge base of `ref` and HEAD, or null when this checkout cannot tell (shallow, unknown ref). */
export function resolveMergeBase(ref) {
  try {
    return git(['merge-base', ref, 'HEAD']).trim() || null
  } catch {
    return null
  }
}

/** Untracked, non-ignored files as a synthetic "added" diff (a local run, before `git add`). */
function untrackedAsDiff() {
  const files = git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)
  const parts = []
  for (const file of files) {
    let content = ''
    try {
      const buf = fs.readFileSync(path.join(ROOT, file))
      // Binary files carry no text to scan; their path still is.
      content = buf.includes(0) ? '' : buf.toString('utf8')
    } catch {
      content = ''
    }
    const lines = content === '' ? [] : content.split('\n')
    parts.push(`diff --git a/${file} b/${file}`, '--- /dev/null', `+++ b/${file}`, `@@ -0,0 +1,${lines.length} @@`)
    for (const l of lines) parts.push(`+${l}`)
  }
  return parts.join('\n')
}

/**
 * The whole change against the merge base with `baseRef`: committed,
 * uncommitted and untracked. `skipped` says why nothing was scanned:
 * 'no-names' (UNSIGNED_PROVIDER_NAMES unset) or 'no-base' (no merge base in
 * this checkout).
 */
export function checkWorkingChange(baseRef = defaultBaseRef(), names = readGuardedNames()) {
  if (names.length === 0) return { skipped: 'no-names', base: null, baseRef, findings: [] }
  const base = resolveMergeBase(baseRef)
  if (!base) return { skipped: 'no-base', base: null, baseRef, findings: [] }
  const diffArgs = ['diff', '--no-color', '--no-ext-diff', '--unified=0', '-M']
  const diff = [git([...diffArgs, base]), untrackedAsDiff()].join('\n')
  return { skipped: null, base, baseRef, findings: scanDiff(diff, { names }) }
}

/** Commit messages of base..HEAD (merge commits included: a PR merge ref ends in one). */
export function commitMessages(base) {
  const out = git(['log', '--format=%H%x1f%B%x1e', `${base}..HEAD`])
  return out
    .split('\x1e')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [sha, ...rest] = chunk.split('\x1f')
      return { sha, message: rest.join('\x1f') }
    })
}

export function formatFinding(f) {
  const at = f.line > 0 ? `${f.where}:${f.line}:${f.column}` : `${f.where}, column ${f.column}`
  return `    ${at}  a guarded provider name (${f.length} characters)`
}

export const HINT =
  '  → the provider is not signed yet: describe it by its role (the collections provider, the\n' +
  '    agency) or read it at runtime from the Connect catalogue; tests use "Acme Inkasso".\n' +
  '    Rewrite the text, amend the commit message, or rename the branch.'

export const NO_NAMES_NOTE =
  'UNSIGNED_PROVIDER_NAMES is not set (a maintainer and CI secret), so no provider name was checked'

function main(argv) {
  const baseIndex = argv.indexOf('--base')
  const baseRef = baseIndex >= 0 ? argv[baseIndex + 1] : defaultBaseRef()
  const withPrText = argv.includes('--pr-text')

  const change = checkWorkingChange(baseRef)
  if (change.skipped === 'no-names') {
    // A warning annotation in CI, a note locally: a fork's PR never gets the secret.
    console.log(process.env.GITHUB_ACTIONS ? `::warning::${NO_NAMES_NOTE}.` : `· unsigned-provider-names: ${NO_NAMES_NOTE}.`)
    return
  }
  if (change.skipped === 'no-base') {
    console.error(`✗ unsigned-provider-names: no merge base with ${baseRef} in this checkout (fetch full history)`)
    process.exit(1)
  }
  const names = readGuardedNames()
  const findings = [...change.findings]
  if (withPrText) {
    findings.push(
      ...scanPrText(
        {
          title: process.env.PR_TITLE ?? '',
          body: process.env.PR_BODY ?? '',
          branch: process.env.PR_BRANCH ?? '',
          commits: commitMessages(change.base),
        },
        names,
      ),
    )
  }
  if (findings.length) {
    console.error(`\n✗ unsigned-provider-names: ${findings.length} place(s) name a provider that is not signed yet:`)
    findings.forEach((f) => console.error(formatFinding(f)))
    console.error(HINT)
    process.exit(1)
  }
  console.log(
    `✓ unsigned-provider-names: nothing named in the change against ${baseRef}${withPrText ? ', the PR text or the commit messages' : ''}.`,
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
}
