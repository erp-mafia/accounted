/**
 * Support page texts generator
 *
 * The support assistant (src/lib/agent/support) answers "where do I do
 * this?". The menu map tells it which pages exist; this index tells it what
 * is written on each of them: the labels, buttons and help texts the page and
 * the components it renders take from the message files.
 *
 * Nothing here is written for the assistant. The index is derived from the
 * source: every page.tsx under src/app/(dashboard), the files it imports, and
 * the message keys those files read through useTranslations/getTranslations.
 * A renamed button or a new dialog reaches the assistant with the next build,
 * because the build runs this script (package.json prebuild).
 *
 * Writes src/lib/agent/support/_generated/page-texts.json:
 *   files   source files that read messages, relative to src/
 *   keys    per file (same position): the message keys it reads, in source order
 *   roles   per file (same position): what each key is on the page (a button,
 *           a tab, a heading ...), one character per key, where the source shows it
 *   routes  route pattern -> positions in `files`, the page first, then what it
 *           imports, breadth first
 * Only keys are stored, never the texts: the reader (page-texts.ts) resolves
 * them against the message file of the user's locale.
 *
 * Usage:
 *   npx tsx scripts/generate-support-page-texts.ts          # write the index
 *   npx tsx scripts/generate-support-page-texts.ts --stats  # write it and print its size
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import ts from 'typescript'
import {
  NO_PAGE_TEXT_ROLE,
  type MessageTree,
  type PageTextIndex,
  type PageTextRole,
} from '../src/lib/agent/support/page-text-index'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, '..')
const SRC = path.join(ROOT, 'src')
const OUTPUT = path.join(SRC, 'lib', 'agent', 'support', '_generated', 'page-texts.json')

// ── Types ────────────────────────────────────────────────────

/** One message read in a source file: an exact key, or every key that starts with a prefix. */
export interface KeyRef {
  /** Dotted path into the message file: namespace plus key. */
  path: string
  /** True for t(`status_${x}`): every key under the same parent that starts with the path's last segment. */
  prefix: boolean
  /** What the text is on the page, where the source shows it (roleOfCall, roleOfName). */
  role?: PageTextRole
}

/** A read through a key property the file writes no value for: `t(item.labelKey)` with the items imported. */
export interface PropertyRead {
  /** The property the key is read from, e.g. `labelKey`. */
  property: string
  /** The namespace of the translator that reads it ('' for none). */
  namespace: string
  role?: PageTextRole
}

export interface FileAnalysis {
  imports: string[]
  refs: KeyRef[]
  /** Key properties to look for in the modules the file imports (buildPageTextIndex). */
  propertyReads: PropertyRead[]
}

// ── Reading one file ─────────────────────────────────────────

const TRANSLATOR_FACTORIES = new Set(['useTranslations', 'getTranslations'])
const TRANSLATOR_METHODS = new Set(['rich', 'markup', 'raw', 'has'])

function unwrap(node: ts.Expression): ts.Expression {
  let current = node
  while (
    ts.isAwaitExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression
  }
  return current
}

// ── What a text is on the page ───────────────────────────────

/** The element a text is rendered in, or given to as a prop, and what that makes it. */
const TAG_ROLES: Record<string, PageTextRole> = {
  Button: 'b',
  button: 'b',
  SplitButton: 'b',
  TabsTrigger: 't',
  SegmentedControl: 't',
  h1: 'h',
  h2: 'h',
  h3: 'h',
  h4: 'h',
  DialogTitle: 'h',
  SheetTitle: 'h',
  CardTitle: 'h',
  PageHeader: 'h',
  SettingsSectionHeader: 'h',
  Label: 'f',
  label: 'f',
  FormLabel: 'f',
  SettingsRow: 'f',
  th: 'c',
  TableHead: 'c',
  DropdownMenuItem: 'm',
  ContextMenuItem: 'm',
  CommandItem: 'm',
  option: 'o',
  SelectItem: 'o',
  Link: 'l',
  a: 'l',
  DialogDescription: 'd',
  HelpPopover: 'd',
  SettingsRowNote: 'd',
}

/** Attributes that carry an explanation of the element, whatever the element is. */
const HELP_ATTRIBUTES = new Set(['description', 'help', 'helpText', 'hint', 'tooltip'])

