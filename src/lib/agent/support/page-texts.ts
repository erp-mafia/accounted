import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '@/lib/logger'
import type { Locale } from '@/i18n/config'
import { isPageTextIndex, type MessageTree, type PageTextIndex } from './page-text-index'

const log = createLogger('agent.support.page-texts')

/**
 * What is written on each page of the app, for the support assistant.
 *
 * The menu map (lib/agent/ask/ui-map.ts) tells the assistant which pages a
 * company has. It says nothing about what is on them, so the old question box
 * was told never to name a button. This reader closes that gap from the
 * source, not from a description someone keeps up to date: the build writes
 * an index of the message keys every page and its components read
 * (scripts/generate-support-page-texts.ts), and the texts come from the same
 * message file the user's screen renders from.
 *
 * What it does not know: where on the page a text sits, in which state it is
 * shown, and texts a component gets from somewhere other than its own
 * translator. The assistant is told so (prompt.ts).
 */

// ── The index ────────────────────────────────────────────────

let cachedIndex: PageTextIndex | null | undefined

/**
 * The index the build wrote, or null when there is none (a test run, a
 * checkout that has not run the generator). The assistant then works from the
 * menu alone and says so, exactly as before the index existed.
 */
export function loadPageTextIndex(): PageTextIndex | null {
  if (cachedIndex !== undefined) return cachedIndex
  try {
    // A literal path from process.cwd(): the build's file tracer follows it,
    // and next.config.ts names the file for the route as well.
    const raw = readFileSync(join(process.cwd(), 'src', 'lib', 'agent', 'support', '_generated', 'page-texts.json'), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    cachedIndex = isPageTextIndex(parsed) ? parsed : null
    if (!cachedIndex) log.error('support page texts are not an index')
  } catch (err) {
    cachedIndex = null
    // A deployed build without the file is a build fault (prebuild did not
    // run, or the file was not traced into the function): say it loudly.
    const detail = { error: err instanceof Error ? err.message : String(err) }
    if (process.env.NODE_ENV === 'production') log.error('support page texts missing', undefined, detail)
    else log.info('support page texts missing: run npx tsx scripts/generate-support-page-texts.ts', detail)
  }
  return cachedIndex
}

/** For tests: forget the loaded index. */
export function resetPageTextIndexCache(): void {
  cachedIndex = undefined
  resolvedByLocale.clear()
}

export async function loadMessageTree(locale: Locale = 'sv'): Promise<MessageTree> {
  const mod = locale === 'en' ? await import('@/messages/en.json') : await import('@/messages/sv.json')
  return (mod.default ?? mod) as unknown as MessageTree
}

// ── Texts as a person reads them ─────────────────────────────

function matchingBrace(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** `one {# faktura} other {# fakturor}` -> `# fakturor`: the general form, as most readers meet it. */
function generalBranch(body: string): string {
  const branches: Array<{ name: string; text: string }> = []
  let i = 0
  while (i < body.length) {
    const open = body.indexOf('{', i)
    if (open === -1) break
    const close = matchingBrace(body, open)
    if (close === -1) break
    branches.push({ name: body.slice(i, open).trim(), text: body.slice(open + 1, close) })
    i = close + 1
  }
  return (branches.find((b) => b.name === 'other') ?? branches[branches.length - 1])?.text ?? ''
}

function withoutMessageSyntax(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    if (text[i] !== '{') {
      out += text[i]
      i++
      continue
    }
    const end = matchingBrace(text, i)
    if (end === -1) {
      out += text.slice(i)
      break
    }
    const inner = text.slice(i + 1, end)
    const choice = /^\s*[\w.]+\s*,\s*(?:plural|select|selectordinal)\s*,/.exec(inner)
    // A plain placeholder ({count}, {date}) stays: it shows where a value goes.
    out += choice ? withoutMessageSyntax(generalBranch(inner.slice(choice[0].length))) : text.slice(i, end + 1)
    i = end + 1
  }
  return out
}

/** A message as the screen shows it, near enough: no plural syntax, no markup tags, one line. */
export function plainText(message: string): string {
  return withoutMessageSyntax(message)
    .replace(/<\/?[a-zA-Z][\w-]*\s*\/?>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function messageAt(messages: MessageTree, key: string): string | null {
  let current: string | MessageTree | undefined = messages
  for (const segment of key.split('.')) {
    if (typeof current !== 'object' || current === null) return null
    current = current[segment]
  }
  return typeof current === 'string' ? current : null
}

// Texts per file position, resolved once per locale and index.
const resolvedByLocale = new Map<string, { index: PageTextIndex; texts: string[][] }>()

function resolvedTexts(index: PageTextIndex, messages: MessageTree, locale: Locale): string[][] {
  const cached = resolvedByLocale.get(locale)
  if (cached && cached.index === index) return cached.texts
  const texts = index.keys.map((keys) => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const key of keys) {
      const raw = messageAt(messages, key)
      if (raw === null) continue
      const text = plainText(raw)
      if (!text || seen.has(text)) continue
      seen.add(text)
      out.push(text)
    }
    return out
  })
  resolvedByLocale.set(locale, { index, texts })
  return texts
}

// ── Routes ───────────────────────────────────────────────────

function pathOnly(route: string): string {
  const path = route.split('#')[0].split('?')[0]
  return path.length > 1 ? path.replace(/\/+$/, '') : path
}

/** The index's route pattern for a path the user is on or the assistant names: `/invoices/abc` -> `/invoices/[id]`. */
export function matchRoute(index: PageTextIndex, route: string): string | null {
  const path = pathOnly(route)
  if (index.routes[path]) return path
  const segments = path.split('/').filter(Boolean)
  let best: { pattern: string; fixed: number } | null = null
  for (const pattern of Object.keys(index.routes)) {
    const parts = pattern.split('/').filter(Boolean)
    let fixed = 0
    let matches = true
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      if (/^\[\[?\.\.\./.test(part)) {
        // A catch-all takes the rest of the path; the optional form also takes none.
        matches = part.startsWith('[[') || segments.length > i
        fixed -= 1
        break
      }
      if (i >= segments.length) {
        matches = false
        break
      }
      if (part.startsWith('[') && part.endsWith(']')) continue
      if (part !== segments[i]) {
        matches = false
        break
      }
      fixed++
    }
    if (!matches) continue
    const takesRest = parts.some((part) => /^\[\[?\.\.\./.test(part))
    if (!takesRest && parts.length !== segments.length) continue
    if (!best || fixed > best.fixed) best = { pattern, fixed }
  }
  return best?.pattern ?? null
}

/** A path that stands for a route pattern when it is checked against the menu: `/invoices/[id]` -> `/invoices/id`. */
export function examplePath(pattern: string): string {
  return pattern.replace(/\[\[?\.{0,3}([^\]]+)\]\]?/g, '$1')
}

// ── One page ─────────────────────────────────────────────────

export interface PagePart {
  /** The page itself ("page"), a layout above it, or the component the texts belong to ("RotRutPayoutDialog"). */
  name: string
  texts: string[]
}

function partName(file: string): string {
  const segments = file.split('/')
  const base = segments[segments.length - 1].replace(/\.tsx?$/, '')
  if (base === 'page' || base === 'layout') return base
  return base === 'index' ? (segments[segments.length - 2] ?? base) : base
}

/** The parts of a page with their texts; a text two parts share is listed with the first. */
export function pageParts(index: PageTextIndex, pattern: string, messages: MessageTree, locale: Locale = 'sv'): PagePart[] {
  const positions = index.routes[pattern] ?? []
  const texts = resolvedTexts(index, messages, locale)
  const seen = new Set<string>()
  const used = new Map<string, number>()
  const parts: PagePart[] = []
  for (const position of positions) {
    const own = (texts[position] ?? []).filter((text) => !seen.has(text))
    if (own.length === 0) continue
    for (const text of own) seen.add(text)
    const base = partName(index.files[position])
    const count = (used.get(base) ?? 0) + 1
    used.set(base, count)
    parts.push({ name: count === 1 ? base : `${base} ${count}`, texts: own })
  }
  return parts
}

export const PAGE_TEXT_BUDGET = 9000

function includesAll(text: string, words: string[]): boolean {
  const lower = text.toLowerCase()
  return words.every((word) => lower.includes(word))
}

function queryWords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 2)
}

export interface RenderPageOptions {
  /** Only this part, by its name. */
  part?: string
  /** Only texts that contain every word. */
  search?: string
  maxChars?: number
}

/**
 * A page's texts as tool output: one line per part, the texts in the order
 * the source reads them. A page that is too long for one answer is cut at a
 * part boundary, and the parts left out are named so the assistant can ask
 * for one of them.
 */
export function renderPageTexts(parts: PagePart[], options: RenderPageOptions = {}): string {
  const maxChars = options.maxChars ?? PAGE_TEXT_BUDGET
  let selected = parts
  if (options.part) {
    const wanted = options.part.trim().toLowerCase()
    selected = parts.filter((part) => part.name.toLowerCase() === wanted)
    if (selected.length === 0) {
      return `Ingen del heter "${options.part}". Delarna på sidan: ${parts.map((p) => p.name).join(', ')}.`
    }
  }
  const words = options.search ? queryWords(options.search) : []
  if (words.length > 0) {
    selected = selected
      .map((part) => ({ ...part, texts: part.texts.filter((text) => includesAll(text, words)) }))
      .filter((part) => part.texts.length > 0)
    if (selected.length === 0) return `Ingen text på sidan innehåller "${options.search}".`
  }

  const lines: string[] = []
  const leftOut: PagePart[] = []
  let used = 0
  for (const part of selected) {
    const line = `[${part.name}] ${part.texts.join(' | ')}`
    if (used > 0 && used + line.length > maxChars) {
      leftOut.push(part)
      continue
    }
    if (line.length > maxChars) {
      // One part longer than the whole budget: as much of it as fits, whole texts only.
      const kept: string[] = []
      let size = part.name.length + 3
      for (const text of part.texts) {
        if (size + text.length + 3 > maxChars) break
        kept.push(text)
        size += text.length + 3
      }
      lines.push(`[${part.name}] ${kept.join(' | ')} | (${part.texts.length - kept.length} texter till i den här delen: sök med search)`)
      used += size
      continue
    }
    lines.push(line)
    used += line.length
  }
  if (leftOut.length > 0) {
    lines.push(
      `Fler delar på sidan som inte fick plats (läs en med part, eller sök med search): ${leftOut
        .map((part) => `${part.name} (${part.texts.length} texter)`)
        .join(', ')}.`,
    )
  }
  return lines.join('\n')
}

// ── The whole app ────────────────────────────────────────────

export interface AppTextHit {
  text: string
  /** Where the text is shown: route pattern and the part of the page. */
  places: Array<{ route: string; part: string }>
}

const MAX_PLACES_PER_HIT = 3

/**
 * Texts anywhere in the app that contain every word of the query, on the
 * pages `isVisible` lets through. A text shared by several pages is one hit
 * with its first places. Short texts first: a label or a button names the
 * thing the user is looking for more often than a sentence that mentions it.
 */
export function searchAppTexts(
  index: PageTextIndex,
  messages: MessageTree,
  query: string,
  isVisible: (pattern: string) => boolean,
  options: { locale?: Locale; limit?: number } = {},
): AppTextHit[] {
  const words = queryWords(query)
  if (words.length === 0) return []
  const texts = resolvedTexts(index, messages, options.locale ?? 'sv')
  const hits = new Map<string, AppTextHit>()
  for (const pattern of Object.keys(index.routes).sort()) {
    if (!isVisible(pattern)) continue
    for (const position of index.routes[pattern]) {
      for (const text of texts[position] ?? []) {
        if (!includesAll(text, words)) continue
        const hit = hits.get(text) ?? { text, places: [] }
        if (hit.places.length < MAX_PLACES_PER_HIT && !hit.places.some((p) => p.route === pattern)) {
          hit.places.push({ route: pattern, part: partName(index.files[position]) })
        }
        hits.set(text, hit)
      }
    }
  }
  return [...hits.values()].sort((a, b) => a.text.length - b.text.length).slice(0, options.limit ?? 25)
}
