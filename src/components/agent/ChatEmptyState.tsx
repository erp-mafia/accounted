'use client'

import { SparklesIcon } from '@/components/icons'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { useAgentSheet } from './AgentSheetProvider'
import AgentAvatar from './AgentAvatar'
import ChatNewStarter from './ChatNewStarter'
import { useCompanyOptional, useCapability } from '@/contexts/CompanyContext'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { CHAT_INTENT_ID } from '@/lib/agent/ask/persist'
import { signOutAndNavigate } from '@/lib/auth/session-client'

// Client component for the /chat start state. With the assistant available it
// is the new-conversation view itself: the text box is on the page, with the
// suggested questions above it, so a question can be typed (or picked) without
// first clicking through to /chat/new. The first answer swaps the URL to
// /chat/[id], exactly as /chat/new does. The sandbox and no-plan states keep
// their own explanation and have no text box, since nothing could be sent.
export default function ChatEmptyState() {
  const { identity } = useAgentSheet()
  const companyCtx = useCompanyOptional()
  const isSandbox = companyCtx?.isSandbox ?? false
  const hasAi = useCapability(CAPABILITY.ai)
  const name = identity.displayName?.trim() || 'din assistent'

  if (isSandbox) {
    const handleCreateAccount = async () => {
      // Sign-out is best-effort: navigate even if the server is unreachable
      // so the button never looks dead.
      await signOutAndNavigate('/register')
    }
    return (
      <div className="hidden md:flex flex-1 flex-col items-center justify-center px-6 py-12 text-center">
        <AgentAvatar avatarId={identity.avatarId} size="lg" alt={name} className="mb-5" />
        <h1 className="font-display text-2xl tracking-tight mb-2">Fråga {name}</h1>
        <div className="rounded-lg border border-border bg-secondary/40 px-5 py-4 max-w-md mb-6 text-left">
          <div className="flex items-center gap-2 text-sm font-medium">
            <SparklesIcon className="h-4 w-4" />
            Avstängd i sandlådan
          </div>
          <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
            AI-assistenten använder en betald molntjänst och är därför
            inaktiverad här. I den fullständiga produkten kan {name} kategorisera
            transaktioner, granska leverantörsfakturor och svara på frågor om
            din bokföring.
          </p>
        </div>
        <Button size="lg" onClick={handleCreateAccount}>
          Skapa konto för att använda {name}
        </Button>
      </div>
    )
  }

  if (!hasAi) {
    return (
      <div className="hidden md:flex flex-1 flex-col items-center justify-center px-6 py-12 text-center">
        <AgentAvatar avatarId={identity.avatarId} size="lg" alt={name} className="mb-5" />
        <h1 className="font-display text-2xl tracking-tight mb-2">Fråga {name}</h1>
        <div className="rounded-lg border border-border bg-secondary/40 px-5 py-4 max-w-md mb-6 text-left">
          <div className="flex items-center gap-2 text-sm font-medium">
            <SparklesIcon className="h-4 w-4" />
            Ingår i abonnemanget
          </div>
          <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
            AI-assistenten använder en betald molntjänst. Uppgradera för att låta
            {' '}{name} kategorisera transaktioner, granska leverantörsfakturor
            och svara på frågor om din bokföring.
          </p>
        </div>
        <Button size="lg" asChild>
          <Link href="/settings/billing">Uppgradera för att använda {name}</Link>
        </Button>
      </div>
    )
  }

  // Hidden on mobile: the sidebar IS the page when no conversation is open.
  // On desktop the right pane is a fresh conversation, ready to type in.
  return (
    <div className="hidden md:flex flex-1 min-h-0 flex-col">
      <ChatNewStarter intentId={CHAT_INTENT_ID} autoFocusComposer />
    </div>
  )
}
