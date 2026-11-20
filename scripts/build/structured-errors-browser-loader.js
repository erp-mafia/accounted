/**
 * Turbopack loader: the browser copy of src/lib/errors/structured-errors.ts.
 *
 * The registry is one module for every runtime: errorResponse() on the server
 * reads httpStatus and remediation, getErrorMessage() in the browser reads the
 * Swedish and English messages. Shipped as written, the whole catalog (about
 * 320 KB minified) went to the browser with every page that can show an
 * error, remediation texts for agents included, which no client code reads
 * from the registry (an API envelope carries its own remediation).
 *
 * next.config.ts applies this loader to that one file under the `browser`
 * condition only, so the server, the tests, tsc and ESLint all keep reading
 * the real module. The loader evaluates the module (it has no imports) and
 * emits the same four functions over the same codes, with every entry field
 * kept except `remediation`. Nothing is generated into the repo: a new code
 * is in the browser copy on the next dev compile or build.
 *
 * scripts/__tests__/structured-errors-browser-loader.test.ts runs this
 * over the real file and compares every code against the module itself.
 */
'use strict'

// A Turbopack (webpack) loader is loaded with require(): CommonJS by contract.
/* eslint-disable @typescript-eslint/no-require-imports */
const vm = require('node:vm')
const ts = require('typescript')
/* eslint-enable @typescript-eslint/no-require-imports */

/** The module's value exports. A new one fails the build here, never silently in the browser. */
const KNOWN_EXPORTS = [
  'conflictCode',
  'getErrorEntry',
  'hasErrorEntry',
  'listErrorCodes',
  'SI_CREATE_INVALID_INPUT_REASONS',
  'siCreateInvalidInputMessages',
]

/** Fields the browser copy leaves out: read only by server code. */
const SERVER_ONLY_FIELDS = new Set(['remediation'])

function evaluateCatalog(source, fileName) {
  const { outputText } = ts.transpileModule(source, {
    fileName,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  })
  const sandboxModule = { exports: {} }
  const sandboxRequire = (specifier) => {
    throw new Error(
      `structured-errors-browser-loader: ${fileName} imports '${specifier}'. The browser copy evaluates ` +
        'the registry standalone; keep the module free of imports or teach the loader to resolve them.',
    )
  }
  vm.runInNewContext(
    outputText,
    { module: sandboxModule, exports: sandboxModule.exports, require: sandboxRequire },
    { filename: fileName },
  )
  return sandboxModule.exports
}

/** The browser module source for a structured-errors.ts source text. */
function browserCatalogSource(source, fileName = 'structured-errors.ts') {
  const catalog = evaluateCatalog(source, fileName)
  const unknown = Object.keys(catalog).filter((name) => !KNOWN_EXPORTS.includes(name))
  if (unknown.length) {
    throw new Error(
      `structured-errors-browser-loader: ${fileName} exports ${unknown.join(', ')}, which the browser copy ` +
        'does not carry. Add it to KNOWN_EXPORTS and to the emitted module in scripts/build/structured-errors-browser-loader.js.',
    )
  }

  // [httpStatus, message_sv, message_en, rest?]: the three fields every entry
  // has, positionally, so 1,000+ entries do not repeat their key names.
  const rows = {}
  const conflicts = []
  for (const code of catalog.listErrorCodes()) {
    const { httpStatus, message_sv, message_en, ...more } = catalog.getErrorEntry(code)
    const rest = {}
    for (const [key, value] of Object.entries(more)) {
      if (!SERVER_ONLY_FIELDS.has(key)) rest[key] = value
    }
    rows[code] = Object.keys(rest).length
      ? [httpStatus, message_sv, message_en, rest]
      : [httpStatus, message_sv, message_en]
    if (catalog.conflictCode(code) === code) conflicts.push(code)
  }

  return `// Browser copy of src/lib/errors/structured-errors.ts, emitted by
// scripts/build/structured-errors-browser-loader.js: every entry field but remediation.
const ROWS = JSON.parse(${JSON.stringify(JSON.stringify(rows))})
const DB_CONFLICTS = new Set(${JSON.stringify(conflicts)})
export const SI_CREATE_INVALID_INPUT_REASONS = JSON.parse(${JSON.stringify(JSON.stringify(catalog.SI_CREATE_INVALID_INPUT_REASONS ?? {}))})
const REGISTRY = {}
for (const code of Object.keys(ROWS)) {
  const [httpStatus, message_sv, message_en, rest] = ROWS[code]
  REGISTRY[code] = { httpStatus, message_sv, message_en, ...rest }
}
export function conflictCode(dbMessage) {
  return typeof dbMessage === 'string' && DB_CONFLICTS.has(dbMessage) ? dbMessage : 'CONFLICT'
}
export function getErrorEntry(code) {
  return REGISTRY[code]
}
export function hasErrorEntry(code) {
  return code in REGISTRY
}
export function listErrorCodes() {
  return Object.keys(REGISTRY)
}
export function siCreateInvalidInputMessages(details) {
  const reason = details == null ? undefined : details.reason
  if (typeof reason !== 'string' || !Object.hasOwn(SI_CREATE_INVALID_INPUT_REASONS, reason)) return null
  return SI_CREATE_INVALID_INPUT_REASONS[reason]
}
`
}

module.exports = function structuredErrorsBrowserLoader(source) {
  return browserCatalogSource(source, this.resourcePath)
}
module.exports.browserCatalogSource = browserCatalogSource
