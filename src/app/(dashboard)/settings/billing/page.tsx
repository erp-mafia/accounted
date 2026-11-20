import { BillingSettingsContent } from '@/components/settings/sections/BillingSettingsContent'
import { UPGRADE_REASON_PARAM, parseUpgradeReason } from '@/lib/entitlements/upgrade-reason'

export const metadata = { title: 'Abonnemang' }

// ?from=<reason> is set by a gated section that sent the person here (the
// assistant without the plan that carries it). Matched against a fixed list;
// anything else is a normal visit and shows no line.
export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const reason = parseUpgradeReason((await searchParams)[UPGRADE_REASON_PARAM])
  return <BillingSettingsContent reason={reason} />
}
