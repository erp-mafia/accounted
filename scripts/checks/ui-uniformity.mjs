/**
 * ui-uniformity guard: the design-system rules that drifted because nothing
 * checked them (.claude/rules/design.md, "Buttons", "Motion", "Popovers and
 * menus", "Details").
 *
 * A 2026-09-24 scan of main found that the one design rule CI enforced (the
 * radius ladder) had 9 strays, while the unenforced ones had drifted into
 * five button heights, six animation speeds, four easing curves, ~22
 * hand-styled popovers, 16 hover tints and 14 arbitrary text sizes. The sweep
 * that shipped with this guard brought every rule below to zero, so any
 * finding is a hard failure.
 *
 * Class tokens are read from string literals in the TypeScript AST (JSX
 * attributes, cn() arguments, constants), never from comments.
 *
 * Rules:
 *   button-height-override  a <Button> whose className sets a height (h-*,
 *                           min-h-*, py-*). Pick a size: sm (h-8, the toolbar
 *                           height), default (h-9), lg (h-11), icon (h-10).
 *   button-spinner          a Loader2 rendered inside a <Button>. Pass
 *                           loading={...}; the button owns the spinner.
 *   off-token-duration      a duration other than 150 (state changes) or 300
 *                           (layout changes), or an arbitrary duration-[..].
 *   literal-easing          ease-[cubic-bezier(...)]. Use ease-out,
 *                           ease-emphasized or ease-drawer.
 *   transition-all          animates layout properties by accident; name the
 *                           properties (transition-colors, -opacity, ...).
 *   tailwind-shadow         shadow-sm..2xl are ~3x heavier than the design
 *                           tokens. Use POPOVER_SURFACE_CLASS or
 *                           shadow-[var(--shadow-*)] on overlays.
 *   faded-border            border-border/NN. The border token is calibrated
 *                           for full opacity.
 *   hover-tint              a hover background other than secondary/35 (table
 *                           and list rows) or secondary/60 (everything else).
 *   raw-palette             Tailwind's rainbow/gray palettes or an arbitrary
 *                           hex colour. Use the theme tokens.
 *   native-dialog           window.confirm / window.alert / alert(). Use
 *                           useDestructiveConfirm() from destructive-confirm-dialog.
 *   focus-not-visible       focus:ring-*. Rings are keyboard-only:
 *                           focus-visible:ring-*.
 *   off-scale-text          text-[Npx] outside the scale 11 / 12.5 / 13 / 15.
 *   decorative-animation    animate-bounce, animate-ping, animate-scale-in.
 */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const UI_DIRS = ['app', 'components', 'extensions']
const IGNORE_DIRS = new Set(['node_modules', '.next', '__tests__'])

// The button primitive defines its own hover states.
const HOVER_TINT_EXEMPT = new Set(['components/ui/button.tsx'])

const TEXT_SCALE = new Set(['11', '12.5', '13', '15'])
const DURATIONS = new Set(['0', '150', '300'])
const ALLOWED_HOVER_TINTS = new Set(['secondary/35', 'secondary/60'])

const PALETTE =
  'red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone'
