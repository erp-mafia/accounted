/**
 * Module manifest: the single declaration of Accounted's building blocks.
 *
 * A module is a named slice of the product that the API, the agents and
 * (later) a company's own module choice can address as a unit. Everything
 * that needs to know "which module is this?" resolves from this list
 * (./resolve.ts): the operation registry (by operation id prefix), the v1
 * REST surface and its OpenAPI tags (by path), and the boundary ratchet
 * (by src/lib folder), and the per-company capabilities (./capabilities.ts),
 * which group the modules into packages (./packages.ts). The menu and MCP's
 * tools/list read those capabilities to hide a package a company does not
 * have, and the start doors of a package that is switched off refuse
 * (./package-doors.ts); a company without a profile or a switch has every
 * package on, so nothing it sees or calls has changed.
 *
 * Two kinds:
 *   - kernel: always present. The ledger and the platform it runs on. A
 *     kernel never imports a block (the ratchet in
 *     __tests__/boundary.test.ts counts the edges that exist today and fails
 *     when one is added).
 *   - block: optional by design. A block may import the kernel, shared
 *     infrastructure (INFRA_LIB_FOLDERS) and the blocks it names in
 *     `dependsOn`, nothing else.
 *
 * Ids are published (OpenAPI tags and `x-module`), marked `x-experimental`
 * until the per-company module switch settles the boundaries; until then a
 * module may still be split or renamed. After that: add modules, never rename
 * one. `jurisdictions` stays internal until a second country exists. See
 * README.md in this folder.
 */
import type { CapabilityKey } from '@/lib/entitlements/keys'

export const MODULE_IDS = [
  'platform',
  'ledger',
  'transactions',
  'bank-feed',
  'invoicing',
  'supplier-invoices',
  'payments',
  'payroll',
  'expenses',
  'vat',
  'assets',
  'year-end',
  'inbox',
  'collections',
  'pos',
  'webshop',
  'skatteverket',
  'deadlines',
  'import',
  'parties',
  'agent',
  'byra',
] as const

export type ModuleId = (typeof MODULE_IDS)[number]

export type ModuleKind = 'kernel' | 'block'

export interface ModuleDefinition {
  /** Kebab-case, stable, public (OpenAPI tag name and `x-module`). */
  readonly id: ModuleId
  readonly kind: ModuleKind
  /** English display name. */
  readonly name: string
  /** Swedish product name. */
  readonly nameSv: string
  /** One English sentence for the API docs (the OpenAPI tag description). */
  readonly summary: string
  /**
   * The other modules this one needs present and may import. The kernel is
   * implicit for a block (every block may import it); a kernel lists only
   * kernels, never a block.
   */
  readonly dependsOn: readonly ModuleId[]
  /**
   * Folders under src/lib this module owns. A path with a slash claims a
   * subfolder of a folder another module owns (`bokslut/assets`); the
   * longest claim wins.
   */
  readonly libFolders: readonly string[]
  /** Operation id prefixes (the part before the first dot) this module owns. */
  readonly operationPrefixes: readonly string[]
  /**
   * v1 path claims: the first segment after `/api/v1/companies/{companyId}/`
   * (or after `/api/v1/` for a route outside a company). A longer claim with
   * `:param` placeholders carves a sub-path out of another module's segment
   * (`fiscal-periods/:id/arsredovisning`); the longest claim wins.
   */
  readonly v1Segments: readonly string[]
  /** The paid capability (lib/entitlements/keys.ts) that gates the module, where one clearly does. */
  readonly capability?: CapabilityKey
  /** ISO 3166-1 alpha-2 codes whose law the module encodes; empty when country-neutral. */
  readonly jurisdictions: readonly string[]
}

const SE = ['SE'] as const

