#!/usr/bin/env npx tsx
/**
 * Scaffold a new extension with all required files.
 *
 * Usage:
 *   npx tsx scripts/create-extension.ts \
 *     --name my-extension \
 *     --sector general \
 *     --category operations \
 *     --description "Short description of the extension"
 *
 * This will:
 *   1. Create extensions/<sector>/<name>/ directory
 *   2. Generate manifest.json, index.ts, and api-routes.ts
 *   3. Add the extension ID to extensions.schema.json enum array
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

// ── Constants ────────────────────────────────────────────────

const VALID_SECTORS = [
  'general',
  'restaurant',
  'construction',
  'hotel',
  'tech',
  'ecommerce',
  'export',
] as const

const VALID_CATEGORIES = [
  'import',
  'operations',
  'reports',
  'accounting',
] as const

type Sector = (typeof VALID_SECTORS)[number]
type Category = (typeof VALID_CATEGORIES)[number]

// ── Helpers ──────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, '..')

function usage(): never {
  console.error(`
Usage:
  npx tsx scripts/create-extension.ts \\
    --name <extension-name> \\
    --sector <${VALID_SECTORS.join(' | ')}> \\
    --category <${VALID_CATEGORIES.join(' | ')}> \\
    --description "Short description"

Options:
  --name         Extension slug (kebab-case, e.g. "my-extension")
  --sector       Business sector for the extension
  --category     Extension category
  --description  Short description of the extension

Example:
  npx tsx scripts/create-extension.ts \\
    --name inventory-tracker \\
    --sector restaurant \\
    --category operations \\
    --description "Track inventory levels for restaurant supplies"
`)
  process.exit(1)
}

/**
 * Parse CLI arguments into a key-value map.
 * Supports --key value pairs.
 */
function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const value = argv[i + 1]
      if (!value || value.startsWith('--')) {
        console.error(`Error: Missing value for --${key}`)
        usage()
      }
      args[key] = value
      i++ // skip the value
    }
  }
  return args
}

/**
 * Convert a kebab-case slug to camelCase.
 * e.g. "my-extension" -> "myExtension"
 */
function toCamelCase(slug: string): string {
  return slug.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
}

/**
 * Convert a kebab-case slug to a camelCase export name.
 * e.g. "my-extension" -> "myExtensionExtension"
 */
function toExportName(slug: string): string {
  return `${toCamelCase(slug)}Extension`
}

/**
 * Convert a kebab-case slug to a Title Case display name.
 * e.g. "my-extension" -> "My Extension"
 */
function toDisplayName(slug: string): string {
  return slug
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/**
 * Validate that the extension name is a valid kebab-case slug.
 */
function validateName(name: string): void {
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name)) {
    console.error(
      `Error: Extension name "${name}" is not valid kebab-case.`
    )
    console.error('  Must start with a lowercase letter, use only lowercase letters, digits, and hyphens.')
    console.error('  Example: "my-extension", "pos-import", "billable-hours"')
    process.exit(1)
  }
}

// ── File generators ──────────────────────────────────────────

function generateManifest(
  name: string,
  sector: Sector,
  category: Category,
  description: string,
  exportName: string,
  entryPoint: string
): string {
  const manifest = {
    id: name,
    sector,
    exportName,
    entryPoint,
    workspace: null,
    requiredEnvVars: [] as string[],
    optionalEnvVars: [] as string[],
    npmDependencies: [] as string[],
    definition: {
      name: toDisplayName(name),
      category,
      icon: 'Box',
      dataPattern: 'core',
      description,
      longDescription: description,
    },
  }
  return JSON.stringify(manifest, null, 2) + '\n'
}

function generateIndexTs(
  name: string,
  sector: Sector,
  exportName: string,
  displayName: string
): string {
  const apiRoutesVar = `${toCamelCase(name)}ApiRoutes`
  return `import type { Extension } from '@/lib/extensions/types'
import { ${apiRoutesVar} } from './api-routes'

/**
 * ${displayName} Extension
 *
 * TODO: Add extension description here.
 */
export const ${exportName}: Extension = {
  id: '${name}',
  name: '${displayName}',
  version: '0.1.0',
  sector: '${sector}',
  apiRoutes: ${apiRoutesVar},
}
`
}

function generateApiRoutesTs(name: string): string {
  const apiRoutesVar = `${toCamelCase(name)}ApiRoutes`
  return `import type { ApiRouteDefinition } from '@/lib/extensions/types'

/**
 * API routes for the ${toDisplayName(name)} extension.
 *
 * Add route definitions here as the extension grows.
 * Each route will be served under /api/extensions/${name}/<path>.
 */
export const ${apiRoutesVar}: ApiRouteDefinition[] = []
`
}