/** How many elements up from a text its role is looked for: a button's text often sits in a span inside it. */
const ROLE_LOOKUP_DEPTH = 3

function tagName(node: ts.JsxElement | ts.JsxSelfClosingElement): string {
  const tag = ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName
  return ts.isPropertyAccessExpression(tag) ? tag.name.text : tag.getText()
}

/**
 * What a translator call's text is, from where the call sits: a placeholder
 * attribute, or the nearest element (up to three levels) that has a role of
 * its own. Undefined when the source does not show it, which is common and
 * fine: the assistant is told that a text without a role has none it may name.
 */
function roleOfCall(call: ts.Node): PageTextRole | undefined {
  let elements = 0
  // The attribute the text is given to, when it is not rendered as a child.
  let attribute: string | undefined
  for (let node = call.parent; node && !ts.isSourceFile(node); node = node.parent) {
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText()
      if (name === 'placeholder') return 'p'
      if (HELP_ATTRIBUTES.has(name)) return 'd'
      attribute ??= name
    }
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const role = TAG_ROLES[tagName(node)]
      if (role) {
        // A title on anything but a heading is its tooltip, and the name of a
        // group of tabs is not a tab.
        if (attribute === 'title' && role !== 'h') return 'd'
        if (attribute === 'aria-label' && role === 't') return undefined
        return role
      }
      elements++
      attribute = undefined
      if (elements >= ROLE_LOOKUP_DEPTH) return undefined
    }
    if (ts.isFunctionDeclaration(node)) return undefined
  }
  return undefined
}

/** What the name of a lookup table or of a key property says its texts are: TAB_LABEL_KEYS, columnKey. */
function roleOfName(name: string): PageTextRole | undefined {
  if (/tab/i.test(name)) return 't'
  if (/column|header/i.test(name)) return 'c'
  if (/status|state|chip|badge/i.test(name)) return 's'
  if (/placeholder/i.test(name)) return 'p'
  if (/title|heading/i.test(name)) return 'h'
  return undefined
}

const KEY_LIKE = /^[A-Za-z][\w.]*$/

/** Every text value inside an object or array literal, nested ones included, in source order; never a property name. */
function literalValues(node: ts.Expression, found: string[] = []): string[] {
  const value = unwrap(node)
  if (ts.isStringLiteralLike(value)) {
    if (KEY_LIKE.test(value.text)) found.push(value.text)
  } else if (ts.isArrayLiteralExpression(value)) {
    for (const element of value.elements) literalValues(element, found)
  } else if (ts.isObjectLiteralExpression(value)) {
    for (const property of value.properties) {
      if (ts.isPropertyAssignment(property)) literalValues(property.initializer, found)
    }
  }
  return found
}

/** The variable a key expression starts from: TAB_LABEL_KEYS in `TAB_LABEL_KEYS[tab]`, col in `col.labelKey`. */
function rootIdentifier(node: ts.Expression): string | undefined {
  let current = unwrap(node)
  while (ts.isElementAccessExpression(current) || ts.isPropertyAccessExpression(current)) {
    current = unwrap(current.expression)
  }
  return ts.isIdentifier(current) ? current.text : undefined
}

/**
 * The namespace a translator is created with: `useTranslations('invoices')`,
 * `await getTranslations('invoices')`, `getTranslations({ namespace: 'x' })`.
 * '' for no namespace, null for one that is not a literal, undefined when the
 * expression creates no translator.
 */
function translatorNamespace(init: ts.Expression): string | null | undefined {
  const call = unwrap(init)
  if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) return undefined
  if (!TRANSLATOR_FACTORIES.has(call.expression.text)) return undefined
  const arg = call.arguments[0]
  if (!arg) return ''
  if (ts.isStringLiteralLike(arg)) return arg.text
  if (ts.isObjectLiteralExpression(arg)) {
    for (const prop of arg.properties) {
      if (!ts.isPropertyAssignment(prop)) continue
      const name = ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name) ? prop.name.text : null
      if (name !== 'namespace') continue
      return ts.isStringLiteralLike(prop.initializer) ? prop.initializer.text : null
    }
    return ''
  }
  return null
}