const DEFINITIONS: readonly ModuleDefinition[] = [
  {
    id: 'platform',
    kind: 'kernel',
    name: 'Platform',
    nameSv: 'Plattform',
    summary:
      'Identity, API keys, service accounts, company discovery and creation, async operation polling, staged operations and their approval, webhooks and health: what every other module runs on.',
    dependsOn: [],
    libFolders: ['auth', 'webhooks', 'service-accounts'],
    // packages: a company's package switches and their status (lib/operations/packages.ts).
    operationPrefixes: ['packages'],
    // capabilities: the per-company module report (lib/modules/capabilities.ts).
    v1Segments: [
      'health',
      'api-key',
      'companies',
      'capabilities',
      'packages',
      'operations',
      'pending-operations',
      'webhooks',
      'webhook-deliveries',
      'service-accounts',
    ],
    jurisdictions: [],
  },
  {
    id: 'ledger',
    kind: 'kernel',
    name: 'Ledger',
    nameSv: 'Bokföring',
    summary:
      'Double-entry bookkeeping under Bokföringslagen: journal entries and corrections, the chart of accounts, fiscal periods and locks, opening balances, dimensions, the bank and cash account register, the document archive, company settings and the statutory reports read from the ledger.',
    dependsOn: ['platform'],
    libFolders: [
      'bookkeeping',
      // The purchase-category list (what was bought) and its proposal: the
      // jurisdiction-neutral category key every booking carries, read by the
      // inbox, the ledger's analysis and later the posting port.
      'categories',
      'core',
      'company',
      'invariants',
      'reports',
      'export',
      'dimensions',
      'documents',
      // Arrivals: how every document, bank page and file entered the books,
      // with the original kept (BFL 7 kap). Written by the blocks' doors,
      // read with the archive, so it sits beside documents.
      'intake',
      'processing-history',
      // The decision log behind each booking proposal (suggestion_log): part of
      // the company's bookkeeping (privacy policy section 5) and read by the
      // behandlingshistorik, so it sits with the ledger, not with one block.
      'suggestion-log',
      // Why each link to a verifikat exists (link basis): stamped by every
      // block that links records to the books and read with the voucher, so
      // it sits with the ledger beside the decision log.
      'links',
      // The bank and cash account register (BAS 19xx plus verifikationsserie)
      // exists without any bank feed and is read by the engine itself and by
      // five blocks.
      'cash-accounts',
      // Giro number formats and the Luhn checksum: lib/invariants builds on them.
      'bankgiro',
      // The booking template catalogue (packs/*.yaml) behind bookkeeping templates.
      'packs',
      // Defined measures: figures read off the statutory reports and their
      // registers, each equal to its report (lib/measures).
      'measures',
      // The posting port (Phase 2): every posting's business event and the
      // ledger adapter in front of the engine. Kernel, beside the engine it
      // fronts; blocks post through it.
      'posting',
    ],
    operationPrefixes: [
      'journal-entries',
      'accounts',
      'fiscal-periods',
      'opening-balances',
      'audit-trail',
      'reports',
      'dimensions',
      'dimension-rules',
      'documents',
      'settings',
      'cash-accounts',
      'measures',
      // The unexplained queue (lib/unexplained, infrastructure): expected-zero
      // checks over the ledger and the blocks that feed it, read-only.
      'unexplained',
    ],
    v1Segments: [
      'journal-entries',
      'voucher-gap-explanations',
      'accounts',
      'fiscal-periods',
      'audit-trail',
      'reports',
      'dimensions',
      'documents',
      'settings',
      'compliance',
      'cash-accounts',
      'measures',
      'unexplained',
    ],
    jurisdictions: SE,
  },
  {
    id: 'transactions',
    kind: 'block',
    name: 'Bank transactions',
    nameSv: 'Banktransaktioner',
    summary:
      'Bank transactions and their booking: categorization rules, suggestions, matching against invoices and bank reconciliation.',
    dependsOn: [],
    libFolders: ['transactions', 'rules', 'reconciliation'],
    operationPrefixes: ['transactions'],
    v1Segments: ['transactions', 'reconciliation'],
    jurisdictions: SE,
  },
  {
    id: 'bank-feed',
    kind: 'block',
    name: 'Bank feed',
    nameSv: 'Bankkoppling',
    summary:
      'Reading the company bank through PSD2 aggregators and Open Payments, and the sync that turns it into transactions.',
    dependsOn: ['transactions'],
    libFolders: ['bank-feed', 'bank-sync', 'feed-sync'],
    operationPrefixes: ['bank-feed'],
    v1Segments: ['bank-feed', 'bank-connections'],
    capability: 'bank_sync',
    jurisdictions: SE,
  },
  {
    id: 'invoicing',
    kind: 'block',
    name: 'Invoicing',
    nameSv: 'Fakturering',
    summary:
      'Customer invoices from draft to paid or credited, quotes and sales orders, the customer and article registers, and Peppol e-invoicing.',
    dependsOn: [],
    libFolders: ['invoices', 'customers', 'articles', 'sales-orders'],
    operationPrefixes: ['invoices', 'peppol'],
    v1Segments: ['invoices', 'customers', 'articles', 'peppol'],
    jurisdictions: SE,
  },
  {
    id: 'supplier-invoices',
    kind: 'block',
    name: 'Supplier invoices',
    nameSv: 'Leverantörsfakturor',
    summary:
      'Accounts payable: the supplier register and received supplier invoices with attest, booking, crediting and payment marking.',
    dependsOn: [],
    libFolders: ['supplier-invoices', 'suppliers'],
    operationPrefixes: ['supplier-invoices', 'suppliers'],
    v1Segments: ['supplier-invoices', 'suppliers'],
    jurisdictions: SE,
  },
  {
    id: 'payments',
    kind: 'block',
    name: 'Payments',
    nameSv: 'Betalningar',
    summary:
      'Paying suppliers: payment files, bank payment orders signed with BankID, signing links, payee verification and Bankgiro lookups.',
    dependsOn: ['supplier-invoices', 'bank-feed'],
    libFolders: ['payments'],
    operationPrefixes: [
      'payments',
      'payment-orders',
      'supplier-payment-batches',
      'supplier-payees',
      'payment-signing-links',
    ],
    v1Segments: ['payment-orders', 'payments', 'supplier-payment-batches'],
    jurisdictions: SE,
  },
  {
    id: 'payroll',
    kind: 'block',
    name: 'Payroll',
    nameSv: 'Lön',
    summary:
      'Swedish payroll: the employee register, salary runs from calculation to booking, payslips, payment files and the arbetsgivardeklaration (AGI).',
    dependsOn: [],
    libFolders: ['salary'],
    operationPrefixes: ['salary-runs', 'employees', 'agi-filings'],
    v1Segments: ['employees', 'salary-runs', 'salary'],
    jurisdictions: SE,
  },
  {
    id: 'expenses',
    kind: 'block',
    name: 'Expenses',
    nameSv: 'Utlägg',
    summary: 'Expense claims (utlägg) and mileage allowances, paid out directly or through a salary run.',
    // expense_claims.employee_id references employees: a claim belongs to an employee.
    dependsOn: ['payroll'],
    libFolders: ['expenses', 'mileage'],
    operationPrefixes: ['expense-claims'],
    v1Segments: ['expense-claims'],
    jurisdictions: SE,
  },
  {
    id: 'vat',
    kind: 'block',
    name: 'VAT',
    nameSv: 'Moms',
    summary: 'VAT treatments and declaration boxes, VAT settlement booking and the record of filed VAT periods.',
    // A VAT period's due date comes from the deadline calendar (tax/deadline-config).
    dependsOn: ['deadlines'],
    libFolders: ['vat'],
    operationPrefixes: ['vat', 'vat-filings', 'vat-check-reviews'],
    v1Segments: ['vat'],
    jurisdictions: SE,
  },
  {
    id: 'assets',
    kind: 'block',
    name: 'Fixed assets',
    nameSv: 'Anläggningstillgångar',
    summary:
      'The fixed asset register (anläggningsregister): acquisition, depreciation schedules, tax depreciation and disposal.',
    dependsOn: [],
    libFolders: ['bokslut/assets'],
    operationPrefixes: [],
    v1Segments: ['assets'],
    jurisdictions: SE,
  },
  {
    id: 'year-end',
    kind: 'block',
    name: 'Year-end and annual report',
    nameSv: 'Bokslut och årsredovisning',
    summary:
      'The bokslut workspace (accruals, reserves, tax provision, readiness) and the årsredovisning with its signatures and iXBRL.',
    dependsOn: ['assets'],
    libFolders: ['bokslut'],
    operationPrefixes: ['arsredovisning'],
    v1Segments: ['fiscal-periods/:id/arsredovisning'],
    jurisdictions: SE,
  },
  {
    id: 'inbox',
    kind: 'block',
    name: 'Inbox and archive',
    nameSv: 'Inkorg och arkiv',
    summary:
      'Incoming documents: the inbox, reading and extracting documents, the document graph archive, mail search and the receipt hunt that finds missing underlag.',
    dependsOn: [],
    libFolders: [
      'arkiv',
      // The new Inkorg page's rollout flag and its pure view logic (views,
      // doors, queue order, the focus view's decision and keyboard map, the
      // field panel's labels, formatting and correction payloads).
      'inkorg',
      'mail-search',
      'receipt-hunt',
      // Document reading, classification and extraction: one cycle with arkiv.
      'documents/classify',
      'documents/extract',
      'documents/jobs',
      'documents/read',
      'documents/inbox-extraction',
      // The one reading of an inbox item: assembled from the inbox's readings,
      // its Peppol reader passed in by the caller.
      'documents/reading',
      // Match on arrival: the bank row an arriving underlag looks already paid
      // by, decided with the supplier-invoice and giro rules the caller passes in.
      'documents/bank-match',
    ],
    operationPrefixes: ['inbox-items'],
    v1Segments: ['inbox-items'],
    jurisdictions: SE,
  },
  {
    id: 'collections',
    kind: 'block',
    name: 'Collections',
    nameSv: 'Inkasso',
    summary: 'Reminders, debt collection and invoice delivery through a provider the company activates itself.',
    dependsOn: ['invoicing'],
    libFolders: ['collections'],
    operationPrefixes: ['collections'],
    v1Segments: [],
    capability: 'collections',
    jurisdictions: SE,
  },
  {
    id: 'pos',
    kind: 'block',
    name: 'Point of sale',
    nameSv: 'Kassasystem',
    summary: 'Business days from a connected point-of-sale system, booked as daily takings vouchers.',
    dependsOn: [],
    libFolders: ['pos-sales'],
    operationPrefixes: ['pos-sales'],
    v1Segments: ['pos-sales'],
    jurisdictions: SE,
  },
  {
    id: 'webshop',
    kind: 'block',
    name: 'Webshop orders',
    nameSv: 'Webbshopsordrar',
    summary: 'Orders and refunds from connected webshops, imported as a feed and booked.',
    dependsOn: [],
    libFolders: ['webshop-orders'],
    operationPrefixes: [],
    v1Segments: [],
    jurisdictions: SE,
  },
  {
    id: 'skatteverket',
    kind: 'block',
    name: 'Skatteverket',
    nameSv: 'Skatteverket',
    summary:
      'Filing with and reading from Skatteverket over its API: VAT and AGI submission and the skattekonto.',
    dependsOn: [],
    libFolders: ['skatteverket'],
    operationPrefixes: ['skatteverket', 'skattekonto'],
    v1Segments: ['skatteverket', 'skattekonto'],
    capability: 'skatteverket',
    jurisdictions: SE,
  },
  {
    id: 'deadlines',
    kind: 'block',
    name: 'Deadlines',
    nameSv: 'Viktiga datum',
    summary:
      'The tax and filing deadline calendar generated from the company tax settings, with Swedish holidays and status tracking.',
    dependsOn: [],
    libFolders: ['tax', 'deadlines'],
    operationPrefixes: [],
    v1Segments: [],
    jurisdictions: SE,
  },
  {
    id: 'import',
    kind: 'block',
    name: 'Import and migration',
    nameSv: 'Import och flytt',
    summary:
      'Bringing books in: SIE and bank file import, migration from other accounting systems, and onboarding of existing books.',
    dependsOn: [],
    libFolders: ['import', 'providers', 'onboarding-books'],
    operationPrefixes: ['imports'],
    v1Segments: ['imports'],
    jurisdictions: SE,
  },
  {
    id: 'parties',
    kind: 'block',
    name: 'Parties',
    nameSv: 'Motparter',
    summary: 'Counterparties observed in the books and the company register lookups that identify them.',
    dependsOn: [],
    // vendor-logos: each counterpart's own icon, fetched once per domain from its website.
    libFolders: ['parties', 'company-lookup', 'vendor-logos'],
    operationPrefixes: [],
    v1Segments: [],
    jurisdictions: SE,
  },
  {
    id: 'agent',
    kind: 'block',
    name: 'AI agent',
    nameSv: 'AI-assistent',
    summary: 'The in-product AI assistant: chat, categorization reads, the ledger context it reasons over and its skills.',
    dependsOn: [],
    libFolders: ['agent', 'agent-context', 'agent-panel', 'agent-skills', 'ai-handoff'],
    operationPrefixes: [],
    v1Segments: [],
    capability: 'ai',
    jurisdictions: SE,
  },
  {
    id: 'byra',
    kind: 'block',
    name: 'Accounting firm',
    nameSv: 'Byrå',
    summary: 'Tools for accounting firms working across client companies: the client portfolio and cross-company reads.',
    dependsOn: [],
    libFolders: ['byra', 'clients', 'portfolio'],
    operationPrefixes: [],
    v1Segments: ['portfolio'],
    jurisdictions: [],
  },
]

