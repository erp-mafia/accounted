import { AssistantSettingsContent } from '@/components/settings/sections/AssistantSettingsContent'
import { redirect } from 'next/navigation'

export default async function AssistantSettingsPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  if ((await searchParams).view === 'skills') redirect('/skills')
  return <AssistantSettingsContent />
}