/** The keys a translator call names: one literal, both arms of a conditional, or a template's fixed start. */
function keysOfArgument(arg: ts.Expression | undefined): Array<{ key: string; prefix: boolean }> {
  if (!arg) return []
  const node = unwrap(arg)
  if (ts.isStringLiteralLike(node)) return [{ key: node.text, prefix: false }]
  if (ts.isTemplateExpression(node)) return node.head.text ? [{ key: node.head.text, prefix: true }] : []
  if (ts.isConditionalExpression(node)) return [...keysOfArgument(node.whenTrue), ...keysOfArgument(node.whenFalse)]
  return []
}

function isFunctionScope(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  )
}

/**
 * What one source file imports and which messages it reads.
 *
 * A translator is followed by its variable name inside the function that
 * declares it (and the functions nested in it), so two components in one file
 * that both call theirs `t` keep their own namespaces. A translator handed to
 * another file as an argument is not followed there: that file's reads are
 * missed, which costs the index a few labels and never adds a wrong one.
 *
 * A key that is not written at the call is followed one step, inside the
 * file: `t(TAB_LABEL_KEYS[tab])` reads every text value of the table
 * TAB_LABEL_KEYS, and `t(column.labelKey)` every `labelKey: '...'` the file
 * writes. Tabs, columns and statuses are commonly labelled this way, and
 * without the step the index held a page's group headings and not its tabs.
 * A key property the file writes no value for (`t(item.labelKey)` with the
 * items built in a module it imports, as the report list is) is reported in
 * `propertyReads`: buildPageTextIndex looks for it one step further, in the
 * modules the file imports. A table variable imported from another file is
 * not followed.
 */
function parse(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
}

/** A file's lookup tables (variable -> the texts of its literal) and key properties (property -> the keys written for it). */
function tablesAndKeyProperties(source: ts.SourceFile): { tables: Map<string, string[]>; keyProperties: Map<string, string[]> } {
  const tables = new Map<string, string[]>()
  const keyProperties = new Map<string, string[]>()
  const collect = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const value = unwrap(node.initializer)
      if (ts.isObjectLiteralExpression(value) || ts.isArrayLiteralExpression(value)) {
        tables.set(node.name.text, literalValues(value))
      }
    }
    if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name))) {
      const value = unwrap(node.initializer)
      if (ts.isStringLiteralLike(value) && KEY_LIKE.test(value.text)) {
        const values = keyProperties.get(node.name.text) ?? []
        values.push(value.text)
        keyProperties.set(node.name.text, values)
      }
    }
    ts.forEachChild(node, collect)
  }
  collect(source)
  return { tables, keyProperties }
}

/** The key properties one module writes: what a file that imports it may read through `t(item.labelKey)`. */
export function keyPropertiesOfSource(fileName: string, text: string): Map<string, string[]> {
  return tablesAndKeyProperties(parse(fileName, text)).keyProperties
}

