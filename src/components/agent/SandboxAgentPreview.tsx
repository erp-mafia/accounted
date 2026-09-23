'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Sparkles, ArrowRight } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'

/**
 * Stand-in for AgentChat in the sandbox. The real chat surface POSTs to
 * /api/agent/invoke which is server-gated by guardSandbox(), so the input
 * would just produce a 403. Instead of showing that as a raw error, we
 * render a brief description of what the assistant does in prod and a
 * single "Skapa konto" CTA. Same chrome (header) as the real chat: only
 * the body swaps out.
 *
 * Mirrors the look of the empty-state but with an explanation block so the
 * sandbox user understands what they're seeing without typing into a
 * dead-end input.
 */
export default function SandboxAgentPreview({
  agentName,
}: {
  agentName: string | null
}) {
  const router = useRouter()
  const name = agentName?.trim() || 'din assistent'

  async function handleCreateAccount() {
    const supabase = createClient()
    // Sign-out is best-effort: a transient Supabase failure shouldn't
    // strand the user on a dead button; navigate to /register either way
    // and let the registration flow re-init auth state.
    try {
      await supabase.auth.signOut()
    } catch {
      // Intentionally swallowed: see comment above.
    }
    router.push('/register')
  }

  return (
    <div className="flex-1 flex flex-col">
      <div className="flex-1 overflow-y-auto px-5 py-8">
        <div className="mx-auto max-w-md space-y-6">
          <div className="rounded-lg border border-border bg-secondary/40 p-5">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Sparkles className="h-4 w-4" />
              Förhandsvisning i sandlådan
            </div>
            <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
              {name} är en specialiserad bokföringsassistent som kan
              kategorisera transaktioner, granska leverantörsfakturor och
              svara på frågor om din bokföring: kalibrerad mot dina
              kontoplaner, verksamhet och svensk skattelagstiftning.
            </p>
            <p className="text-sm text-muted-foreground mt-3 leading-relaxed">
              I sandlådan är AI-funktionerna avstängda eftersom de använder
              externa AI-tjänster som kostar pengar att köra. Skapa ett
              konto för att aktivera assistenten på riktigt.
            </p>
          </div>

          <ul className="space-y-2 text-sm text-muted-foreground">
            <li className="flex items-start gap-2">
              <span className="text-foreground mt-0.5">·</span>
              <span>
                <span className="text-foreground">Föreslår bokföring</span>{' '}
                för oklassificerade transaktioner: du godkänner i ett klick.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-foreground mt-0.5">·</span>
              <span>
                <span className="text-foreground">Förklarar momsrutor</span>,
                årets resultat och vad som driver KPI:erna.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-foreground mt-0.5">·</span>
              <span>
                <span className="text-foreground">Granskar verifikat</span>{' '}
                och föreslår rättningar enligt BFL och K2.
              </span>
            </li>
          </ul>
        </div>
      </div>

      <div className="border-t border-border px-5 pt-4 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)]">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            className="flex-1"
            onClick={handleCreateAccount}
          >
            Skapa konto för att använda {name}
            <ArrowRight className="ml-1.5 h-4 w-4" />
          </Button>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Sandlådedata raderas efter 24 timmar.{' '}
          <Link href="/register" className="underline underline-offset-2 hover:text-foreground">
            Skapa konto
          </Link>
          .
        </p>
      </div>
    </div>
  )
}
