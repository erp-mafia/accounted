/**
 * Packages: the modules (./manifest.ts) grouped into what a person
 * recognises and switches on or off, such as Lön or Kundfakturor. The layer
 * between the 22 technical modules and a company's own choices in the
 * Profiles and Suggestions design (2026-10-16): a profile names the packages
 * it starts with, a company switches packages, and the menu, the agent
 * briefing and MCP's tools/list hide by package. Users never see a module.
 *
 * Pure data. A company's own choice for a package is written only by an
 * approved enable_package or disable_package (lib/suggestions/
 * package-switch.ts); every company without a profile or a choice resolves
 * to every package on (./capabilities.ts).
 *
 * Ids are country-neutral and internal: the list is the design's proposal
 * and may change until the API publishes packages; after that, add packages
 * and never rename one. Every manifest module is in exactly one package or
 * in NON_PACKAGE_MODULES (__tests__/packages.test.ts), so a new module
 * cannot be forgotten. Pure data with no server imports: client code may
 * read it.
 */
import type { ModuleId } from './manifest'

export const PACKAGE_IDS = [
  'bookkeeping',
  'bank',
  'customer-invoices',
  'supplier-invoices-and-payments',
  'receipts-and-documents',
  'expenses',
  'payroll',
  'assets',
  'pos-and-webshop',
] as const

export type PackageId = (typeof PACKAGE_IDS)[number]

export interface PackageDefinition {
  readonly id: PackageId
  /** English display name. */
  readonly name: string
  /** Swedish product name, as the user meets it. */
  readonly nameSv: string
  /**
   * False for the package every company always has (Bokföring): no profile
   * or company choice turns it off, because the books themselves are the
   * legal obligation the rest of the product serves.
   */
  readonly switchable: boolean
  /** The modules this package switches, in manifest order. */
  readonly modules: readonly ModuleId[]
}

const DEFINITIONS: readonly PackageDefinition[] = [
  {
    id: 'bookkeeping',
    name: 'Bookkeeping',
    nameSv: 'Bokföring',
    switchable: false,
    modules: ['ledger', 'transactions', 'vat', 'year-end', 'skatteverket', 'deadlines', 'import', 'parties', 'corporate', 'capital'],
  },
  { id: 'bank', name: 'Bank', nameSv: 'Bank', switchable: true, modules: ['bank-feed'] },
  {
    id: 'customer-invoices',
    name: 'Customer invoices',
    nameSv: 'Kundfakturor',
    switchable: true,
    modules: ['invoicing', 'collections'],
  },
  {
    id: 'supplier-invoices-and-payments',
    name: 'Supplier invoices and payments',
    nameSv: 'Leverantörsfakturor och betalningar',
    switchable: true,
    modules: ['supplier-invoices', 'payments'],
  },
  {
    id: 'receipts-and-documents',
    name: 'Receipts and documents',
    nameSv: 'Kvitton och underlag',
    switchable: true,
    modules: ['inbox'],
  },
  { id: 'expenses', name: 'Expenses', nameSv: 'Utlägg', switchable: true, modules: ['expenses'] },
  { id: 'payroll', name: 'Payroll', nameSv: 'Lön', switchable: true, modules: ['payroll'] },
  { id: 'assets', name: 'Fixed assets', nameSv: 'Inventarier', switchable: true, modules: ['assets'] },
  {
    id: 'pos-and-webshop',
    name: 'Point of sale and webshop',
    nameSv: 'Kassa och webbshop',
    switchable: true,
    modules: ['pos', 'webshop'],
  },
]

/**
 * Modules that belong to no company package: the platform kernel every
 * module runs on, the AI agent and the byrå tools. None of them is
 * something a company switches with its packages; their own gates (the plan,
 * a byrå membership) stay where they are.
 */
export const NON_PACKAGE_MODULES: readonly ModuleId[] = Object.freeze(['platform', 'agent', 'byra'])

/** Every package, in the order the design lists them. Frozen: read it, never mutate it. */
export const PACKAGES: readonly PackageDefinition[] = Object.freeze(
  DEFINITIONS.map((def) => Object.freeze({ ...def, modules: Object.freeze([...def.modules]) })),
)

const byId = new Map<string, PackageDefinition>(PACKAGES.map((p) => [p.id, p]))
const byModule = new Map<ModuleId, PackageId>(PACKAGES.flatMap((p) => p.modules.map((m) => [m, p.id] as const)))

export function getPackage(id: PackageId): PackageDefinition
export function getPackage(id: string): PackageDefinition | undefined
export function getPackage(id: string): PackageDefinition | undefined {
  return byId.get(id)
}

/** The package a module belongs to, or null for a NON_PACKAGE_MODULES module. */
export function packageForModule(moduleId: ModuleId): PackageId | null {
  return byModule.get(moduleId) ?? null
}

/**
 * The company_capability_config key that holds a company's choice for a
 * package: `package:<id>`. Absent means the profile decides; enabled = false
 * turns the package off. The prefix keeps package switches apart from the
 * capability keys (lib/entitlements/keys.ts) that share the table.
 */
export const PACKAGE_CONFIG_PREFIX = 'package:'

export function packageConfigKey(id: PackageId): string {
  return `${PACKAGE_CONFIG_PREFIX}${id}`
}

/** Every package's config key, for the one config read that loads the choices. */
export const PACKAGE_CONFIG_KEYS: readonly string[] = Object.freeze(PACKAGES.map((p) => packageConfigKey(p.id)))

/** The package a config key names, or null for any other key. */
export function packageForConfigKey(key: string): PackageId | null {
  if (!key.startsWith(PACKAGE_CONFIG_PREFIX)) return null
  return getPackage(key.slice(PACKAGE_CONFIG_PREFIX.length))?.id ?? null
}
