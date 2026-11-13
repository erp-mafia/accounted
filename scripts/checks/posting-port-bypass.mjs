#!/usr/bin/env node
/**
 * Guard: code outside the posting port that calls the engine's posting
 * functions directly (step 3 of the posting port, Phase 2's ratchet).
 *
 * Since step 2 every TypeScript producer of journal entries posts through
 * `postingPort` (src/lib/posting), which records the business event and hands
 * the producer's input to the engine through its one adapter
 * (lib/posting/ledger-adapter.ts). A new door that imports createJournalEntry,
 * reverseEntry, correctEntry or one of the SQL commit wrappers directly posts
 * a verifikat with no business event, and nothing else would notice: booking
 * output is identical, the event is simply missing. This guard is what keeps
 * new code on the port.
 *
 * POSTING_SURFACE is every export that creates, numbers, reverses or corrects
 * a verifikat; ENGINE_HELPERS is every other value export of the same modules
 * (reads, pure checks, draft upkeep that numbers nothing), with the reason it
 * stays open. The test fails on an export that is in neither list, so a new
 * engine function is classified when it is written.
 *
 * Counted: a value import of a guarded name (named, aliased, `@/` or relative
 * path, with or without an extension), a namespace import or `import x =
 * require()` whose binding reaches a guarded name, a dynamic `import()` or
 * `require()` of a surface module, and a re-export of a guarded name. A
 * namespace binding used other than through a member access counts as `*`
 * (the whole surface). Type-only imports and `typeof` positions are not calls
 * and are not counted.
 *
 * Allowed: POSTING_CALLERS (the port, the engine and storno service
 * themselves, and the engine's set posting), tests (`__tests__/`,
 * `*.test.ts(x)`, the root `tests/` tree), and PERMANENT_ALLOWLIST, one
 * (file, name) pair at a time with its reason. Everything else is a bypass,
 * tracked as (file, name) edges against `postingPortBypass` in
 * antipatterns-baseline.json: a new edge fails, a removed edge passes and is
 * reported as progress, and `--update` only ever drops edges (it never
 * grandfathers a new one).
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

/**
 * The guarded names per module (src-relative module path without extension).
 * The comment on each says why it posts and which port door replaces it.
 */
export const POSTING_SURFACE = {
  'lib/bookkeeping/engine': [
    // Drafts and commits one verifikat. Port: postJournalEntry.
    'createJournalEntry',
    // The draft a verifikat is numbered from; the event link is written with
    // it, before a number is drawn. Port: draftJournalEntry.
    'createDraftEntry',
    // Draws the voucher number (commit_journal_entry). Port: commitJournalEntry.
    'commitEntry',
    // Posts a storno. Port: reverseJournalEntry.
    'reverseEntry',
    // Numbers a storno or rättelse draft; storno-service's own commit. Port:
    // correctJournalEntry.
    'commitStornoOrCorrectionDraft',
    // Advances the voucher sequence: a number drawn outside a commit is a gap
    // that needs an explanation (BFNAR 2013:2). No caller outside the engine.
    'allocateVoucherNumber',
    // Drafts and commits a planenlig avskrivning. No caller outside the engine.
    'createAssetDepreciationEntry',
    // The SQL posting wrappers: each drafts or commits a verifikat in one
    // database transaction. Port: commitSqlPosting (the events from
    // recordEventsForSql, or the asset door's draft, travel in the wrapper's
    // own arguments).
    'commitAssetDepreciation', // commit_asset_depreciation
    'commitAssetDisposal', // commit_asset_disposal
    'commitAssetComponentReplacement', // commit_asset_component_replacement
    'commitAssetValueAdjustment', // commit_asset_value_adjustment
    'commitDeferredTax', // commit_deferred_tax
    'commitContractRevenue', // commit_contract_revenue
    'commitK3Transition', // commit_k3_transition
    'commitAccrualInstallment', // commit_accrual_installment
    'commitAccrualDissolution', // commit_accrual_dissolution
    'replaceOpeningBalanceEntry', // commit_opening_balance_replacement
    'commitBulkBooking', // bulk_book_transactions
    'commitMatchBatchAllocation', // match_batch_allocate
    'commitExpensePayoutBatch', // create_expense_payout_batch
    'commitInvoiceVoucherLink', // link_invoice_to_voucher
    'commitSupplierInvoiceVoucherLink', // link_supplier_invoice_to_voucher
    'commitCounterpartySetoff', // book_counterparty_setoff
    // The SIE import job's writers (import_sie_chunk, undo_sie_*_chunk). The
    // job records one event through recordEvent; see PERMANENT_ALLOWLIST.
    'commitSIEImportChunk',
    'reverseSIEImportChunk',
  ],
  'lib/core/bookkeeping/storno-service': [
    // Storno plus rättelse. Port: correctJournalEntry.
    'correctEntry',
    // Storno plus the verifikat on its new date. Port: correctJournalEntry.
    'recordateEntry',
  ],
  'lib/bookkeeping/journal-entry-batch': [
    // A set of verifikat posted all or nothing. Port: postJournalEntrySet.
    'createJournalEntries',
  ],
}