/**
 * Add the new extension ID to extensions.schema.json enum array.
 */
function updateSchemaJson(name: string): void {
  const schemaPath = path.join(ROOT, 'extensions.schema.json')

  if (!fs.existsSync(schemaPath)) {
    console.warn('  Warning: extensions.schema.json not found, skipping enum update.')
    return
  }

  const content = fs.readFileSync(schemaPath, 'utf-8')
  const schema = JSON.parse(content)

  const enumArray: string[] = schema?.properties?.extensions?.items?.enum
  if (!Array.isArray(enumArray)) {
    console.warn('  Warning: Could not find enum array in extensions.schema.json, skipping.')
    return
  }

  if (enumArray.includes(name)) {
    console.log(`  extensions.schema.json already contains "${name}", skipping.`)
    return
  }

  enumArray.push(name)

  fs.writeFileSync(schemaPath, JSON.stringify(schema, null, 2) + '\n', 'utf-8')
  console.log(`  Updated extensions.schema.json: added "${name}" to enum array.`)
}

// ── Main ─────────────────────────────────────────────────────

function main(): void {
  const args = parseArgs(process.argv.slice(2))

  const name = args['name']
  const sector = args['sector'] as Sector | undefined
  const category = args['category'] as Category | undefined
  const description = args['description']

  // Validate required arguments
  if (!name || !sector || !category || !description) {
    const missing: string[] = []
    if (!name) missing.push('--name')
    if (!sector) missing.push('--sector')
    if (!category) missing.push('--category')
    if (!description) missing.push('--description')
    console.error(`Error: Missing required arguments: ${missing.join(', ')}`)
    usage()
  }

  validateName(name)

  if (!VALID_SECTORS.includes(sector)) {
    console.error(`Error: Invalid sector "${sector}".`)
    console.error(`  Valid sectors: ${VALID_SECTORS.join(', ')}`)
    process.exit(1)
  }

  if (!VALID_CATEGORIES.includes(category)) {
    console.error(`Error: Invalid category "${category}".`)
    console.error(`  Valid categories: ${VALID_CATEGORIES.join(', ')}`)
    process.exit(1)
  }

  const exportName = toExportName(name)
  const displayName = toDisplayName(name)
  const entryPoint = `@/extensions/${sector}/${name}`
  const extensionDir = path.join(ROOT, 'extensions', sector, name)

  // Check if extension already exists
  if (fs.existsSync(extensionDir)) {
    console.error(`Error: Extension directory already exists: ${extensionDir}`)
    process.exit(1)
  }

  console.log(`\nScaffolding extension: ${displayName}`)
  console.log(`  ID:         ${name}`)
  console.log(`  Sector:     ${sector}`)
  console.log(`  Category:   ${category}`)
  console.log(`  Export:     ${exportName}`)
  console.log(`  Entry:      ${entryPoint}`)
  console.log()

  // Create directory
  fs.mkdirSync(extensionDir, { recursive: true })
  console.log(`  Created directory: extensions/${sector}/${name}/`)

  // Write manifest.json
  const manifestPath = path.join(extensionDir, 'manifest.json')
  fs.writeFileSync(
    manifestPath,
    generateManifest(name, sector, category, description, exportName, entryPoint),
    'utf-8'
  )
  console.log(`  Created: extensions/${sector}/${name}/manifest.json`)

  // Write index.ts
  const indexPath = path.join(extensionDir, 'index.ts')
  fs.writeFileSync(
    indexPath,
    generateIndexTs(name, sector, exportName, displayName),
    'utf-8'
  )
  console.log(`  Created: extensions/${sector}/${name}/index.ts`)

  // Write api-routes.ts
  const apiRoutesPath = path.join(extensionDir, 'api-routes.ts')
  fs.writeFileSync(apiRoutesPath, generateApiRoutesTs(name), 'utf-8')
  console.log(`  Created: extensions/${sector}/${name}/api-routes.ts`)

  // Update extensions.schema.json
  updateSchemaJson(name)

  // Summary
  console.log(`
Done! Next steps:

  1. Edit the manifest.json to customize icon, dataPattern, and longDescription:
     extensions/${sector}/${name}/manifest.json

  2. Implement extension logic in index.ts:
     extensions/${sector}/${name}/index.ts

  3. Add API routes if needed in api-routes.ts:
     extensions/${sector}/${name}/api-routes.ts

  4. Add a static import to FIRST_PARTY_EXTENSIONS in lib/extensions/loader.ts:
     import { ${exportName} } from '@/extensions/${sector}/${name}'

  5. Add extension metadata to the sector registry in lib/extensions/sectors.ts

  6. Enable the extension in extensions.config.json:
     Add "${name}" to the extensions array
`)
}

main()
