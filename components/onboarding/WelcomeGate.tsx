'use client'

import { useRouter } from 'next/navigation'
import NewUserChecklist from './NewUserChecklist'

interface Props {
  companyId: string
  hasBookkeepingImported: boolean
  hasBankConnected: boolean
  hasSkatteverketConnected: boolean
}

// Thin client wrapper around NewUserChecklist. Owns the "I'm starting
// fresh" handler — clicking it forwards the user straight to /onboarding/agent
// since the agent is the only remaining required step when bookkeeping is
// optional. The server page already gated on hasAgentBuilt before rendering
// us, so we don't pass that flag through to the checklist's redirect logic.
export default function WelcomeGate({
  companyId: _companyId,
  hasBookkeepingImported,
  hasBankConnected,
  hasSkatteverketConnected,
}: Props) {
  const router = useRouter()

  return (
    <NewUserChecklist
      hasBookkeepingImported={hasBookkeepingImported}
      hasBankConnected={hasBankConnected}
      hasSkatteverketConnected={hasSkatteverketConnected}
      hasAgentBuilt={false}
      onFreshStart={() => router.push('/onboarding/agent')}
    />
  )
}