/**
 * Folders under src/lib that belong to no module: shared infrastructure every
 * module may import, and composition layers (operations, pending operations,
 * the worklist, onboarding) that sit above the modules and wire them
 * together. Their imports are not ratcheted by module pair. `composition`
 * holds the seams a kernel imports to reach blocks (the ledger's reversal
 * hooks); who may import it and what it may import is pinned by
 * compositionSeams in __tests__/boundary.test.ts. Files directly in src/lib
 * (logger.ts, money.ts, init.ts, ...) count as infrastructure too.
 */
export const INFRA_LIB_FOLDERS: readonly string[] = Object.freeze([
  'ai',
  'analytics',
  'api',
  'branding',
  'browser',
  'calendar',
  'composition',
  'connect',
  'crypto',
  'currency',
  'dashboard',
  'dates',
  'docs',
  'domains',
  'email',
  'entitlements',
  'env',
  'errors',
  'events',
  'extensions',
  // Company rules for automatic booking (grants): policy over staged
  // operations, a composition layer beside pending-operations and
  // suggestions, for any key credential (not the in-app assistant's module).
  'grants',
  'handles',
  'hooks',
  'http',
  'lists',
  'modules',
  'navigation',
  'notices',
  'notifications',
  'observability',
  'onboarding',
  'onboarding-journey',
  'operations',
  'pdf',
  'pending-operations',
  'rate-limits',
  'reference-data',
  'sandbox',
  'security',
  'settings',
  'stripe',
  'suggestions',
  'supabase',
  'support',
  'theme',
  'ui-state',
  'vendor-marks',
  // The unexplained queue: expected-zero checks that read across the ledger
  // and the blocks (reconciliation, VAT filings, bank rows), like the worklist.
  'unexplained',
  'worklist',
  'xml',
])

function freezeModule(def: ModuleDefinition): ModuleDefinition {
  return Object.freeze({
    ...def,
    dependsOn: Object.freeze([...def.dependsOn]),
    libFolders: Object.freeze([...def.libFolders]),
    operationPrefixes: Object.freeze([...def.operationPrefixes]),
    v1Segments: Object.freeze([...def.v1Segments]),
    jurisdictions: Object.freeze([...def.jurisdictions]),
  })
}

/** Every module, kernels first. Frozen: read it, never mutate it. */
export const MODULES: readonly ModuleDefinition[] = Object.freeze(DEFINITIONS.map(freezeModule))
