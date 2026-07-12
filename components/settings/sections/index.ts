import type { ComponentType } from 'react'
import { AccountSettingsContent } from './AccountSettingsContent'
import { CompanySettingsContent } from './CompanySettingsContent'
import { BookkeepingSettingsContent } from './BookkeepingSettingsContent'
import { TaxSettingsContent } from './TaxSettingsContent'
import { SalarySettingsContent } from './SalarySettingsContent'
import { InvoicingSettingsContent } from './InvoicingSettingsContent'
import { TemplatesSettingsContent } from './TemplatesSettingsContent'
import { PaymentsSettingsContent } from './PaymentsSettingsContent'
import { BankingSettingsContent } from './BankingSettingsContent'
import { AssistantSettingsContent } from './AssistantSettingsContent'
import { ApiSettingsContent } from './ApiSettingsContent'
import { BillingSettingsContent } from './BillingSettingsContent'

/**
 * Single source of truth mapping a settings section id to the component that
 * renders its content. Both the per-section route (`settings/<section>/page.tsx`,
 * a thin wrapper) and the routed settings modal (`SettingsModal` → `SettingsShell`)
 * resolve content through this map, so there is exactly one place a section's
 * composition lives.
 */
export const SETTINGS_SECTIONS: Record<string, ComponentType> = {
  account: AccountSettingsContent,
  company: CompanySettingsContent,
  bookkeeping: BookkeepingSettingsContent,
  tax: TaxSettingsContent,
  salary: SalarySettingsContent,
  invoicing: InvoicingSettingsContent,
  templates: TemplatesSettingsContent,
  payments: PaymentsSettingsContent,
  banking: BankingSettingsContent,
  assistant: AssistantSettingsContent,
  api: ApiSettingsContent,
  billing: BillingSettingsContent,
}

export type SettingsSectionId = keyof typeof SETTINGS_SECTIONS
