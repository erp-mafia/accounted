#!/usr/bin/env node
/**
 * Keeps customer data out of merge request titles, descriptions and commit
 * messages (issue #155). Only high-precision rules run:
 *
 *   personnummer   a 10 or 12 digit personnummer or samordningsnummer, with or
 *                  without the - or + separator, whose date exists and whose
 *                  check digit is right. Org numbers never carry a real month,
 *                  so they pass. A number after "pipeline", "job", "!" or "#",
 *                  or inside a URL, is an id and passes.
 *   email          an address outside our own domains, reserved example
 *                  domains and noreply senders.
 *   support_link   a link into a support conversation (PostHog, Gmail, Discord).
 *   app_deep_link  an app.accounted.se link that carries a record id.
 *   customer_name  a name from the customer name list: whole words, the first
 *                  letter of each word as written in the list, a multi-word
 *                  name as one phrase, every word at least 4 characters.
 *
 * The name list is kept outside the repo, one name per line (or a JSON array):
 *   MR_PRIVACY_CUSTOMER_NAMES      the list itself, or the path GitLab gives a
 *                                  File variable
 *   MR_PRIVACY_CUSTOMER_NAMES_B64  the list base64-encoded, so it fits a masked
 *                                  variable
 * Neither may be a protected variable: MR pipelines run on unprotected branches.
 * Without either, the other rules still run and the job says so.
 *
 * Findings print the rule, the field, the line and a masked form of the match,
 * never the match itself.
 *
 * Usage:
 *   npm run check:mr-privacy [-- --base <sha>] [-- --title <text>] [-- --description <text>]
 *   node scripts/check-mr-privacy.mjs --scan <file.json>
 *     scans a JSON array of strings or { label, text } objects, to measure the
 *     rules over past titles, descriptions and commit messages
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

// ---------------------------------------------------------------------------
// personnummer

// A 12 or 10 digit run with an optional separator before the last four
// digits. Not part of a longer run, a word, a decimal, a path or a reference.
const PERSONNUMMER_RE =
  /(?<![\p{L}\p{N}_./#!@-])(\d{2})?(\d{2})(\d{2})(\d{2})([-+]?)(\d{4})(?![\p{L}\p{N}_]|[.,-]\p{N})/gu

// Text right before an id: "pipeline 3034721906", "job: 123...", "!1244",
// "#155", also a list such as "pipelines 3011150000 and 3011150001".
const ID_CONTEXT_RE =
  /(?:\b(?:pipelines?|jobs?|builds?|runs?|runners?|deploy(?:ment)?s?|ids?|iids?|issues?|mrs?|merge requests?|commits?|ocr)\b[\s:#=]*(?:\d+(?:\s*(?:,|and|och|&|\/)\s*|\s+))*|[!#]\s*)$/i

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

/** True when the ten digits YYMMDDNNNC pass the Luhn check. */
export function luhnValid(tenDigits) {
  if (!/^\d{10}$/.test(tenDigits)) return false
  let sum = 0
  for (let i = 0; i < 10; i++) {
    let digit = Number(tenDigits[i])
    if (i % 2 === 0) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
  }
  return sum % 10 === 0
}

