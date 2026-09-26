import type { RegistrySkillId } from './registry'
import type { Area } from './areas'

export { AREAS, type Area } from './areas'

/**
 * Agenter: each curated skill is an agent built from four separate parts.
 *
 *  - Instruktioner: the workflow body (lib/agent-skills/workflows), how to do the job.
 *  - Kunskap: the reviewed swedish-* rule packs in agent_atom_registry. `knowledge`
 *    ids are inlined when the agent starts; `references` are listed by id and
 *    loaded on demand, so the law is in context before the first number is read.
 *  - Företaget: what we know about this company. Industry and modifier atoms come
 *    from agent_profiles; `facts` names the company facts (lib/arkiv/facts/
 *    predicates.ts) that change what this agent does, inlined when it starts;
 *    `agreements` adds the running agreements. Everything else stays one lookup
 *    away (search_records, ask_document): eager for what acts, lazy for what informs.
 *    `areas` routes the company's industry and company-form sections: those
 *    tagged with any of the agent's areas are inlined when it starts (areas.ts).
 *  - Kopplingar: where the agent acts. `bank`, `skatteverket` and `peppol` are
 *    Accounted connections the page can check; `mail` and `browser` live in the
 *    customer's own AI client (Gmail connector, Claude in Chrome) and are only named.
 *
 * Each workflow is named for its job (Kvittoagent, Momsagent). Its picture is a
 * folder in its colour (components/skills/Folder.tsx); its page stands it on a
 * plain ground with faint strata (components/skills/StrataField.tsx).
 *
 * Browser-safe: the Agenter page imports this file. Every id must resolve to an
 * agent-audience atom (pinned by __tests__/agents.test.ts).
 */
export type AgentConnection = 'bank' | 'skatteverket' | 'peppol' | 'mail' | 'browser'

export interface AgentDefinition {
  knowledge: readonly string[]
  references: readonly string[]
  connections: readonly AgentConnection[]
  facts: readonly string[]
  agreements: boolean
  /** Areas of work this flow does: the company's pack sections tagged with any of them are inlined. */
  areas: readonly Area[]
}

const COMPLIANCE = 'horizontal/swedish-accounting-compliance'
const VAT = 'horizontal/swedish-vat'
const INVOICE = 'horizontal/swedish-invoice-compliance'
const YEAR_END = 'horizontal/swedish-year-end-closing'

/**
 * Community sharing (share, upvote, community items and authors): the page,
 * the knowledge picker and the share route all read this one switch. Shared
 * items are reviewed by Accounted and published through the public MIT repo
 * erp-mafia/accounted-skills (community-repo.ts, community-sync.ts).
 *
 * Closed for the Instruktioner launch (founder, 2026-09-26): "Dra tillbaka"
 * is one-way today (the author loses the item while a published copy stays
 * public). It reopens once withdrawing returns the item to private and the
 * reviewer can finish a withdrawal. Withdrawing an earlier submission still works.
 */
export const COMMUNITY_OPEN = false

/** What a company's own agent carries until the company changes it: the accounting law every flow stands on. */
export const OWN_AGENT_KNOWLEDGE: readonly string[] = [COMPLIANCE]

