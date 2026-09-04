import type { ComponentType } from 'react'
import dynamic from 'next/dynamic'
import { SettingsLoadingSkeleton } from '../SettingsLoadingSkeleton'

const AccountSettingsContent = dynamic(() =>
  import('./AccountSettingsContent').then((module) => ({ default: module.AccountSettingsContent })),
  { loading: SettingsLoadingSkeleton },
)
const CompanySettingsContent = dynamic(() =>
  import('./CompanySettingsContent').then((module) => ({ default: module.CompanySettingsContent })),
  { loading: SettingsLoadingSkeleton },
)
const BookkeepingSettingsContent = dynamic(() =>
  import('./BookkeepingSettingsContent').then((module) => ({ default: module.BookkeepingSettingsContent })),
  { loading: SettingsLoadingSkeleton },
)
const TaxSettingsContent = dynamic(() =>
  import('./TaxSettingsContent').then((module) => ({ default: module.TaxSettingsContent })),
  { loading: SettingsLoadingSkeleton },
)
const SalarySettingsContent = dynamic(() =>
  import('./SalarySettingsContent').then((module) => ({ default: module.SalarySettingsContent })),
  { loading: SettingsLoadingSkeleton },
)
const InvoicingSettingsContent = dynamic(() =>
  import('./InvoicingSettingsContent').then((module) => ({ default: module.InvoicingSettingsContent })),
  { loading: SettingsLoadingSkeleton },
)
const TemplatesSettingsContent = dynamic(() =>
  import('./TemplatesSettingsContent').then((module) => ({ default: module.TemplatesSettingsContent })),
  { loading: SettingsLoadingSkeleton },
)
const BankingSettingsContent = dynamic(() =>
  import('./BankingSettingsContent').then((module) => ({ default: module.BankingSettingsContent })),
  { loading: SettingsLoadingSkeleton },
)
const AssistantSettingsContent = dynamic(() =>
  import('./AssistantSettingsContent').then((module) => ({ default: module.AssistantSettingsContent })),
  { loading: SettingsLoadingSkeleton },
)
const ApiSettingsContent = dynamic(() =>
  import('./ApiSettingsContent').then((module) => ({ default: module.ApiSettingsContent })),
  { loading: SettingsLoadingSkeleton },
)
const BillingSettingsContent = dynamic(() =>
  import('./BillingSettingsContent').then((module) => ({ default: module.BillingSettingsContent })),
  { loading: SettingsLoadingSkeleton },
)
const TeamSettingsContent = dynamic(() =>
  import('../TeamPanel').then((module) => ({ default: module.TeamPanel })),
  { loading: SettingsLoadingSkeleton },
)
const BrandSettingsContent = dynamic(() =>
  import('./BrandSettingsContent').then((module) => ({ default: module.BrandSettingsContent })),
  { loading: SettingsLoadingSkeleton },
)
const WhatsAppSettingsContent = dynamic(() =>
  import('./WhatsAppSettingsContent').then((module) => ({ default: module.WhatsAppSettingsContent })),
  { loading: SettingsLoadingSkeleton },
)
const MailSettingsContent = dynamic(() =>
  import('./MailSettingsContent').then((module) => ({ default: module.MailSettingsContent })),
  { loading: SettingsLoadingSkeleton },
)

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
  banking: BankingSettingsContent,
  assistant: AssistantSettingsContent,
  api: ApiSettingsContent,
  billing: BillingSettingsContent,
  team: TeamSettingsContent,
  brand: BrandSettingsContent,
  whatsapp: WhatsAppSettingsContent,
  mail: MailSettingsContent,
}