/** True when the date part exists; a samordningsnummer adds 60 to the day. */
export function plausibleDate(century, yy, mm, dd, now = new Date()) {
  const month = Number(mm)
  let day = Number(dd)
  if (day > 60) day -= 60
  if (month < 1 || month > 12 || day < 1) return false
  if (century === undefined) return day <= DAYS_IN_MONTH[month - 1]
  const year = Number(`${century}${yy}`)
  if (year < 1870 || year > now.getUTCFullYear()) return false
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function tokenAround(text, start, end) {
  let from = start
  while (from > 0 && !/[\s<>()[\]"'`]/.test(text[from - 1])) from--
  let to = end
  while (to < text.length && !/[\s<>()[\]"'`]/.test(text[to])) to++
  return text.slice(from, to)
}

function isIdContext(text, start) {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1
  const before = text.slice(Math.max(lineStart, start - 60), start)
  if (ID_CONTEXT_RE.test(before)) return true
  const token = tokenAround(text, start, start)
  return /:\/\/|^www\./i.test(token)
}

function findPersonnummer(text, now) {
  const found = []
  for (const m of text.matchAll(PERSONNUMMER_RE)) {
    const [raw, century, yy, mm, dd, , serial] = m
    if (!plausibleDate(century, yy, mm, dd, now)) continue
    if (!luhnValid(`${yy}${mm}${dd}${serial}`)) continue
    if (isIdContext(text, m.index)) continue
    found.push({ index: m.index, masked: raw.replace(/\d/g, '#') })
  }
  return found
}

// ---------------------------------------------------------------------------
// email

const EMAIL_RE = /(?<![\w.%+-])[\w.%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?![\w-])/g

// Our own domains (and their subdomains), the hosts whose addresses show up in
// git and CI text, and the names reserved for examples (RFC 2606, RFC 6761).
const ALLOWED_EMAIL_DOMAINS = [
  'accounted.se',
  'gnubok.se',
  'arcim.se',
  'arcim.io',
  'gitlab.com',
  'github.com',
  'anthropic.com',
  'example.com',
  'example.org',
  'example.net',
  'example.se',
]
const RESERVED_TLDS = ['example', 'test', 'invalid', 'localhost', 'local']
const NOREPLY_LOCAL_RE = /^(?:no-?reply|no_reply|do-?not-?reply)(?:[+.].*)?$/i

export function emailAllowed(address) {
  const at = address.lastIndexOf('@')
  const local = address.slice(0, at)
  const domain = address.slice(at + 1).toLowerCase()
  if (NOREPLY_LOCAL_RE.test(local)) return true
  if (domain.split('.').includes('noreply')) return true
  if (RESERVED_TLDS.includes(domain.split('.').pop())) return true
  return ALLOWED_EMAIL_DOMAINS.some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`))
}

function maskEmail(address) {
  const at = address.lastIndexOf('@')
  const domain = address.slice(at + 1)
  return `${address[0]}***@${domain[0]}***${domain.slice(domain.lastIndexOf('.'))}`
}

function findEmails(text) {
  const found = []
  for (const m of text.matchAll(EMAIL_RE)) {
    if (emailAllowed(m[0])) continue
    found.push({ index: m.index, masked: maskEmail(m[0]) })
  }
  return found
}

// ---------------------------------------------------------------------------
// links

const SUPPORT_LINK_RE =
  /https?:\/\/[^\s<>()]*(?:posthog\.com\/(?:[^\s<>()]*\/)?conversations|mail\.google\.com\/mail|discord(?:app)?\.com\/channels)[^\s<>()]*/gi
const APP_DEEP_LINK_RE =
  /https?:\/\/app\.accounted\.se\/[^\s<>()]*(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|\d{5,}|[?&](?:id|company_id|user_id|invoice_id|document_id)=)[^\s<>()]*/gi

function findLinks(text, re, keepSegments) {
  const found = []
  for (const m of text.matchAll(re)) {
    let masked = '[link]'
    try {
      const url = new URL(m[0])
      const kept = url.pathname.split('/').filter(Boolean).slice(0, keepSegments)
      masked = `${url.protocol}//${url.host}/${kept.map((segment) => `${segment}/`).join('')}...`
    } catch {
      // Not a parseable URL: the placeholder says enough.
    }
    found.push({ index: m.index, masked })
  }
  return found
}

// ---------------------------------------------------------------------------
// customer names

const LEGAL_FORM_RE = /^(?:ab|hb|kb|ef|aktiebolag|handelsbolag|kommanditbolag|\(publ\))$/i
const MIN_WORD_LENGTH = 4

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// The first letter exactly as written, the rest in any case.
function wordPattern(word) {
  const [first, ...rest] = [...word]
  const tail = rest.map((ch) => {
    const lower = ch.toLowerCase()
    const upper = ch.toUpperCase()
    return lower !== upper && lower.length === 1 && upper.length === 1 ? `[${lower}${upper}]` : escapeRegExp(ch)
  })
  return escapeRegExp(first) + tail.join('')
}

/**
 * Reads the name list: one name per line, or a JSON array. A trailing legal
 * form (AB, HB, KB, EF) is dropped so the name matches with or without it. A
 * name with a word shorter than 4 characters is skipped and counted.
 */
export function parseCustomerNames(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return { names: [], skipped: 0 }
  let parts
  if (raw.startsWith('[')) {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) throw new Error('the customer name list must be a JSON array or one name per line')
    parts = parsed.map(String)
  } else {
    parts = raw.split(/\r?\n/)
  }
  const names = []
  const seen = new Set()
  let skipped = 0
  for (const part of parts) {
    const words = part.trim().split(/\s+/).filter(Boolean)
    while (words.length > 1 && LEGAL_FORM_RE.test(words[words.length - 1])) words.pop()
    if (words.length === 0) continue
    if (words.some((word) => [...word].length < MIN_WORD_LENGTH)) {
      skipped++
      continue
    }
    const key = words.join(' ')
    if (seen.has(key)) continue
    seen.add(key)
    names.push({
      number: names.length + 1,
      pattern: new RegExp(`(?<![\\p{L}\\p{N}_])${words.map(wordPattern).join('\\s+')}(?![\\p{L}\\p{N}_])`, 'gu'),
    })
  }
  return { names, skipped }
}

/** The list from the environment: plain, a File variable's path, or base64. */
export function readCustomerNames(env = process.env) {
  const plain = env.MR_PRIVACY_CUSTOMER_NAMES
  if (plain && plain.trim()) {
    const candidate = plain.trim()
    const isFile = !candidate.includes('\n') && fs.existsSync(candidate) && fs.statSync(candidate).isFile()
    return { source: 'MR_PRIVACY_CUSTOMER_NAMES', ...parseCustomerNames(isFile ? fs.readFileSync(candidate, 'utf8') : plain) }
  }
  const encoded = env.MR_PRIVACY_CUSTOMER_NAMES_B64
  if (encoded && encoded.trim()) {
    const decoded = Buffer.from(encoded.trim(), 'base64').toString('utf8')
    return { source: 'MR_PRIVACY_CUSTOMER_NAMES_B64', ...parseCustomerNames(decoded) }
  }
  return { source: null, names: [], skipped: 0 }
}

function findNames(text, names) {
  const found = []
  for (const name of names) {
    for (const m of text.matchAll(name.pattern)) {
      found.push({ index: m.index, masked: `[name ${name.number} of the list]` })
    }
  }
  return found
}

// ---------------------------------------------------------------------------
// scanning

/** Author and sign-off trailers name contributors, not customers. */
export function stripAuthorTrailers(text) {
  return String(text ?? '').replace(/^(?:Co-Authored-By|Signed-off-by):.*$/gim, '')
}

function lineOf(text, index) {
  let line = 1
  for (let i = 0; i < index; i++) if (text[i] === '\n') line++
  return line
}

/**
 * Every finding in one text, each as { rule, line, masked }. The match itself
 * is never part of a finding, so no caller can print it by accident.
 */
export function findPrivacyIssues(text, names = [], now = new Date()) {
  const source = stripAuthorTrailers(text)
  const groups = [
    { rule: 'personnummer', found: findPersonnummer(source, now) },
    { rule: 'email', found: findEmails(source) },
    { rule: 'support_link', found: findLinks(source, SUPPORT_LINK_RE, 0) },
    { rule: 'app_deep_link', found: findLinks(source, APP_DEEP_LINK_RE, 1) },
    { rule: 'customer_name', found: findNames(source, names) },
  ]
  const issues = []
  for (const { rule, found } of groups) {
    for (const hit of found) issues.push({ rule, line: lineOf(source, hit.index), masked: hit.masked })
  }
  return issues
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

/**
 * The MR's title and description. GitLab cuts CI_MERGE_REQUEST_DESCRIPTION at
 * 2,700 characters, so the job first asks the API for the whole text with its
 * job token, and says so when it has to fall back to the cut variable.
 */
export async function readMergeRequest(options = {}, env = process.env, fetchImpl = globalThis.fetch) {
  let title = options.title ?? env.CI_MERGE_REQUEST_TITLE ?? env.MR_TITLE ?? ''
  let description = options.description ?? env.CI_MERGE_REQUEST_DESCRIPTION ?? env.MR_DESCRIPTION ?? ''
  const notes = []
  const canAsk = env.CI_JOB_TOKEN && env.CI_API_V4_URL && env.CI_PROJECT_ID && env.CI_MERGE_REQUEST_IID
  if (options.description === undefined && canAsk && typeof fetchImpl === 'function') {
    const url = `${env.CI_API_V4_URL}/projects/${encodeURIComponent(env.CI_PROJECT_ID)}/merge_requests/${encodeURIComponent(env.CI_MERGE_REQUEST_IID)}`
    try {
      const res = await fetchImpl(url, { headers: { 'JOB-TOKEN': env.CI_JOB_TOKEN }, signal: AbortSignal.timeout(15000) })
      const body = res.ok ? await res.json() : null
      if (body && typeof body.description === 'string') {
        if (options.title === undefined && typeof body.title === 'string') title = body.title
        description = body.description
        notes.push(`MR privacy: read the title and the full description (${description.length} characters) from the GitLab API.`)
        return { title, description, notes }
      }
      notes.push(`MR privacy: the GitLab API did not return the MR to the job token (HTTP ${res.status}); scanning the CI variables.`)
    } catch (error) {
      notes.push(`MR privacy: the GitLab API could not be reached (${error instanceof Error ? error.name : 'error'}); scanning the CI variables.`)
    }
  }
  if (options.description === undefined && env.CI_MERGE_REQUEST_DESCRIPTION_IS_TRUNCATED === 'true') {
    notes.push(`MR privacy: the description is longer than GitLab passes to CI; only its first ${description.length} characters were scanned.`)
  }
  return { title, description, notes }
}

export function collectCommitMessages(options = {}, env = process.env) {
  const base = options.base || env.MR_PRIVACY_BASE || env.CI_MERGE_REQUEST_DIFF_BASE_SHA || 'origin/main'
  const rangeBase = /^0+$/.test(base) ? git(['merge-base', 'origin/main', 'HEAD']).trim() : base
  const log = git(['log', '--format=%H%x1f%B%x1e', `${rangeBase}..HEAD`])
  const entries = []
  for (const record of log.split('\x1e')) {
    if (!record.trim()) continue
    const [sha, ...message] = record.trimStart().split('\x1f')
    entries.push({ label: `commit ${sha.slice(0, 12)}`, text: message.join('\x1f') })
  }
  return entries
}

function report(entries, names) {
  const failures = []
  for (const entry of entries) {
    for (const issue of findPrivacyIssues(entry.text, names)) failures.push({ label: entry.label, ...issue })
  }
  for (const f of failures) console.error(`${f.label}, line ${f.line}: ${f.rule}: ${f.masked}`)
  return failures
}

function nameNotice(list) {
  if (!list.source) {
    return 'MR privacy: no customer name list (MR_PRIVACY_CUSTOMER_NAMES or MR_PRIVACY_CUSTOMER_NAMES_B64 is not set), so the name rule did not run.'
  }
  const skipped = list.skipped ? `; ${list.skipped} skipped for a word shorter than ${MIN_WORD_LENGTH} characters` : ''
  return `MR privacy: checking ${list.names.length} customer name(s) from ${list.source}${skipped}.`
}

export async function run(options = {}, env = process.env) {
  const list = readCustomerNames(env)
  console.log(nameNotice(list))
  const mr = await readMergeRequest(options, env)
  for (const note of mr.notes) console.log(note)
  const entries = [
    { label: 'title', text: mr.title },
    { label: 'description', text: mr.description },
    ...collectCommitMessages(options, env),
  ]
  const failures = report(entries, list.names)
  if (failures.length > 0) {
    console.error(
      `MR privacy check failed with ${failures.length} finding(s). Remove them from the MR title or description, or reword the commits, then push again.`,
    )
    return 1
  }
  console.log(`MR privacy check passed: the title, the description and ${entries.length - 2} commit message(s) are clean.`)
  return 0
}

/** Measures the rules over saved texts: a JSON array of strings or { label, text }. */
export function scan(file, env = process.env) {
  const list = readCustomerNames(env)
  console.log(nameNotice(list))
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!Array.isArray(parsed)) throw new Error(`${file} must hold a JSON array`)
  const entries = parsed.map((item, i) =>
    typeof item === 'string'
      ? { label: `#${i + 1}`, text: item }
      : { label: String(item.label ?? `#${i + 1}`), text: String(item.text ?? '') },
  )
  const failures = report(entries, list.names)
  const byRule = {}
  for (const f of failures) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1
  const texts = new Set(failures.map((f) => f.label)).size
  const rules = Object.entries(byRule)
    .map(([rule, n]) => `${rule} ${n}`)
    .join(', ')
  console.log(`Scanned ${entries.length} text(s): ${failures.length} finding(s) in ${texts} text(s)${rules ? ` (${rules})` : ''}.`)
  return failures.length > 0 ? 1 : 0
}

function args(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (key === '--base') options.base = argv[++i]
    else if (key === '--title') options.title = argv[++i]
    else if (key === '--description') options.description = argv[++i]
    else if (key === '--scan') options.scan = argv[++i]
    else throw new Error(`Unknown argument: ${key}`)
  }
  return options
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = args(process.argv.slice(2))
    process.exitCode = options.scan ? scan(options.scan) : await run(options)
  } catch (error) {
    console.error(`MR privacy check could not run: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 2
  }
}
