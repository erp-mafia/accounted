/**
 * Pure lookups over the module manifest (./manifest.ts): which module owns
 * an operation id, a v1 path or a src/lib file. Each answers a module id or
 * undefined; the tests in __tests__/ make sure every operation, every v1
 * endpoint and every src/lib folder resolves.
 */
import { MODULES, type ModuleDefinition, type ModuleId } from './manifest'

const byId = new Map<string, ModuleDefinition>(MODULES.map((m) => [m.id, m]))

const byOperationPrefix = new Map<string, ModuleId>()
for (const m of MODULES) for (const prefix of m.operationPrefixes) byOperationPrefix.set(prefix, m.id)

/** v1 claims as segment lists, longest first so the most specific claim wins. */
const v1Claims: Array<{ segments: string[]; module: ModuleId }> = MODULES.flatMap((m) =>
  m.v1Segments.map((claim) => ({ segments: claim.split('/'), module: m.id })),
).sort((a, b) => b.segments.length - a.segments.length)

/** lib folder claims, longest first so `bokslut/assets` beats `bokslut`. */
const libClaims: Array<{ folder: string; module: ModuleId }> = MODULES.flatMap((m) =>
  m.libFolders.map((folder) => ({ folder, module: m.id })),
).sort((a, b) => b.folder.length - a.folder.length)

export function getModule(id: ModuleId): ModuleDefinition
export function getModule(id: string): ModuleDefinition | undefined
export function getModule(id: string): ModuleDefinition | undefined {
  return byId.get(id)
}

/** The module of an operation id such as `invoices.book`: its prefix before the first dot. */
export function moduleForOperationId(operationId: string): ModuleId | undefined {
  const dot = operationId.indexOf('.')
  if (dot <= 0) return undefined
  return byOperationPrefix.get(operationId.slice(0, dot))
}

function isPlaceholder(segment: string): boolean {
  return segment.startsWith(':') || (segment.startsWith('{') && segment.endsWith('}'))
}

/**
 * The module of a v1 path: a registered pattern
 * (`/api/v1/companies/:companyId/invoices/:id`), its OpenAPI spelling
 * (`{companyId}`) or a concrete request path. Undefined outside /api/v1 or
 * for a segment no module claims.
 */
export function moduleForV1Path(path: string): ModuleId | undefined {
  const clean = path.split(/[?#]/)[0]
  const prefix = '/api/v1/'
  if (!clean.startsWith(prefix)) return undefined
  const segments = clean.slice(prefix.length).split('/').filter(Boolean)
  // /api/v1/companies/{companyId}/<segment>/... is company-scoped; a bare
  // /api/v1/companies is the company list, claimed like any other segment.
  const rest = segments[0] === 'companies' && segments.length >= 3 ? segments.slice(2) : segments
  if (rest.length === 0) return undefined
  for (const claim of v1Claims) {
    if (claim.segments.length > rest.length) continue
    const matches = claim.segments.every((seg, i) => (isPlaceholder(seg) ? true : seg === rest[i]))
    if (matches) return claim.module
  }
  return undefined
}

/**
 * The path relative to src/lib, without extension, for any of the spellings
 * a caller has at hand: `src/lib/x/y.ts`, an absolute path containing
 * `/src/lib/`, `@/lib/x/y`, `lib/x/y`, or a path already relative to
 * src/lib. Undefined for a path that is clearly outside src/lib.
 */
function libRelative(filePath: string): string | undefined {
  const p = filePath.replace(/\\/g, '/')
  let rel: string
  const marker = p.indexOf('/src/lib/')
  if (marker >= 0) rel = p.slice(marker + '/src/lib/'.length)
  else if (p.startsWith('src/lib/')) rel = p.slice('src/lib/'.length)
  else if (p.startsWith('@/lib/')) rel = p.slice('@/lib/'.length)
  else if (p.startsWith('lib/')) rel = p.slice('lib/'.length)
  else if (p.startsWith('/') || p.startsWith('@/') || p.startsWith('src/') || p.startsWith('.')) return undefined
  else rel = p
  return rel.replace(/\.(d\.ts|tsx?|mjs|cjs|js)$/, '').replace(/\/index$/, '')
}

/**
 * The module that owns a file under src/lib, by the longest `libFolders`
 * claim. Undefined for shared infrastructure (INFRA_LIB_FOLDERS, files
 * directly in src/lib) and for paths outside src/lib.
 */
export function moduleForLibPath(filePath: string): ModuleId | undefined {
  const rel = libRelative(filePath)
  if (!rel) return undefined
  for (const claim of libClaims) {
    if (rel === claim.folder || rel.startsWith(`${claim.folder}/`)) return claim.module
  }
  return undefined
}

/** A module's dependencies including the implicit ones: every block needs every kernel. */
export function effectiveDependencies(module: ModuleDefinition): readonly ModuleId[] {
  if (module.kind === 'kernel') return module.dependsOn
  const kernels = MODULES.filter((m) => m.kind === 'kernel').map((m) => m.id)
  return [...new Set([...kernels, ...module.dependsOn])]
}

/**
 * The modules a module's code may import besides itself, the kernel and
 * shared infrastructure: its product dependencies (`dependsOn`) and its code
 * dependencies (`uses`). The boundary ratchet counts every other import.
 */
export function importableModules(module: ModuleDefinition): ReadonlySet<ModuleId> {
  return new Set([...module.dependsOn, ...module.uses])
}

/**
 * Every module with its dependencies before it (kernels first), stable in
 * manifest order otherwise. Throws when `dependsOn` forms a cycle or names
 * an unknown module; the manifest test keeps that from ever shipping.
 */
export function modulesInDependencyOrder(): readonly ModuleDefinition[] {
  const ordered: ModuleDefinition[] = []
  const placed = new Set<string>()
  const remaining = [...MODULES]
  while (remaining.length > 0) {
    const index = remaining.findIndex((m) => effectiveDependencies(m).every((dep) => placed.has(dep)))
    if (index < 0) {
      throw new Error(
        `module dependsOn is cyclic or names an unknown module: ${remaining.map((m) => m.id).join(', ')}`,
      )
    }
    const [next] = remaining.splice(index, 1)
    ordered.push(next)
    placed.add(next.id)
  }
  return ordered
}