export function analyseSource(fileName: string, text: string): FileAnalysis {
  const source = parse(fileName, text)
  const imports: string[] = []
  const refs: KeyRef[] = []
  const propertyReads: PropertyRead[] = []
  const scopes: Array<Map<string, string>> = [new Map()]

  // The file's lookup tables and key properties, read before the calls are:
  // a table is usually declared above the component that reads it, but need
  // not be.
  const { tables, keyProperties } = tablesAndKeyProperties(source)

  /** The keys a call reads through a table or a key property of this file. */
  const lookedUpKeys = (
    arg: ts.Expression | undefined,
  ): { keys: string[]; role?: PageTextRole; property?: string } => {
    if (!arg) return { keys: [] }
    const expression = unwrap(arg)
    if (ts.isStringLiteralLike(expression) || ts.isTemplateExpression(expression)) return { keys: [] }
    const root = rootIdentifier(expression)
    const table = root ? tables.get(root) : undefined
    if (root && table && !ts.isIdentifier(expression)) return { keys: table, role: roleOfName(root) }
    if (ts.isPropertyAccessExpression(expression)) {
      const property = expression.name.text
      return { keys: keyProperties.get(property) ?? [], role: roleOfName(property), property }
    }
    return { keys: [] }
  }

  const bind = (name: ts.BindingName, init: ts.Expression) => {
    if (ts.isIdentifier(name)) {
      const ns = translatorNamespace(init)
      if (typeof ns === 'string') scopes[scopes.length - 1].set(name.text, ns)
      return
    }
    // const [t, tCommon] = await Promise.all([getTranslations('a'), getTranslations('b')])
    if (!ts.isArrayBindingPattern(name)) return
    const call = unwrap(init)
    if (!ts.isCallExpression(call)) return
    const list = call.arguments[0]
    if (!list || !ts.isArrayLiteralExpression(list)) return
    name.elements.forEach((element, index) => {
      if (!ts.isBindingElement(element) || !ts.isIdentifier(element.name)) return
      const item = list.elements[index]
      if (!item) return
      const ns = translatorNamespace(item)
      if (typeof ns === 'string') scopes[scopes.length - 1].set(element.name.text, ns)
    })
  }

  const namespaceOf = (name: string): string | undefined => {
    for (let i = scopes.length - 1; i >= 0; i--) {
      const ns = scopes[i].get(name)
      if (ns !== undefined) return ns
    }
    return undefined
  }

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      if (!node.importClause?.isTypeOnly && ts.isStringLiteralLike(node.moduleSpecifier)) {
        imports.push(node.moduleSpecifier.text)
      }
      return
    }
    if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        imports.push(node.moduleSpecifier.text)
      }
      return
    }
    if (ts.isVariableDeclaration(node) && node.initializer) bind(node.name, node.initializer)
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      if (callee.kind === ts.SyntaxKind.ImportKeyword) {
        const spec = node.arguments[0]
        if (spec && ts.isStringLiteralLike(spec)) imports.push(spec.text)
      } else {
        const translator = ts.isIdentifier(callee)
          ? callee.text
          : ts.isPropertyAccessExpression(callee) &&
              ts.isIdentifier(callee.expression) &&
              TRANSLATOR_METHODS.has(callee.name.text)
            ? callee.expression.text
            : null
        const ns = translator ? namespaceOf(translator) : undefined
        if (ns !== undefined) {
          const role = roleOfCall(node)
          const written = keysOfArgument(node.arguments[0])
          for (const { key, prefix } of written) {
            refs.push({ path: ns ? `${ns}.${key}` : key, prefix, ...(role ? { role } : {}) })
          }
          if (written.length === 0) {
            const looked = lookedUpKeys(node.arguments[0])
            const tableRole = looked.role ?? role
            for (const key of looked.keys) {
              refs.push({ path: ns ? `${ns}.${key}` : key, prefix: false, ...(tableRole ? { role: tableRole } : {}) })
            }
            // Nothing written for the property here: the items come from a module this file imports.
            if (looked.property && looked.keys.length === 0) {
              propertyReads.push({ property: looked.property, namespace: ns, ...(tableRole ? { role: tableRole } : {}) })
            }
          }
        }
      }
    }
    if (isFunctionScope(node)) {
      scopes.push(new Map())
      ts.forEachChild(node, visit)
      scopes.pop()
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { imports, refs, propertyReads }
}

// ── Messages ─────────────────────────────────────────────────

function nodeAt(messages: MessageTree, segments: string[]): string | MessageTree | undefined {
  let current: string | MessageTree | undefined = messages
  for (const segment of segments) {
    if (typeof current !== 'object' || current === null) return undefined
    current = current[segment]
  }
  return current
}

/** The message keys a read stands for: itself when it is a text, or every text under its parent that starts like it. */
export function expandKeyRef(ref: KeyRef, messages: MessageTree): string[] {
  const segments = ref.path.split('.')
  if (!ref.prefix) return typeof nodeAt(messages, segments) === 'string' ? [ref.path] : []
  const start = segments[segments.length - 1]
  const parentSegments = segments.slice(0, -1)
  const parent = nodeAt(messages, parentSegments)
  if (typeof parent !== 'object' || parent === null) return []
  return Object.keys(parent)
    .filter((key) => key.startsWith(start) && typeof parent[key] === 'string')
    .map((key) => [...parentSegments, key].join('.'))
}

// ── Following imports ────────────────────────────────────────

/**
 * Files whose texts would be noise on every page: the generic controls (their
 * "Stäng" and "Avbryt"), the icons, the built-in chat and the support dialog
 * itself.
 */
const NOT_FOLLOWED = ['components/ui/', 'components/icons', 'components/agent/', 'components/support/']