/**
 * The other value exports of the surface modules, which any code may call.
 * Classifying every export keeps a new posting function from slipping in
 * unguarded: the test fails on an export that is in neither list.
 */
export const ENGINE_HELPERS = {
  'lib/bookkeeping/engine': {
    validateBalance: 'a pure check of debit against credit, no I/O',
    assertLinesWellFormed: 'a pure check of line sides and amounts, no I/O',
    peekNextVoucherNumber: 'reads voucher_sequences without advancing it',
    findFiscalPeriod: 'reads the fiscal period of a date',
    updateDraftEntry:
      'edits a draft in place: no number is drawn and nothing is posted; the draft was made through ' +
      'draftJournalEntry, which linked its event, and its commit goes through commitJournalEntry',
    cancelDraftEntry: 'cancels a draft, which holds no number: nothing is posted or numbered',
    cancelOrphanedEntry:
      "compensation of a verifikat the same request just created, through the database-gated " +
      'cancel_orphaned_entry RPC: nothing is posted or numbered (the cancelled header keeps its number), ' +
      'and the port has no door for it',
    releaseBankRowsOfReversedEntry:
      'releases the bank rows a reversed verifikat still anchors back to Att bokföra: writes ' +
      'transactions and transaction_voucher_links only, nothing is posted or numbered',
  },
  'lib/core/bookkeeping/storno-service': {},
  'lib/bookkeeping/journal-entry-batch': {},
}

/**
 * Files that may call the surface (src-relative; a path ending in '/' covers
 * its subtree). Keep it to the port and the engine's own files.
 */
export const POSTING_CALLERS = [
  // The posting port and its ledger adapter, the one intended caller.
  'lib/posting/',
  // The engine and the storno service themselves.
  'lib/bookkeeping/engine.ts',
  'lib/core/bookkeeping/storno-service.ts',
  // The engine's set posting (createJournalEntries): drafts every verifikat of
  // a set, then commits them in order. Itself guarded surface.
  'lib/bookkeeping/journal-entry-batch.ts',
]

/**
 * (file, name) pairs that bypass the port on purpose and stay. Unlike the
 * baseline, an entry here is not waiting to move: it says why it never will.
 */
export const PERMANENT_ALLOWLIST = {
  'lib/import/sie-job-worker.ts': {
    names: ['commitSIEImportChunk', 'reverseSIEImportChunk'],
    reason:
      'An SIE import job is one business event (design call 1): the worker records ledger.history_import ' +
      'through postingPort.recordEvent before complete_sie_import_job, and the verifikat are written in ' +
      'SQL by import_sie_chunk, chunk by chunk under the job lease, linked to no event; an undo records ' +
      'nothing new. A port door for the chunk writers would pass them through and link nothing.',
  },
}

export const POSTING_PORT_BYPASS_HINT = [
  'post through the posting port instead: postingPort from @/lib/posting (postJournalEntry,',
  'draftJournalEntry + commitJournalEntry, reverseJournalEntry, correctJournalEntry, postJournalEntrySet,',
  'recordEvent, recordEventsForSql + commitSqlPosting), which records the business event and hands your',
  'input to the engine unchanged through lib/posting/ledger-adapter.ts. A new SQL posting wrapper gets its',
  'case in commitSqlPosting (SqlPostingDoors). A caller that must stay off the port goes in PERMANENT_ALLOWLIST in',
  'scripts/checks/posting-port-bypass.mjs with its reason, never in the baseline.',
]

