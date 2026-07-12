'use client'

import { ArrowUpRight, Sparkles } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { useAgentSheet } from './AgentSheetProvider'
import AgentAvatar from './AgentAvatar'
import { useCompanyOptional, useCapability } from '@/contexts/CompanyContext'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { createClient } from '@/lib/supabase/client'

// Tiny client component for /chat empty state. Reads the agent identity from
// the provider so it can show the user's chosen avatar + name above the
// "starta en konversation" CTA.
//
// The three suggestion chips below the headline give users a one-click way
// in. They navigate to /chat/new?intent=…&prompt=… which mounts AgentChat
// inline and swaps to /chat/[id] once the conversation is created: so the
// flow stays full-screen instead of opening a slide-in sheet.
const SUGGESTIONS: { label: string; prompt: string }[] = [
  {
    label: 'Vad är min största utgiftspost den här månaden?',
    prompt: 'Vad är min största utgiftspost den här månaden? Visa de fem största kategorierna.',
  },
  {
    label: 'Hur ser min momsrapport ut för senaste perioden?',
    prompt: 'Hur ser min momsrapport ut för den senaste perioden? Vad blir moms att betala eller få tillbaka, och ser något ovanligt ut?',
  },
  {
    label: 'När är min nästa skatte- eller momsdeadline?',
    prompt: 'När är min nästa skatte- eller momsdeadline, och vad behöver jag göra inför den?',
  },
]

export default function ChatEmptyState() {
  const { identity } = useAgentSheet()
  const companyCtx = useCompanyOptional()
  const router = useRouter()
  const isSandbox = companyCtx?.isSandbox ?? false
  const hasAi = useCapability(CAPABILITY.ai)
  const name = identity.displayName?.trim() || 'din assistent'

  if (isSandbox) {
    const handleCreateAccount = async () => {
      const supabase = createClient()
      // Sign-out is best-effort: navigate even if Supabase is unreachable
      // so the button never looks dead.
      try {
        await supabase.auth.signOut()
      } catch {
        // Intentionally swallowed.
      }
      router.push('/register')
    }
    return (
      <div className="hidden md:flex flex-1 flex-col items-center justify-center px-6 py-12 text-center">
        <AgentAvatar avatarId={identity.avatarId} size="lg" alt={name} className="mb-5" />
        <h1 className="font-display text-2xl tracking-tight mb-2">Fråga {name}</h1>
        <div className="rounded-lg border border-border bg-secondary/40 px-5 py-4 max-w-md mb-6 text-left">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Sparkles className="h-4 w-4" />
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
            <Sparkles className="h-4 w-4" />
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
  // On desktop, fills the right pane with a centered prompt.
  return (
    <div className="hidden md:flex flex-1 flex-col items-center justify-center px-6 py-12 text-center">
      <AgentAvatar avatarId={identity.avatarId} size="lg" alt={name} className="mb-5" />
      <h1 className="font-display text-2xl tracking-tight mb-2">Fråga {name}</h1>
      <p className="text-muted-foreground max-w-md mb-6">
        Välj en konversation till vänster, eller starta en ny om något har dykt upp.
      </p>

      <div className="flex flex-col gap-2 w-full max-w-md mb-6">
        {SUGGESTIONS.map((s) => (
          <Link
            key={s.label}
            href={`/chat/new?intent=general.help&prompt=${encodeURIComponent(s.prompt)}`}
            className="group flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-left text-sm transition-colors hover:border-foreground/30 hover:bg-secondary/30"
          >
            <span className="flex-1 text-muted-foreground group-hover:text-foreground transition-colors">
              {s.label}
            </span>
            <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60 group-hover:text-foreground transition-colors" />
          </Link>
        ))}
      </div>

      <Button size="lg" variant="outline" asChild>
        <Link href="/chat/new?intent=general.help">Eller skriv din egen fråga</Link>
      </Button>
    </div>
  )
}
