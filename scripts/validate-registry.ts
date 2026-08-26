#!/usr/bin/env npx tsx
/**
 * CI gate for the community registry (registry/).
 *
 * The registry is the public source of truth for the entries shown on
 * gnubok.se/community/registry. Entries are contributed by PR from outside the
 * team, so this gate has two jobs:
 *
 *   1. Structure: the website build consumes these files verbatim (they are
 *      synced into the site repo), so a malformed frontmatter field would take
 *      down the registry pages for everyone, not just the broken entry.
 *   2. Safety: the site renders entry bodies through MDX. MDX evaluates JSX
 *      and import/export statements at build time, which would let a PR run
 *      arbitrary code inside the website build. Bodies must therefore be plain
 *      Markdown: no imports, no exports, no JSX elements, no script tags.
 *      Fenced code blocks are exempt (they are displayed, never evaluated).
 *
 * Usage:
 *   npx tsx scripts/validate-registry.ts          # validate (CI)
 *   npx tsx scripts/validate-registry.ts --json   # machine-readable summary
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ENTRIES_DIR = path.join(ROOT, 'registry', 'entries')
const AUTHORS_DIR = path.join(ROOT, 'registry', 'authors')

const KINDS = ['skill', 'mcp', 'workflow', 'app'] as const
const STATUSES = ['live', 'beta', 'archived'] as const
const LANGS = ['sv', 'en'] as const
const PERSONAS = ['founder', 'finance', 'byra', 'developer'] as const
const AUTHOR_KINDS = ['team', 'byra', 'founder', 'partner', 'community'] as const

const ENTRY_REQUIRED = [
  'title',
  'description',
  'slug',
  'kind',
  'author',
  'status',
  'lang',
  'personas',
  'publishedAt',
  'updatedAt',
] as const

/** An entry must give the reader at least one way to actually get the thing. */
const INSTALL_FIELDS = ['installCommand', 'downloadUrl', 'repoUrl', 'externalUrl'] as const

const URL_FIELDS = ['downloadUrl', 'repoUrl', 'externalUrl', 'url', 'logoUrl'] as const

interface Failure {
  file: string
  message: string
}

const failures: Failure[] = []

function listFiles(dir: string, exts: string[]): string[] {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => exts.some((e) => f.endsWith(e)))
    .filter((f) => !f.startsWith('_'))
    .sort()
}

function parseFrontmatter(
  file: string,
  raw: string,
): { data: Record<string, unknown>; body: string } | null {
  if (!raw.startsWith('---\n')) {
    failures.push({ file, message: 'file must start with a --- frontmatter block' })
    return null
  }
  const end = raw.indexOf('\n---\n', 4)
  if (end === -1) {
    failures.push({ file, message: 'frontmatter block is never closed with ---' })
    return null
  }
  let data: unknown
  try {
    data = yaml.load(raw.slice(4, end))
  } catch (e) {
    failures.push({ file, message: `frontmatter is not valid YAML: ${(e as Error).message}` })
    return null
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    failures.push({ file, message: 'frontmatter must be a YAML mapping' })
    return null
  }
  return { data: data as Record<string, unknown>, body: raw.slice(end + 5) }
}

function isIsoDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const d = new Date(`${v}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}

/**
 * The MDX safety check. Lines inside fenced code blocks are display-only and
 * skipped; everything else must be plain Markdown.
 */
function checkBodySafety(file: string, body: string): void {
  let inFence = false
  const lines = body.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const stripped = line.replace(/`[^`]*`/g, '')
    if (/^\s*import\s/.test(stripped) || /^\s*export\s/.test(stripped)) {
      failures.push({
        file,
        message: `line ${i + 1}: import/export statements are not allowed (MDX would execute them in the site build)`,
      })
    }
    // MDX treats ANY tag as JSX, lowercase HTML included (<div>, <img
    // onerror=...>), and a bare {...} as a JS expression to evaluate. Both
    // must be banned entirely, not just capitalized component tags.
    if (/<\/?[A-Za-z]/.test(stripped)) {
      failures.push({
        file,
        message: `line ${i + 1}: raw HTML/JSX tags are not allowed; entry bodies are plain Markdown (put literal tags in backticks)`,
      })
    }
    if (/[{}]/.test(stripped)) {
      failures.push({
        file,
        message: `line ${i + 1}: { } are not allowed outside code (MDX evaluates {...} as a JS expression)`,
      })
    }
    if (/javascript:/i.test(stripped)) {
      failures.push({ file, message: `line ${i + 1}: javascript: URLs are not allowed` })
    }
  }
  if (inFence) {
    failures.push({ file, message: 'unclosed fenced code block' })
  }
}

function checkUrls(file: string, data: Record<string, unknown>): void {
  for (const field of URL_FIELDS) {
    const v = data[field]
    if (v === undefined) continue
    if (typeof v !== 'string' || !v.startsWith('https://')) {
      failures.push({ file, message: `${field} must be an https:// URL, got: ${String(v)}` })
    }
  }
}

