'use client'

import { useRouter } from 'next/navigation'
import NewUserChecklist from './NewUserChecklist'

interface Props {
  companyId: string
  hasBookkeepingImported: boolean
  hasBankConnected: boolean
  hasSkatteverketConnected: boolean
}

// Thin client wrapper around NewUserChecklist, shown only to a genuinely empty
// company (no data, no assistant). The data-import steps lead and building the
// assistant is the last step; the "I'm starting fresh" escape hatch forwards
// straight to /onboarding/agent for users with no books to bring in.
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
