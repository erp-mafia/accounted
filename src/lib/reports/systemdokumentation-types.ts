/**
 * Systemdokumentation (BFL 5 kap. 11 §, BFNAR 2013:2 kap. 9): the description
 * of how this company's bookkeeping is organised, generated from its actual
 * configuration for one räkenskapsår. Types live apart from the generator so
 * the report view does not pull the PDF renderer into the client bundle.
 */

import type { AccountingFramework, AccountingMethod, CompanyRole, EntityType, JournalEntrySourceType, MomsPeriod } from '@/types'

export interface SystemdokumentationAccount {
  account_number: string
  account_name: string
  account_class: number | null
  sru_code: string | null
}

export interface SystemdokumentationDelsystem {
  key: string
  label: string
  description: string
  kontering: string
  /** True when the company has the subsystem switched on or connected. */
  active: boolean
}

export interface SystemdokumentationSeriesRow {
  source_type: JournalEntrySourceType
  label: string
  series: string
  series_label: string
}

export interface SystemdokumentationRule {
  rubrik: string
  text: string
}

export interface SystemdokumentationMember {
  role: CompanyRole
  label: string
  joined_at: string
}

export interface SystemdokumentationApiKey {
  name: string
  key_prefix: string
  owner_label: string
  scopes: string[]
  created_at: string
  last_used_at: string | null
  unattended_commit_limit: number | null
}

export interface SystemdokumentationIntegration {
  key: string
  label: string
  description: string
  active: boolean
}

export interface SystemdokumentationReport {
  generated_at: string
  app_version: string | null
  system: {
    name: string
    url: string
    /** False on a self-hosted install (NEXT_PUBLIC_SELF_HOSTED). */
    hosted: boolean
  }
  company: {
    name: string | null
    org_number: string | null
    entity_type: EntityType | null
    accounting_method: AccountingMethod | null
    accounting_framework: AccountingFramework | null
    moms_period: MomsPeriod | null
    vat_registered: boolean
    pays_salaries: boolean
    fiscal_year_start_month: number | null
  }
  period: {
    id: string
    name: string
    start: string
    end: string
    is_closed: boolean
    locked_at: string | null
  }
  kontoplan: {
    standard: string
    accounts: SystemdokumentationAccount[]
    class_summary: { account_class: number; count: number }[]
    sie_import_regler: string
  }
  delsystem: SystemdokumentationDelsystem[]
  verifikationsserier: {
    per_source_type: SystemdokumentationSeriesRow[]
    cash_account_overrides: { account_name: string; ledger_account: string; series: string; series_label: string }[]
    /** Series with numbers assigned in this räkenskapsår. */
    sequences: { series: string; series_label: string; last_number: number }[]
    ordning: string[]
    undantag: string[]
  }
  behandlingsregler: SystemdokumentationRule[]
  rattelse_och_las: {
    lock_date: string | null
    auto_lock_period_days: number | null
    rules: string[]
  }
  behorigheter: {
    mfa_required: boolean
    members: SystemdokumentationMember[]
    api_keys: SystemdokumentationApiKey[]
  }
  integrationer: SystemdokumentationIntegration[]
  arkivering: {
    lagringsregel: string
    format: string
    integritetskontroll: string
    lagringsplats: string
    behandlingshistorik: string
  }
}