export function isFollowed(relative: string): boolean {
  if (relative.includes('__tests__/') || /\.test\.tsx?$/.test(relative)) return false
  return !NOT_FOLLOWED.some((prefix) => relative.startsWith(prefix))
}

/** A plain module (no JSX) outside the pages and components: read only when it creates a translator. */
function isLeafUnlessTranslating(relative: string): boolean {
  return relative.endsWith('.ts') && !relative.startsWith('app/') && !relative.startsWith('components/')
}

export interface SourceReader {
  /** The text of a file relative to src/, or null when there is none. */
  read: (relative: string) => string | null
}

const CANDIDATE_SUFFIXES = ['', '.ts', '.tsx', '/index.ts', '/index.tsx']

/** The file under src/ an import names, or null for a package, a style sheet, a JSON file or a path outside src/. */
export function resolveImport(from: string, specifier: string, reader: SourceReader): string | null {
  let base: string
  if (specifier.startsWith('@/')) {
    if (specifier.startsWith('@/tests/') || specifier.startsWith('@/scripts/')) return null
    base = specifier.slice(2)
  } else if (specifier.startsWith('.')) {
    base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier))
    if (base.startsWith('..')) return null
  } else {
    return null
  }
  if (/\.(json|css|svg|png|md)$/.test(base)) return null
  for (const suffix of CANDIDATE_SUFFIXES) {
    const candidate = base + suffix
    if (!/\.tsx?$/.test(candidate)) continue
    if (reader.read(candidate) !== null) return candidate
  }
  return null
}

/** `app/(dashboard)/invoices/[id]/page.tsx` -> `/invoices/[id]`; null for a parallel or intercepted route. */
export function routeOfPage(relative: string): string | null {
  const segments = relative.split('/').slice(1, -1)
  if (segments.some((s) => s.startsWith('@') || /^\(\.+\)/.test(s))) return null
  const visible = segments.filter((s) => !(s.startsWith('(') && s.endsWith(')')))
  return `/${visible.join('/')}`
}

/** The layouts between the dashboard's own and the page: they carry the tabs and headings the page sits under. */
function nestedLayouts(page: string, reader: SourceReader): string[] {
  const segments = page.split('/').slice(0, -1)
  const layouts: string[] = []
  // segments[0] is 'app', segments[1] the route group; its layout is the shell, not the page.
  for (let depth = 3; depth <= segments.length; depth++) {
    const candidate = `${segments.slice(0, depth).join('/')}/layout.tsx`
    if (reader.read(candidate) !== null) layouts.push(candidate)
  }
  return layouts
}