// Matched against the utility with its variants already peeled off.
const PALETTE_RE = new RegExp(
  `^(?:bg|text|border(?:-[trblxy])?|ring|ring-offset|outline|from|via|to|fill|stroke|divide|decoration|caret|accent|placeholder|shadow)-(?:${PALETTE})-\\d{2,3}(?:/\\d+)?$`,
)
const HEX_RE = /^[a-z-]+-\[#[0-9a-fA-F]{3,8}\]/

// Leading variants (md:, hover:, data-[state=open]:, group-[.x]:) are
// peeled off before matching the utility itself.
function splitVariants(token) {
  const parts = []
  let depth = 0
  let start = 0
  for (let i = 0; i < token.length; i++) {
    const c = token[i]
    if (c === '[') depth++
    else if (c === ']') depth--
    else if (c === ':' && depth === 0) {
      parts.push(token.slice(start, i))
      start = i + 1
    }
  }
  return { variants: parts, utility: token.slice(start).replace(/^!/, '') }
}

/** Rules that judge a single class token. Returns a rule name or null. */
export function classifyToken(token, file) {
  const { variants, utility } = splitVariants(token)

  let m = utility.match(/^duration-(\d+)$/)
  if (m && !DURATIONS.has(m[1])) return 'off-token-duration'
  if (/^duration-\[/.test(utility)) return 'off-token-duration'
  if (/^ease-\[/.test(utility)) return 'literal-easing'
  if (utility === 'transition-all') return 'transition-all'
  if (/^shadow-(?:sm|md|lg|xl|2xl)$/.test(utility)) return 'tailwind-shadow'
  if (/^border(?:-[trblxy])?-border\/\d+$/.test(utility)) return 'faded-border'
  if (/^animate-(?:bounce|ping|scale-in)$/.test(utility)) return 'decorative-animation'

  m = utility.match(/^text-\[(\d+(?:\.\d+)?)px\]$/)
  if (m && !TEXT_SCALE.has(m[1])) return 'off-scale-text'

  if (PALETTE_RE.test(utility) || HEX_RE.test(utility)) return 'raw-palette'

  if (variants.includes('focus') && /^ring(?:-|$)/.test(utility) && utility !== 'ring-0') {
    return 'focus-not-visible'
  }

  m = utility.match(/^bg-((?:muted|accent|secondary)(?:\/\d+)?)$/)
  if (m && variants.includes('hover') && !HOVER_TINT_EXEMPT.has(file) && !ALLOWED_HOVER_TINTS.has(m[1])) {
    return 'hover-tint'
  }
  return null
}

// h-auto is allowed: link-style and multi-line buttons opt out of the fixed height.
const HEIGHT_TOKEN_RE = /^(?:min-h|h|py)-(?!auto$)/

function tagName(node) {
  const t = node.tagName
  return ts.isIdentifier(t) ? t.text : null
}

function stringsIn(node, out = []) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(node.text)
  else if (ts.isTemplateExpression(node)) {
    out.push(node.head.text)
    node.templateSpans.forEach((s) => out.push(s.literal.text))
  }
  // forEachChild stops at the first truthy callback result, so the callback
  // must not return the accumulator.
  ts.forEachChild(node, (c) => {
    stringsIn(c, out)
  })
  return out
}

function containsLoader(node) {
  let found = false
  const visit = (n) => {
    if (found) return
    if ((ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) && tagName(n) === 'Loader2') {
      found = true
      return
    }
    ts.forEachChild(n, visit)
  }
  ts.forEachChild(node, visit)
  return found
}

/** All findings in one source file. `file` is the path relative to the source root. */
export function findInSource(file, text) {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind)
  const findings = []
  const push = (node, rule, detail) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
    findings.push({ file, where: `${file}:${line + 1}`, rule, detail })
  }

  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      // Import specifiers and object keys are not class lists.
      if (!ts.isImportDeclaration(node.parent) && !ts.isExportDeclaration(node.parent)) {
        for (const token of node.text.split(/\s+/)) {
          if (!token) continue
          const rule = classifyToken(token, file)
          if (rule) push(node, rule, token)
        }
      }
    }

    if (ts.isJsxElement(node) && tagName(node.openingElement) === 'Button' && containsLoader(node)) {
      push(node, 'button-spinner', 'Loader2 inside <Button>')
    }

    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && tagName(node) === 'Button') {
      for (const attr of node.attributes.properties) {
        if (!ts.isJsxAttribute(attr) || attr.name.getText(sf) !== 'className' || !attr.initializer) continue
        for (const s of stringsIn(attr.initializer)) {
          for (const token of s.split(/\s+/)) {
            if (token && HEIGHT_TOKEN_RE.test(splitVariants(token).utility)) {
              push(attr, 'button-height-override', token)
            }
          }
        }
      }
    }

    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const isBareAlert = ts.isIdentifier(callee) && callee.text === 'alert'
      const isWindowDialog =
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === 'window' &&
        ['confirm', 'alert', 'prompt'].includes(callee.name.text)
      if (isBareAlert || isWindowDialog) push(node, 'native-dialog', callee.getText(sf))
    }

    ts.forEachChild(node, visit)
  }
  visit(sf)
  return findings
}

function walk(dir, out = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (IGNORE_DIRS.has(e.name) || e.name.startsWith('.')) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(full)
  }
  return out
}

/** Findings across the UI directories under `sourceRoot` (the repo's src/). */
export function findUiUniformityFindings(sourceRoot) {
  const findings = []
  for (const dir of UI_DIRS) {
    for (const full of walk(path.join(sourceRoot, dir))) {
      const file = path.relative(sourceRoot, full).split(path.sep).join('/')
      findings.push(...findInSource(file, fs.readFileSync(full, 'utf8')))
    }
  }
  return findings.sort((a, b) => a.where.localeCompare(b.where, undefined, { numeric: true }))
}

export const UI_UNIFORMITY_HINTS = {
  'button-height-override': 'pick a Button size: sm (h-8 toolbar), default (h-9), lg (h-11), icon (h-10)',
  'button-spinner': 'pass loading={busy} to <Button>; it renders and spaces the spinner itself',
  'off-token-duration': 'use duration-150 for state changes, duration-300 for layout changes',
  'literal-easing': 'use ease-out, ease-emphasized or ease-drawer',
  'transition-all': 'name the animated properties: transition-colors, transition-opacity, transition-transform, ...',
  'tailwind-shadow': 'use POPOVER_SURFACE_CLASS (components/ui/popover-surface.ts) or shadow-[var(--shadow-*)] on overlays',
  'faded-border': 'use full-opacity border-border',
  'hover-tint': 'use hover:bg-secondary/35 on table/list rows, hover:bg-secondary/60 elsewhere',
  'raw-palette': 'use theme tokens (foreground, muted-foreground, destructive, warning, success, ...)',
  'native-dialog': 'use useDestructiveConfirm() from components/ui/destructive-confirm-dialog',
  'focus-not-visible': 'use focus-visible:ring-* so rings only show for keyboard focus',
  'off-scale-text': 'use the text scale: 11 (labels, chips), 12.5 (meta, attn), 13 (body, tables), 15 (lead)',
  'decorative-animation': 'motion is functional: use animate-fade-in, stagger-enter or animate-typing-dot',
}
