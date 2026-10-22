import { readCompanyDataChoices } from '@/lib/legal/data-choices-store'
import { DataSharingSettingsContent } from '@/components/settings/sections/DataSharingSettingsContent'
import { getDashboardAuthContext, getDashboardCompanyId } from '../../request-context'

/**
 * AI och kopplingar → Datadelning och AI: the company's AI switch and what it
 * lets us do with its data (lib/legal/data-choices.ts). Read on the server so
 * the switches render in their real state; a failed read renders the retry
 * state rather than a guess.
 */
export default async function DataSharingSettingsPage() {
  const [{ supabase }, companyId] = await Promise.all([getDashboardAuthContext(), getDashboardCompanyId()])
  const choices = companyId ? await readCompanyDataChoices(supabase, companyId).catch(() => null) : null
  return <DataSharingSettingsContent initialChoices={choices} />
}
