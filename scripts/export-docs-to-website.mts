/**
 * One-shot script that exports the registry-derived docs content (errors +
 * reference) plus the static Connect-with-Claude page as TypeScript modules
 * into the gnubok-website repo. Connect-with-Claude ships in both languages:
 * the docs site has no locale routing, so each language is its own page.
 *
 * Run with `npx tsx scripts/export-docs-to-website.mts`. Re-run whenever
 * structured-errors, the v1 endpoint registry, or connect-claude materially
 * changes.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'

// `server-only` throws on import outside a Next.js server-component graph. The
// reference builder pulls it in transitively (lib/api/v1/load-routes -> every
// v1 route -> lib/init -> lib/analytics/posthog-observability ->
// posthog-server), which broke this script the moment PostHog landed. Nothing
// here executes request-time code: it only reads exported markdown builders,
// so a no-op stub is the honest resolution.
const require = createRequire(import.meta.url)
const ModuleCtor = require('node:module') as {
  _load: (request: string, ...rest: unknown[]) => unknown
}
const originalLoad = ModuleCtor._load
ModuleCtor._load = function (request: string, ...rest: unknown[]) {
  if (request === 'server-only') return {}
  return originalLoad.call(this, request, ...rest)
}

let errors, reference, connectClaude, anslutClaude
try {
  errors = await import('@/lib/docs/content/errors')
  reference = await import('@/lib/docs/content/reference')
  connectClaude = await import('@/lib/docs/content/connect-claude')
  anslutClaude = await import('@/lib/docs/content/anslut-claude')
} finally {
  // Scope the stub to the imports that need it: leaving a global loader hook
  // patched for the rest of the process would silently disarm the guard for
  // anything imported later (compliance swarm, ISO 27001 A.8.28).
  ModuleCtor._load = originalLoad
}

const buildErrorReferenceMd = errors.buildErrorReferenceMd ?? (errors as { default?: typeof errors }).default?.buildErrorReferenceMd
const buildResourcePages = reference.buildResourcePages ?? (reference as { default?: typeof reference }).default?.buildResourcePages
const buildReferenceOverviewMd = reference.buildReferenceOverviewMd ?? (reference as { default?: typeof reference }).default?.buildReferenceOverviewMd

if (!buildErrorReferenceMd || !buildResourcePages || !buildReferenceOverviewMd) {
  console.error('Missing builder exports. Inspect:', {
    errorsKeys: Object.keys(errors),
    referenceKeys: Object.keys(reference),
  })
  process.exit(1)
}

const WEBSITE = resolve('/Users/jakobwennberg/gnubok-website')

/**
 * The website is served from www.accounted.se while the API (and everything
 * under /api/v1 and /.well-known) lives on app.gnubok.se — root-relative links
 * to app-served resources would 404 on the website, so absolutise them.
 */
const APP_ORIGIN = 'https://app.gnubok.se'
function adaptForWebsite(md: string): string {
  return md
    .replaceAll('](/api/v1/', `](${APP_ORIGIN}/api/v1/`)
    .replaceAll('](/.well-known/', `](${APP_ORIGIN}/.well-known/`)
}

function write(rel: string, content: string) {
  const out = resolve(WEBSITE, rel)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, content)
  console.log(`wrote ${out} (${content.length} chars)`)
}

const errorsMd = adaptForWebsite(buildErrorReferenceMd())
write(
  'lib/docs/content/errors.generated.ts',
  `// AUTO-GENERATED from erp-base: do not hand-edit.\n// Regenerate via \`npx tsx scripts/export-docs-to-website.mts\` in erp-base.\nexport const ERRORS_MD = ${JSON.stringify(errorsMd)}\n`,
)

const refOverview = adaptForWebsite(buildReferenceOverviewMd())
const refPages = buildResourcePages()
const slugs = refPages.map((p: { slug: string }) => p.slug)

const pagesPayload = refPages.map((p: { slug: string; label: string; description: string; markdown: string }) => ({
  slug: p.slug,
  label: p.label,
  description: p.description,
  markdown: adaptForWebsite(p.markdown),
}))

write(
  'lib/docs/content/reference.generated.ts',
  `// AUTO-GENERATED from erp-base: do not hand-edit.\n// Regenerate via \`npx tsx scripts/export-docs-to-website.mts\` in erp-base.\n\nexport const REFERENCE_OVERVIEW_MD = ${JSON.stringify(refOverview)}\n\nexport interface ResourcePage {\n  slug: string\n  label: string\n  description: string\n  markdown: string\n}\n\nexport const RESOURCE_SLUGS: readonly string[] = ${JSON.stringify(
    slugs,
  )} as const\n\nexport const RESOURCE_PAGES: ResourcePage[] = ${JSON.stringify(pagesPayload, null, 2)}\n\nexport function findResourcePage(slug: string): ResourcePage | undefined {\n  return RESOURCE_PAGES.find((p) => p.slug === slug)\n}\n`,
)

const connectClaudeMd = connectClaude.CONNECT_CLAUDE_MD && adaptForWebsite(connectClaude.CONNECT_CLAUDE_MD)
if (!connectClaudeMd) {
  console.error('Missing CONNECT_CLAUDE_MD export. Inspect:', { connectClaudeKeys: Object.keys(connectClaude) })
  process.exit(1)
}
write(
  'lib/docs/content/connect-claude.generated.ts',
  `// AUTO-GENERATED from erp-base: do not hand-edit.\n// Regenerate via \`npx tsx scripts/export-docs-to-website.mts\` in erp-base.\nexport const CONNECT_CLAUDE_MD = ${JSON.stringify(connectClaudeMd)}\n`,
)

const anslutClaudeMd = anslutClaude.ANSLUT_CLAUDE_MD && adaptForWebsite(anslutClaude.ANSLUT_CLAUDE_MD)
if (!anslutClaudeMd) {
  console.error('Missing ANSLUT_CLAUDE_MD export. Inspect:', { anslutClaudeKeys: Object.keys(anslutClaude) })
  process.exit(1)
}
write(
  'lib/docs/content/anslut-claude.generated.ts',
  `// AUTO-GENERATED from erp-base: do not hand-edit.\n// Regenerate via \`npx tsx scripts/export-docs-to-website.mts\` in erp-base.\nexport const ANSLUT_CLAUDE_MD = ${JSON.stringify(anslutClaudeMd)}\n`,
)

console.log('done.')
