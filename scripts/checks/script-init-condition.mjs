/**
 * Guard: a script that loads lib/init is invoked under the react-server
 * condition everywhere the repository says how to run it, and registers its
 * loader through scripts/lib/register-init-loader.ts.
 *
 * lib/init reaches modules that import `server-only`, whose default entry
 * throws; only the react-server condition (which Next.js applies to the server)
 * resolves it to an empty module. A script run under plain tsx therefore could
 * not load lib/init, and since the event bus logs a failed load and retries it
 * on the next event (the right contract for the server), every such script
 * posted with each event reaching no handler: no event_log row, no webhook, no
 * extension. That was true of all nine scripts that registered the loader
 * until 2026-10-16, both before and after lib/init moved behind
 * instrumentation.ts. registerScriptInitLoader() now stops a script that runs
 * without the condition; this guard keeps every invocation the repository
 * writes down from being one that stops.
 *
 * An init script is a file under scripts/ that calls registerScriptInitLoader()
 * (tests and the helper itself excluded). The rules:
 *   - missing-condition: a line that names an init script by its repository
 *     path and runs it with tsx (`npx tsx`, `node --import tsx`, a spawn or
 *     fork with 'tsx' in its arguments) also names the react-server condition
 *     (`--conditions react-server`, `--conditions=react-server`,
 *     `-C react-server`, or `'--conditions', 'react-server'` in an argument
 *     list). Lines continued with a trailing backslash count as one line.
 *     Scanned: package.json scripts, Markdown outside node_modules, and the
 *     source and shell files under scripts/ and docker/, plus .gitlab-ci.yml.
 *   - shebang: an init script's own `#!` line that runs tsx names the
 *     condition too.
 *   - direct-register: a file under scripts/ that calls registerInitLoader()
 *     itself. That loader gets the server's contract (log and retry), so a
 *     failed load would again leave the script posting into nothing.
 * An invocation the scan cannot see (a path built at runtime, one split across
 * lines without a backslash) still stops at run time with the fix in the
 * message. No allowlist.
 */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

export const SCRIPT_HELPER = 'scripts/lib/register-init-loader.ts'

const CONDITION_RE = /(?:--conditions|-C)['"]?\s*[,=]?\s*['"]?react-server\b/
const TSX_RE = /(?<![.\w-])tsx\b/
const SOURCE_EXT_RE = /\.(?:ts|mts|cts|js|mjs|cjs)$/
const SCANNED_EXT_RE = /\.(?:ts|mts|cts|js|mjs|cjs|sh|md)$/
const IGNORE_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'coverage', '__tests__'])
// Ephemeral agent checkouts of this repository: never part of it.
const WORKTREES_DIR = path.join('.claude', 'worktrees')

export const SCRIPT_INIT_CONDITION_HINT =
  'Run a script that loads lib/init under the react-server condition: node --import tsx --conditions react-server ' +
  "scripts/<script>.ts (npx tsx --conditions react-server ...; in a spawn or fork, add '--conditions', 'react-server' " +
  'to the node arguments), and register its loader with registerScriptInitLoader() from scripts/lib/register-init-loader.ts.'

function walk(dir, accept, out = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (!IGNORE_DIRS.has(e.name) && !full.endsWith(WORKTREES_DIR)) walk(full, accept, out)
    } else if (accept(e.name)) {
      out.push(full)
    }
  }
  return out
}

/** The names of the functions a module calls, from its syntax tree. */
function calledNames(fileName, text) {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false)
  const names = new Set()
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) names.add(node.expression.text)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return names
}

/** Lines of a text, a line ending in a backslash joined with the next, each with its first line number. */
function logicalLines(text) {
  const lines = []
  let start = 0
  let buffer = null
  text.split('\n').forEach((line, i) => {
    if (buffer === null) {
      buffer = line
      start = i + 1
    } else {
      buffer += ` ${line}`
    }
    if (!/\\\s*$/.test(line)) {
      lines.push({ line: start, text: buffer })
      buffer = null
    }
  })
  if (buffer !== null) lines.push({ line: start, text: buffer })
  return lines
}

const runsWithTsx = (text) => TSX_RE.test(text)
const namesCondition = (text) => CONDITION_RE.test(text)

/**
 * @param {string} root repository root
 * @returns {{ initScripts: string[], findings: { rule: string, file: string, line: number, script?: string, text: string }[] }}
 *   repository-relative forward-slash paths; findings sorted by file and line
 */
export function findScriptInitConditionFindings(root) {
  const rel = (p) => path.relative(root, p).split(path.sep).join('/')
  const findings = []

  // 1. The init scripts, and any script that registers the server's loader itself.
  const initScripts = []
  for (const file of walk(path.join(root, 'scripts'), (name) => SOURCE_EXT_RE.test(name) && !/\.test\./.test(name))) {
    const relPath = rel(file)
    if (relPath === SCRIPT_HELPER || relPath.startsWith('scripts/checks/')) continue
    const text = fs.readFileSync(file, 'utf8')
    if (!text.includes('InitLoader')) continue
    const called = calledNames(file, text)
    if (called.has('registerScriptInitLoader')) initScripts.push({ path: relPath, text })
    if (called.has('registerInitLoader')) {
      const line = text.split('\n').findIndex((l) => l.includes('registerInitLoader(')) + 1
      findings.push({ rule: 'direct-register', file: relPath, line, text: 'registerInitLoader(...)' })
    }
  }
  initScripts.sort((a, b) => a.path.localeCompare(b.path))

  // 2. Each init script's own shebang.
  for (const { path: file, text } of initScripts) {
    const first = text.split('\n', 1)[0]
    if (first.startsWith('#!') && runsWithTsx(first) && !namesCondition(first)) {
      findings.push({ rule: 'shebang', file, line: 1, script: file, text: first.trim() })
    }
  }

  // 3. Every line that runs an init script with tsx.
  const scanned = [
    ...walk(root, (name) => name.endsWith('.md')),
    ...walk(path.join(root, 'scripts'), (name) => SCANNED_EXT_RE.test(name)),
    ...walk(path.join(root, 'docker'), (name) => SCANNED_EXT_RE.test(name)),
    path.join(root, '.gitlab-ci.yml'),
  ]
  const checkLine = (file, line, text) => {
    for (const { path: script } of initScripts) {
      if (text.includes(script) && runsWithTsx(text) && !namesCondition(text)) {
        findings.push({ rule: 'missing-condition', file, line, script, text: text.trim() })
      }
    }
  }
  for (const file of [...new Set(scanned)]) {
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    if (!initScripts.some(({ path: script }) => text.includes(script))) continue
    for (const { line, text: lineText } of logicalLines(text)) checkLine(rel(file), line, lineText)
  }

  // 4. package.json scripts.
  const pkgPath = path.join(root, 'package.json')
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
      checkLine('package.json', 0, `"${name}": ${command}`)
    }
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
  return { initScripts: initScripts.map(({ path: p }) => p), findings }
}
