/**
 * Guards for the app/api/extensions carve-out.
 *
 * Physical routes under `app/api/extensions/<extensionId>/` are the ONE
 * sanctioned place where app code may import from `@/extensions/` (see the
 * "Check no core imports from extensions" step in
 * .github/workflows/core-build.yml, which exempts exactly this directory).
 * They exist because Vercel crons and OAuth callbacks need concrete file
 * routes; the `ext/[...path]` dispatcher covers everything else.
 *
 * The carve-out has two invariants this guard enforces:
 *
 *   1. cross-extension-import (hard fail, count 0 today): a route under
 *      app/api/extensions/<id>/ may only import from its own extension,
 *      `@/extensions/<sector>/<id>/`. Reaching into another extension from
 *      here would create hidden coupling the registry cannot see.
 *
 *   2. ungated-extension-route (ratchet, may only shrink): these routes
 *      compile into EVERY build, including the core-with-zero-extensions CI
 *      build; disabling an extension in extensions.config.json only removes
 *      it from the runtime registry, never from the filesystem. So a route
 *      that executes extension code must first check
 *      `extensionRegistry.get('<id>')` (after loadExtensions()) and refuse
 *      when the extension is not registered: otherwise a disabled extension
 *      still exposes a live, invokable surface (this is exactly how the
 *      disabled push-notifications extension shipped an always-armed cron).
 *      Pre-existing routes are allowlisted below; the set may only shrink as
 *      gates are added. A NEW route must ship with the gate.
 */
import fs from 'node:fs'
import path from 'node:path'

/**
 * Routes that predate the enablement-gate requirement. Remove an entry once
 * its route checks `extensionRegistry.get('<id>')`; never add one.
 */
export const UNGATED_EXTENSION_ROUTES = new Set([
  'app/api/extensions/cloud-backup/auto-sync/cron/route.ts',
  'app/api/extensions/enable-banking/callback/route.ts',
  'app/api/extensions/enable-banking/sync/cron/route.ts',
  'app/api/extensions/skatteverket/agi/kvittenser/cron/route.ts',
  'app/api/extensions/skatteverket/skattekonto/sync/cron/route.ts',
  'app/api/extensions/skatteverket/vat/kvittenser/cron/route.ts',
  'app/api/extensions/stripe/callback/route.ts',
  'app/api/extensions/stripe/sync/cron/route.ts',
  'app/api/extensions/stripe/transactions/cron/route.ts',
])

const EXTENSION_IMPORT_RE = /from\s+['"]@\/extensions\/[^/'"]+\/([^/'"]+)\//g

function walkRouteFiles(dir, out = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === '__tests__') continue
      walkRouteFiles(full, out)
    } else if (e.name === 'route.ts') {
      out.push(full)
    }
  }
  return out
}

/**
 * Scan app/api/extensions/<id>/ physical routes.
 * Returns { crossImports: [{ file, imported }], ungated: [file] } with
 * repo-relative, forward-slash paths.
 */
export function findExtensionRouteFindings(ROOT) {
  const base = path.join(ROOT, 'app', 'api', 'extensions')
  const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/')

  const crossImports = []
  const ungated = []

  for (const file of walkRouteFiles(base)) {
    const relPath = rel(file)
    const segments = relPath.split('/')
    const extensionId = segments[3] // app/api/extensions/<id>/...

    // The dispatcher and the generic dynamic-segment routes go through the
    // registry already and import nothing from @/extensions/.
    if (!extensionId || extensionId === 'ext' || extensionId.startsWith('[')) continue

    const src = fs.readFileSync(file, 'utf8')

    let importsOwnExtension = false
    for (const match of src.matchAll(EXTENSION_IMPORT_RE)) {
      if (match[1] === extensionId) {
        importsOwnExtension = true
      } else {
        crossImports.push({ file: relPath, imported: match[1] })
      }
    }

    if (!importsOwnExtension && crossImports.every((c) => c.file !== relPath)) continue

    const hasGate =
      src.includes(`extensionRegistry.get('${extensionId}')`) ||
      src.includes(`extensionRegistry.get("${extensionId}")`)
    if (!hasGate) ungated.push(relPath)
  }

  crossImports.sort((a, b) => a.file.localeCompare(b.file))
  ungated.sort()
  return { crossImports, ungated }
}
