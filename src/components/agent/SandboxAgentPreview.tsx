'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
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
  const t = useTranslations('sandbox_agent_preview')
  const router = useRouter()
  const name = agentName?.trim() || t('default_name')

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
              {t('title')}
            </div>
            <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
              {t('intro', { name })}
            </p>
            <p className="text-sm text-muted-foreground mt-3 leading-relaxed">
              {t('disabled_reason')}
            </p>
          </div>

          <ul className="space-y-2 text-sm text-muted-foreground">
            <li className="flex items-start gap-2">
              <span className="text-foreground mt-0.5">·</span>
              <span>
                {t.rich('feature_suggests', {
                  em: (c) => <span className="text-foreground">{c}</span>,
                })}
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-foreground mt-0.5">·</span>
              <span>
                {t.rich('feature_explains', {
                  em: (c) => <span className="text-foreground">{c}</span>,
                })}
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-foreground mt-0.5">·</span>
              <span>
                {t.rich('feature_reviews', {
                  em: (c) => <span className="text-foreground">{c}</span>,
                })}
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
            {t('create_account_to_use', { name })}
            <ArrowRight className="ml-1.5 h-4 w-4" />
          </Button>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          {t('data_deleted_after')}{' '}
          <Link href="/register" className="underline underline-offset-2 hover:text-foreground">
            {t('create_account')}
          </Link>
          .
        </p>
      </div>
    </div>
  )
}