export const AGENTS: Record<RegistrySkillId, AgentDefinition> = {
  bookkeep: {
    knowledge: [COMPLIANCE, VAT],
    references: [`${COMPLIANCE}/bas-kontoplan`, `${VAT}/vat-compliance-reference`, 'horizontal/swedish-asset-accounting/accounts-and-registry'],
    connections: ['bank', 'mail'],
    facts: ['accounting_method', 'vat_registered', 'vat_method', 'business_description', 'sni_codes', 'top_counterparty', 'monthly_cost_baseline'],
    agreements: true,
    areas: ['lopande'],
  },
  kvittojakten: {
    knowledge: [COMPLIANCE, INVOICE],
    references: [`${COMPLIANCE}/bfl-bfnar`, `${INVOICE}/invoice-rules`],
    connections: ['mail', 'browser'],
    facts: ['business_description', 'top_counterparty'],
    agreements: false,
    areas: ['lopande'],
  },
  'reconcile-month': {
    knowledge: [COMPLIANCE],
    references: [`${COMPLIANCE}/bas-kontoplan`, `${COMPLIANCE}/skatteverket`],
    connections: ['bank', 'skatteverket'],
    facts: ['bank_connection', 'loan_balance', 'monthly_cost_baseline'],
    agreements: true,
    areas: ['lopande'],
  },
  'month-end-close': {
    knowledge: [COMPLIANCE, VAT],
    references: [`${COMPLIANCE}/bfl-bfnar`, `${VAT}/vat-compliance-reference`],
    connections: ['bank', 'skatteverket'],
    facts: ['accounting_method', 'vat_period', 'vat_method', 'fiscal_year', 'bank_connection', 'monthly_cost_baseline'],
    agreements: true,
    areas: ['lopande', 'moms'],
  },
  'quarterly-vat-review': {
    knowledge: [VAT, COMPLIANCE],
    references: [`${VAT}/vat-compliance-reference`, `${COMPLIANCE}/skatteverket`],
    connections: ['skatteverket'],
    facts: ['vat_registered', 'vat_period', 'vat_method', 'accounting_method', 'f_skatt', 'sni_codes'],
    agreements: false,
    areas: ['moms'],
  },
  'payroll-monthly': {
    knowledge: ['horizontal/swedish-payroll'],
    references: ['agi-filing', 'tax-tables', 'social-charges', 'vacation-pay', 'sick-pay', 'benefits', 'bas-7xxx'].map((r) => `horizontal/swedish-payroll/${r}`),
    connections: ['skatteverket', 'bank'],
    facts: ['employer_registered', 'employee_count', 'employee_range_registry', 'monthly_salary_cost', 'beneficial_owners'],
    agreements: false,
    areas: ['lon'],
  },
  'invoicing-rules': {
    knowledge: [INVOICE, VAT],
    references: [`${INVOICE}/invoice-rules`, 'horizontal/swedish-e-invoicing/swedish-cius-and-specifics', 'horizontal/swedish-e-invoicing/consumer-and-b2c'],
    // Invoices go out by e-mail from Accounted; Peppol is optional, so the agent does not wait on it.
    connections: [],
    facts: ['legal_name', 'org_number', 'registered_office', 'f_skatt', 'vat_registered', 'sni_codes'],
    agreements: false,
    areas: ['fakturering'],
  },
  'kreditfaktura-process': {
    knowledge: [INVOICE, VAT],
    references: [`${INVOICE}/invoice-rules`],
    connections: [],
    facts: ['vat_registered', 'accounting_method'],
    agreements: false,
    areas: ['fakturering'],
  },
  'year-end-close': {
    knowledge: [YEAR_END, 'horizontal/swedish-asset-accounting', 'horizontal/swedish-financial-reporting'],
    references: [
      `${YEAR_END}/closing-process`, `${YEAR_END}/journal-entries`, `${YEAR_END}/k2-vs-k3`, `${YEAR_END}/tax-calculations`,
      'horizontal/swedish-asset-accounting/depreciation', 'horizontal/swedish-financial-reporting/ink2-form-logic', 'horizontal/swedish-sru-filing/sru-codes',
    ],
    connections: ['skatteverket'],
    facts: ['fiscal_year', 'accounting_method', 'share_capital', 'share_count', 'board', 'signatories_rule', 'auditor', 'loan_balance', 'revenue_12m', 'employee_range_registry'],
    agreements: true,
    areas: ['bokslut'],
  },
  'tax-planning': {
    knowledge: ['horizontal/swedish-tax-planning', YEAR_END],
    references: ['312-regler', 'periodiseringsfond', 'overavskrivningar', 'strategy-and-interactions'].map((r) => `horizontal/swedish-tax-planning/${r}`)
      .concat('horizontal/swedish-payroll/social-charges'),
    connections: [],
    facts: ['fiscal_year', 'share_capital', 'share_count', 'beneficial_owners', 'board', 'revenue_12m', 'monthly_salary_cost', 'loan_balance'],
    agreements: true,
    areas: ['bokslut'],
  },
}

/** Connections Accounted can check; `mail` and `browser` sit in the AI client. */
export const CHECKABLE_CONNECTIONS = ['bank', 'skatteverket', 'peppol'] as const
export type CheckableConnection = (typeof CHECKABLE_CONNECTIONS)[number]

export function isCheckable(connection: AgentConnection): connection is CheckableConnection {
  return (CHECKABLE_CONNECTIONS as readonly string[]).includes(connection)
}

/** Where the user fixes a missing Accounted connection. */
export const CONNECTION_SETTINGS: Record<CheckableConnection, string> = {
  bank: '/settings/banking',
  skatteverket: '/settings/tax',
  peppol: '/settings/invoicing',
}

/** Whether a string names a curated agent. */
export function isAgentId(value: string): value is RegistrySkillId {
  return value in AGENTS
}

/** `agent:<id>` for get_task. */
export function agentTaskKind(id: RegistrySkillId): string {
  return `agent:${id}`
}