export function buildPageTextIndex(pages: string[], reader: SourceReader, messages: MessageTree): PageTextIndex {
  const analyses = new Map<string, FileAnalysis | null>()
  const keysOfFile = new Map<string, string[]>()
  const rolesOfFile = new Map<string, string>()

  // `t(item.labelKey)` with the items built elsewhere: the keys are the ones
  // the modules this file imports write for that property. One step, and only
  // keys that exist under the translator's namespace survive (expandKeyRef),
  // so another table's `labelKey` in the same module adds nothing.
  const keyPropertiesByFile = new Map<string, Map<string, string[]>>()
  const keyPropertiesOf = (relative: string): Map<string, string[]> => {
    const cached = keyPropertiesByFile.get(relative)
    if (cached) return cached
    const text = reader.read(relative)
    const found = text === null ? new Map<string, string[]>() : keyPropertiesOfSource(relative, text)
    keyPropertiesByFile.set(relative, found)
    return found
  }
  const importedPropertyRefs = (relative: string, analysis: FileAnalysis): KeyRef[] => {
    if (analysis.propertyReads.length === 0) return []
    const targets = new Set<string>()
    for (const specifier of analysis.imports) {
      const target = resolveImport(relative, specifier, reader)
      if (target && target !== relative && isFollowed(target)) targets.add(target)
    }
    const found: KeyRef[] = []
    for (const read of analysis.propertyReads) {
      for (const target of targets) {
        for (const key of keyPropertiesOf(target).get(read.property) ?? []) {
          found.push({
            path: read.namespace ? `${read.namespace}.${key}` : key,
            prefix: false,
            ...(read.role ? { role: read.role } : {}),
          })
        }
      }
    }
    return found
  }

  const analyse = (relative: string): FileAnalysis | null => {
    const cached = analyses.get(relative)
    if (cached !== undefined) return cached
    const text = reader.read(relative)
    let result: FileAnalysis | null = null
    if (text !== null && !(isLeafUnlessTranslating(relative) && !text.includes('Translations('))) {
      result = analyseSource(relative, text)
    }
    analyses.set(relative, result)
    if (result) {
      // A key the file reads twice is listed once, with the first role the
      // source shows for it.
      const roleOfKey = new Map<string, PageTextRole | undefined>()
      for (const ref of [...result.refs, ...importedPropertyRefs(relative, result)]) {
        for (const key of expandKeyRef(ref, messages)) {
          if (!roleOfKey.has(key) || (roleOfKey.get(key) === undefined && ref.role)) roleOfKey.set(key, ref.role)
        }
      }
      const keys = [...roleOfKey.keys()]
      keysOfFile.set(relative, keys)
      rolesOfFile.set(relative, keys.map((key) => roleOfKey.get(key) ?? NO_PAGE_TEXT_ROLE).join(''))
    }
    return result
  }

  const files: string[] = []
  const keys: string[][] = []
  const roles: string[] = []
  const position = new Map<string, number>()
  const positionOf = (relative: string): number => {
    const known = position.get(relative)
    if (known !== undefined) return known
    const index = files.length
    files.push(relative)
    keys.push(keysOfFile.get(relative) ?? [])
    roles.push(rolesOfFile.get(relative) ?? '')
    position.set(relative, index)
    return index
  }

  const routes: Record<string, number[]> = {}
  for (const page of [...pages].sort()) {
    const route = routeOfPage(page)
    if (route === null) continue
    const queue = [page, ...nestedLayouts(page, reader)]
    const visited = new Set(queue)
    const withTexts: number[] = []
    for (let i = 0; i < queue.length; i++) {
      const current = queue[i]
      const analysis = analyse(current)
      if (!analysis) continue
      if ((keysOfFile.get(current) ?? []).length > 0) withTexts.push(positionOf(current))
      for (const specifier of analysis.imports) {
        const target = resolveImport(current, specifier, reader)
        if (!target || visited.has(target) || !isFollowed(target)) continue
        visited.add(target)
        queue.push(target)
      }
    }
    if (withTexts.length > 0) routes[route] = withTexts
  }
  return { files, keys, roles, routes }
}

// ── CLI ──────────────────────────────────────────────────────

function listPages(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) listPages(full, found)
    else if (entry.name === 'page.tsx') found.push(path.relative(SRC, full).split(path.sep).join('/'))
  }
  return found
}

function diskReader(): SourceReader {
  const cache = new Map<string, string | null>()
  return {
    read(relative) {
      const cached = cache.get(relative)
      if (cached !== undefined) return cached
      let text: string | null = null
      try {
        const full = path.join(SRC, relative)
        if (fs.statSync(full).isFile()) text = fs.readFileSync(full, 'utf8')
      } catch {
        text = null
      }
      cache.set(relative, text)
      return text
    },
  }
}

function main() {
  const started = Date.now()
  const messages = JSON.parse(fs.readFileSync(path.join(SRC, 'messages', 'sv.json'), 'utf8')) as MessageTree
  const pages = listPages(path.join(SRC, 'app', '(dashboard)'))
  const index = buildPageTextIndex(pages, diskReader(), messages)
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true })
  const json = `${JSON.stringify(index)}\n`
  fs.writeFileSync(OUTPUT, json)

  const routeCount = Object.keys(index.routes).length
  console.log(
    `Support page texts: ${routeCount} pages, ${index.files.length} files, ${Math.round(json.length / 1024)} kB (${Date.now() - started} ms)`,
  )
  if (process.argv.includes('--stats')) {
    const sizes = Object.entries(index.routes)
      .map(([route, positions]) => ({
        route,
        files: positions.length,
        keys: new Set(positions.flatMap((p) => index.keys[p])).size,
      }))
      .sort((a, b) => b.keys - a.keys)
    for (const row of sizes.slice(0, 15)) console.log(`  ${row.keys} keys, ${row.files} files  ${row.route}`)
    console.log(`  pages without any text: ${pages.length - routeCount}`)
  }
}

// Only run when invoked directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
}
