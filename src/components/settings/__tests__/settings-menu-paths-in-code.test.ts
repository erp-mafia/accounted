/**
 * A settings path written in code names an entry the settings menu has.
 *
 * settings-menu-paths.test.ts ties the message catalogs' texts to the menu.
 * The same directions are also written straight into code: the structured
 * error catalog, the årsredovisning checks, KU20 and KU31, the Skatteverket
 * client, the WhatsApp bot, the assistant's instructions. They still sent
 * people to Företag (renamed on 2026-11-16), to Fakturering, Skatt and Konto,
 * which no section is called, and to Skatteverket, Bank and WhatsApp as if
 * they had rail entries of their own instead of rows on Kopplingar.
 *
 * This reads every string, template literal and JSX text under src/ outside
 * the catalogs and the tests, finds each path that starts "Inställningar"
 * (or "Settings") and a separator, and checks it against the assistant's
 * menu trail for every settings page (ui-map.ts, from settings-sections.ts and
 * the rail's labels). A path is valid when it names a page: its group and row
 * (Inställningar → Försäljning → Fakturor), the row alone (Inställningar →
 * Fakturor), a group and row with the same name once (Inställningar →
 * Bokföring), and a row on Kopplingar after Kopplingar. What follows the page
 * (a field, a tab) is not checked. A renamed or moved page fails here instead
 * of reaching a user as a dead direction.
 */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, it, expect } from 'vitest'
import { loadUiLabels, menuTrail, type UiLabels } from '@/lib/agent/ask/ui-map'
import { gateContext } from '@/lib/agent/ask/__tests__/ui-fixture'
import { LEGAL_DOCUMENTS } from '@/lib/legal/documents'
import { SETTINGS_SECTION_PARENT, visibleSettingsSections } from '@/lib/navigation/settings-sections'

const SRC = path.resolve(__dirname, '..', '..', '..')
const CATALOGS = path.join(SRC, 'messages')
const SEP = String.raw`\s*(?:→|->|›|>|,|:)\s*`
/** A path's next label starts with a capital; "Settings, then Connectors" is a sentence, not a path. */
const PATH_HEAD = String.raw`(?<![\p{L}])LABEL${SEP}(?=\p{Lu})`
/** Files worth parsing: a path may continue in the next literal of a `+` chain. */
const MENTIONS_SETTINGS = new RegExp(String.raw`(?<![\p{L}])(?:Inställningar|Settings)${SEP}`, 'u')
/** Stands where an interpolation or a non-literal operand was. */
const GAP = '\u0000'

/** Paths in other products' menus that our texts quote: not ours to check. */
const OTHER_PRODUCTS_FIRST_LABEL = new Set([
  'Connectors', // claude.ai and Claude Desktop
  'Tilläggstjänster', // Fortnox
  'Exportera data', // Bokio
  'Appar och tillägg', // Visma Spiris
  'Apps and extensions', // Visma Spiris
  'Avancerat', // WooCommerce
  'Advanced', // WooCommerce
])

/**
 * Files left out. The legal documents carry their own date, and an earlier
 * version of the terms stays as it was agreed (lib/legal/documents.ts): their
 * wording changes with a new date, not here.
 */
const SKIPPED_FILES = new Set([
  // Where suppliers' own portals keep their receipts ("Fakturor under Settings, Billing").
  'lib/receipt-hunt/portal-directory.ts',
  ...Object.values(LEGAL_DOCUMENTS).flatMap((doc) =>
    [doc.path, ...(doc.previousVersionPaths ?? [])].map((p) => `app/(public)${p}/page.tsx`),
  ),
])

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.name === 'node_modules' || entry.name === '__tests__' || full === CATALOGS) continue
    if (entry.isDirectory()) sourceFiles(full, out)
    else if (/\.tsx?$/.test(entry.name) && !/\.(test|d)\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

/** Every text a reader can be shown: string and template literals (a `+` chain as one) and JSX text. */
function texts(file: string, source: string): string[] {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, kind)
  const out: string[] = []
  const literal = (node: ts.Node): string | null => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
    if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((s) => GAP + s.literal.text).join('')
    return null
  }
  const operands = (node: ts.Expression): ts.Expression[] =>
    ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken
      ? [...operands(node.left), ...operands(node.right)]
      : [node]
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const parts = operands(node)
      if (parts.some((p) => literal(p) !== null)) {
        out.push(parts.map((p) => literal(p) ?? GAP).join(''))
        for (const p of parts) {
          if (ts.isTemplateExpression(p)) p.templateSpans.forEach((s) => visit(s.expression))
          else if (literal(p) === null) visit(p)
        }
        return
      }
    }
    const text = literal(node) ?? (ts.isJsxText(node) ? node.text : null)
    if (text !== null) out.push(text)
    if (ts.isTemplateExpression(node)) node.templateSpans.forEach((s) => visit(s.expression))
    else ts.forEachChild(node, visit)
  }
  visit(sf)
  return out.map((t) => t.replace(/\s+/g, ' '))
}

function escapeRegExp(label: string): string {
  return label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The ways a text may name each settings page after "Inställningar": with its group, or by its row alone. */
function menuSpellings(labels: UiLabels): RegExp[] {
  const settings = labels.nav('settings')
  const routes = [
    ...visibleSettingsSections({ hasCompany: true, byraScope: false, byraRole: null, hasMcpExtension: true }).map((s) => s.href),
    ...Object.keys(SETTINGS_SECTION_PARENT).map((id) => `/settings/${id}`),
  ]
  const spellings = new Set<string>()
  for (const route of routes) {
    const trail = menuTrail(route, { ctx: gateContext(), labels, hasMcpExtension: true })
    // A page the rail leaves to another area (API och MCP under Agenter) has no path under Inställningar.
    if (!trail || trail[0] !== settings) continue
    for (const form of [trail.slice(1), trail.slice(2)]) {
      const named = form.filter((label, i) => label !== form[i - 1])
      spellings.add(named.map(escapeRegExp).join(SEP))
    }
  }
  return [...spellings]
    .sort((a, b) => b.length - a.length)
    .map((s) => new RegExp(`^${s}(?![\\p{L}\\p{N}])`, 'u'))
}

describe('settings paths written in code name an entry the menu has', () => {
  it('every Inställningar and Settings path outside the message catalogs', async () => {
    const [sv, en] = await Promise.all([loadUiLabels('sv'), loadUiLabels('en')])
    const heads = [sv, en].map((labels) => ({
      head: new RegExp(PATH_HEAD.replace('LABEL', labels.nav('settings')), 'gu'),
      spellings: menuSpellings(labels),
    }))
    const dead: string[] = []
    let checked = 0
    for (const file of sourceFiles(SRC)) {
      const relative = path.relative(SRC, file).split(path.sep).join('/')
      if (SKIPPED_FILES.has(relative)) continue
      const source = fs.readFileSync(file, 'utf8')
      if (!MENTIONS_SETTINGS.test(source)) continue
      for (const text of texts(file, source)) {
        for (const { head, spellings } of heads) {
          for (const match of text.matchAll(head)) {
            const rest = text.slice(match.index + match[0].length)
            if ([...OTHER_PRODUCTS_FIRST_LABEL].some((label) => rest.startsWith(label))) continue
            checked++
            if (!spellings.some((spelling) => spelling.test(rest))) {
              dead.push(`${relative}: ${(match[0] + rest).slice(0, 70)}`)
            }
          }
        }
      }
    }

    expect(dead).toEqual([])
    // The scan reads what it is meant to: a broken walk or parse would pass with nothing checked.
    expect(checked).toBeGreaterThan(100)
  })
})