function validateAuthors(): Set<string> {
  const handles = new Set<string>()
  for (const filename of listFiles(AUTHORS_DIR, ['.md', '.mdx'])) {
    const file = `registry/authors/${filename}`
    const parsed = parseFrontmatter(file, fs.readFileSync(path.join(AUTHORS_DIR, filename), 'utf8'))
    if (!parsed) continue
    const { data, body } = parsed
    const expectedHandle = filename.replace(/\.mdx?$/, '')
    if (data.handle !== expectedHandle) {
      failures.push({
        file,
        message: `handle "${String(data.handle)}" must equal the filename "${expectedHandle}"`,
      })
    }
    if (typeof data.name !== 'string' || data.name.length === 0) {
      failures.push({ file, message: 'name is required' })
    }
    if (!AUTHOR_KINDS.includes(data.kind as (typeof AUTHOR_KINDS)[number])) {
      failures.push({
        file,
        message: `kind must be one of ${AUTHOR_KINDS.join(', ')}, got: ${String(data.kind)}`,
      })
    }
    if (typeof data.handle === 'string') {
      if (handles.has(data.handle)) {
        failures.push({ file, message: `duplicate author handle "${data.handle}"` })
      }
      handles.add(data.handle)
    }
    checkUrls(file, data)
    checkBodySafety(file, body)
  }
  return handles
}

function validateEntries(authorHandles: Set<string>): number {
  const slugs = new Set<string>()
  const files = listFiles(ENTRIES_DIR, ['.md', '.mdx'])
  for (const filename of files) {
    const file = `registry/entries/${filename}`
    const parsed = parseFrontmatter(file, fs.readFileSync(path.join(ENTRIES_DIR, filename), 'utf8'))
    if (!parsed) continue
    const { data, body } = parsed

    for (const field of ENTRY_REQUIRED) {
      if (data[field] === undefined || data[field] === null || data[field] === '') {
        failures.push({ file, message: `required field "${field}" is missing` })
      }
    }

    const expectedSlug = filename.replace(/\.mdx?$/, '')
    if (data.slug !== undefined && data.slug !== expectedSlug) {
      failures.push({
        file,
        message: `slug "${String(data.slug)}" must equal the filename "${expectedSlug}"`,
      })
    }
    if (typeof data.slug === 'string') {
      if (slugs.has(data.slug)) {
        failures.push({ file, message: `duplicate slug "${data.slug}"` })
      }
      slugs.add(data.slug)
    }

    if (data.kind !== undefined && !KINDS.includes(data.kind as (typeof KINDS)[number])) {
      failures.push({ file, message: `kind must be one of ${KINDS.join(', ')}, got: ${String(data.kind)}` })
    }
    if (data.status !== undefined && !STATUSES.includes(data.status as (typeof STATUSES)[number])) {
      failures.push({
        file,
        message: `status must be one of ${STATUSES.join(', ')}, got: ${String(data.status)}`,
      })
    }
    if (data.lang !== undefined && !LANGS.includes(data.lang as (typeof LANGS)[number])) {
      failures.push({ file, message: `lang must be sv or en, got: ${String(data.lang)}` })
    }
    if (data.personas !== undefined) {
      if (!Array.isArray(data.personas) || data.personas.length === 0) {
        failures.push({ file, message: 'personas must be a non-empty list' })
      } else {
        for (const p of data.personas) {
          if (!PERSONAS.includes(p as (typeof PERSONAS)[number])) {
            failures.push({
              file,
              message: `unknown persona "${String(p)}"; allowed: ${PERSONAS.join(', ')}`,
            })
          }
        }
      }
    }

    for (const field of ['publishedAt', 'updatedAt'] as const) {
      if (data[field] !== undefined && !isIsoDate(data[field])) {
        failures.push({ file, message: `${field} must be a YYYY-MM-DD date, got: ${String(data[field])}` })
      }
    }
    if (isIsoDate(data.publishedAt) && isIsoDate(data.updatedAt) && data.updatedAt < data.publishedAt) {
      failures.push({ file, message: `updatedAt ${data.updatedAt} is before publishedAt ${data.publishedAt}` })
    }

    if (typeof data.description === 'string' && data.description.length > 500) {
      failures.push({
        file,
        message: `description is ${data.description.length} chars; keep it under 500 (it is a card subtitle, the body is for detail)`,
      })
    }

    if (!INSTALL_FIELDS.some((f) => typeof data[f] === 'string' && (data[f] as string).length > 0)) {
      failures.push({
        file,
        message: `at least one of ${INSTALL_FIELDS.join(', ')} is required so readers can actually get the thing`,
      })
    }

    if (typeof data.author === 'string' && !authorHandles.has(data.author)) {
      failures.push({
        file,
        message: `author "${data.author}" has no profile in registry/authors/; add ${data.author}.mdx in the same PR`,
      })
    }

    checkUrls(file, data)
    checkBodySafety(file, body)

    if (body.trim().length === 0) {
      failures.push({ file, message: 'entry body is empty; describe what it does and how to use it' })
    }
  }
  return files.length
}

const authorHandles = validateAuthors()
const entryCount = validateEntries(authorHandles)

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ entries: entryCount, authors: authorHandles.size, failures }, null, 2))
} else {
  for (const f of failures) {
    console.error(`FAIL ${f.file}: ${f.message}`)
  }
  console.log(`${entryCount} entries, ${authorHandles.size} authors, ${failures.length} failures`)
}
process.exit(failures.length > 0 ? 1 : 0)