const SCAN_DIRS = ['src', 'scripts']
const IGNORE_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'coverage', '__tests__'])
const EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'])
const SURFACE_SPECIFIER_HINT_RE =
  /['"`][^'"`\n]*(?:\/engine|storno-service|journal-entry-batch)(?:\.[cm]?[jt]sx?)?['"`]/

/** Tests, which spell out and mock the engine on purpose. */
export const isTestFile = (relPath) =>
  relPath.includes('__tests__/') || /\.test\.[cm]?[jt]sx?$/.test(relPath) || relPath.startsWith('tests/')

/** True when relPath is one of the posting callers (a 'dir/' entry covers its subtree). */
export const isPostingCaller = (relPath) =>
  POSTING_CALLERS.some((p) => (p.endsWith('/') ? relPath.startsWith(p) : relPath === p))

/**
 * A module specifier as a src-relative module path, or null for a package.
 * relPath is the importing file: src-relative for a file under src, repo-
 * relative otherwise (a script reaches the engine as '../src/lib/...').
 */
export function resolveSurfaceModule(specifier, relPath) {
  let mod
  if (specifier.startsWith('@/')) mod = specifier.slice(2)
  else if (specifier.startsWith('.')) mod = path.posix.normalize(path.posix.join(path.posix.dirname(relPath), specifier))
  else return null
  mod = mod
    .replace(/^src\//, '')
    .replace(/\.(?:[cm]?[jt]sx?)$/, '')
    .replace(/\/index$/, '')
  return Object.hasOwn(POSTING_SURFACE, mod) ? mod : null
}

const isGuarded = (mod, name) => POSTING_SURFACE[mod].includes(name)

const textOfName = (name) =>
  name && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name))
    ? name.text
    : null

/** The expression an import() or require() call's value lands in, past await and parentheses. */
function valueSite(node) {
  let site = node
  while (site.parent && (ts.isAwaitExpression(site.parent) || ts.isParenthesizedExpression(site.parent))) {
    site = site.parent
  }
  return site
}

/** True when an await lies between an import() call and the site its value lands in. */
function crossesAwait(call, site) {
  for (let node = call.parent; node && node !== site.parent; node = node.parent) {
    if (ts.isAwaitExpression(node)) return true
  }
  return false
}

/**
 * The guarded names one file reaches, sorted, with '*' for a namespace or
 * module value whose use cannot be narrowed to named members.
 * @param {string} source
 * @param {string} relPath src-relative (or repo-relative outside src) path of the file
 * @returns {string[]}
 */
export function findPostingSurfaceUsesInSource(source, relPath) {
  const kind = relPath.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : /\.[cm]?js$/.test(relPath)
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS
  const sf = ts.createSourceFile(relPath, source, ts.ScriptTarget.Latest, true, kind)
  const found = new Set()
  /** namespace bindings to follow: { name, mod, decl } */
  const namespaces = []

  const recordBinding = (mod, pattern) => {
    for (const el of pattern.elements) {
      if (el.dotDotDotToken) {
        found.add('*')
        continue
      }
      const key = textOfName(el.propertyName ?? el.name)
      if (key === null) found.add('*')
      else if (isGuarded(mod, key)) found.add(key)
    }
  }

  const recordModuleValue = (call, mod) => {
    const site = valueSite(call)
    const parent = site.parent
    // A member of the module itself: require() returns it, import() only
    // once awaited (`import(x).then(...)` is a member of the promise).
    const isModuleValue = call.expression.kind !== ts.SyntaxKind.ImportKeyword || crossesAwait(call, site)
    if (!isModuleValue) {
      found.add('*')
      return
    }
    if (parent && ts.isVariableDeclaration(parent) && parent.initializer === site) {
      if (ts.isObjectBindingPattern(parent.name)) recordBinding(mod, parent.name)
      else if (ts.isIdentifier(parent.name)) namespaces.push({ name: parent.name.text, mod, decl: parent.name })
      else found.add('*')
      return
    }
    if (parent && ts.isPropertyAccessExpression(parent) && parent.expression === site) {
      if (isGuarded(mod, parent.name.text)) found.add(parent.name.text)
      return
    }
    found.add('*')
  }

  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const mod = resolveSurfaceModule(node.moduleSpecifier.text, relPath)
      const clause = node.importClause
      if (mod && clause && !clause.isTypeOnly && clause.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          namespaces.push({ name: clause.namedBindings.name.text, mod, decl: clause.namedBindings.name })
        } else {
          for (const el of clause.namedBindings.elements) {
            if (el.isTypeOnly) continue
            const imported = (el.propertyName ?? el.name).text
            if (isGuarded(mod, imported)) found.add(imported)
          }
        }
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const mod = resolveSurfaceModule(node.moduleSpecifier.text, relPath)
      if (mod && !node.isTypeOnly) {
        if (!node.exportClause || ts.isNamespaceExport(node.exportClause)) found.add('*')
        else {
          for (const el of node.exportClause.elements) {
            if (el.isTypeOnly) continue
            const exported = (el.propertyName ?? el.name).text
            if (isGuarded(mod, exported)) found.add(exported)
          }
        }
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      const mod = resolveSurfaceModule(node.moduleReference.expression.text, relPath)
      if (mod) namespaces.push({ name: node.name.text, mod, decl: node.name })
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      const mod = resolveSurfaceModule(node.arguments[0].text, relPath)
      if (mod) recordModuleValue(node, mod)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)

  // A namespace binding counts by the members it reaches: `engine.reverseEntry`
  // is reverseEntry, `const { commitEntry } = engine` is commitEntry, and a
  // binding that escapes (passed on, spread, indexed by a variable) reaches
  // the whole surface. A `typeof engine.x` type position is not a call.
  for (const ns of namespaces) {
    const visitUse = (node) => {
      if (ts.isIdentifier(node) && node.text === ns.name && node !== ns.decl) {
        const parent = node.parent
        if (ts.isQualifiedName(parent) || ts.isTypeQueryNode(parent)) {
          // type position
        } else if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
          if (isGuarded(ns.mod, parent.name.text)) found.add(parent.name.text)
        } else if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
          // `x.engine`: another object's member of the same name
        } else if (ts.isElementAccessExpression(parent) && parent.expression === node) {
          const key = ts.isStringLiteralLike(parent.argumentExpression) ? parent.argumentExpression.text : null
          if (key === null) found.add('*')
          else if (isGuarded(ns.mod, key)) found.add(key)
        } else if (ts.isVariableDeclaration(parent) && parent.initializer === node && ts.isObjectBindingPattern(parent.name)) {
          recordBinding(ns.mod, parent.name)
        } else if (
          (ts.isPropertyAssignment(parent) && parent.name === node) ||
          (ts.isPropertyDeclaration(parent) && parent.name === node) ||
          (ts.isBindingElement(parent) && parent.propertyName === node)
        ) {
          // a property key of the same name, not the binding
        } else {
          found.add('*')
        }
      }
      ts.forEachChild(node, visitUse)
    }
    visitUse(sf)
  }

  return [...found].sort()
}

function walk(dir, out) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (!IGNORE_DIRS.has(e.name)) walk(full, out)
    } else if (EXTS.has(path.extname(e.name)) && !e.name.endsWith('.d.ts')) {
      out.push(full)
    }
  }
  return out
}

/** A file's path as the baseline names it: src-relative under src, repo-relative elsewhere. */
const displayPath = (root, file) =>
  path
    .relative(root, file)
    .split(path.sep)
    .join('/')
    .replace(/^src\//, '')

/**
 * Every surface use outside the posting callers and tests, under src/ and
 * scripts/ of the repository at `root`:
 *   bypasses:    { [file]: [name, ...] }  what the baseline ratchets
 *   allowlisted: { [file]: [name, ...] }  PERMANENT_ALLOWLIST pairs found
 * Keys and names are sorted.
 */
export function findPostingPortBypasses(root) {
  const bypasses = {}
  const allowlisted = {}
  for (const dir of SCAN_DIRS) {
    for (const file of walk(path.join(root, dir), [])) {
      const relPath = displayPath(root, file)
      if (isTestFile(relPath) || isPostingCaller(relPath)) continue
      const source = fs.readFileSync(file, 'utf8')
      // Parse only a file that names a surface module in a string ('./engine'
      // and '@/lib/bookkeeping/engine' alike); the rest cannot reach it.
      if (!SURFACE_SPECIFIER_HINT_RE.test(source)) continue
      const names = findPostingSurfaceUsesInSource(source, relPath)
      if (!names.length) continue
      const permanent = new Set(PERMANENT_ALLOWLIST[relPath]?.names ?? [])
      const kept = names.filter((n) => permanent.has(n))
      const rest = names.filter((n) => !permanent.has(n))
      if (kept.length) allowlisted[relPath] = kept
      if (rest.length) bypasses[relPath] = rest
    }
  }
  const sortKeys = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)))
  return { bypasses: sortKeys(bypasses), allowlisted: sortKeys(allowlisted) }
}

/** Number of (file, name) edges in a { [file]: names[] } map. */
export const countEdges = (files) => Object.values(files).reduce((n, names) => n + names.length, 0)

/**
 * The baseline `--update` writes: the edges both in the previous baseline and
 * found now, so a re-baseline can only drop edges. With no previous baseline
 * (the guard being introduced) it is what is found now.
 */
export function frozenBypassBaseline(previousFiles, currentFiles) {
  if (!previousFiles) return currentFiles
  const out = {}
  for (const [file, names] of Object.entries(currentFiles)) {
    const known = new Set(previousFiles[file] ?? [])
    const kept = names.filter((n) => known.has(n))
    if (kept.length) out[file] = kept
  }
  return out
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const { bypasses, allowlisted } = findPostingPortBypasses(root)
  for (const [file, names] of Object.entries(bypasses)) console.log(`bypass       ${file}: ${names.join(', ')}`)
  for (const [file, names] of Object.entries(allowlisted)) console.log(`allowlisted  ${file}: ${names.join(', ')}`)
  console.log(
    `\npostingPortBypass: ${countEdges(bypasses)} edge(s) in ${Object.keys(bypasses).length} file(s); ` +
      `permanently allowlisted: ${countEdges(allowlisted)} edge(s).`,
  )
}
