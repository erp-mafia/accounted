import { AssistantSettingsContent } from '@/components/settings/sections/AssistantSettingsContent'
import { redirect } from 'next/navigation'
import { getDashboardCompanyId } from '../../request-context'
import { isAgentsPageEnabled } from '@/lib/agent-skills/flag'

export default async function AssistantSettingsPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const agentsEnabled = isAgentsPageEnabled(await getDashboardCompanyId())
  if ((await searchParams).view === 'skills' && agentsEnabled) redirect('/skills')
  return <AssistantSettingsContent agentsEnabled={agentsEnabled} />
}
