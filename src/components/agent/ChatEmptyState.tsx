'use client'

import { ArrowUpRight, Sparkles } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
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
export default function ChatEmptyState() {
  const t = useTranslations('chat_empty_state')
  const { identity } = useAgentSheet()
  const companyCtx = useCompanyOptional()
  const router = useRouter()
  const isSandbox = companyCtx?.isSandbox ?? false
  const hasAi = useCapability(CAPABILITY.ai)
  const name = identity.displayName?.trim() || t('default_name')
  const suggestions: { label: string; prompt: string }[] = [
    { label: t('suggestion_expenses_label'), prompt: t('suggestion_expenses_prompt') },
    { label: t('suggestion_vat_label'), prompt: t('suggestion_vat_prompt') },
    { label: t('suggestion_deadline_label'), prompt: t('suggestion_deadline_prompt') },
  ]

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
        <h1 className="font-display text-2xl tracking-tight mb-2">{t('ask_name', { name })}</h1>
        <div className="rounded-lg border border-border bg-secondary/40 px-5 py-4 max-w-md mb-6 text-left">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Sparkles className="h-4 w-4" />
            {t('sandbox_disabled_title')}
          </div>
          <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
            {t('sandbox_disabled_body', { name })}
          </p>
        </div>
        <Button size="lg" onClick={handleCreateAccount}>
          {t('create_account_to_use', { name })}
        </Button>
      </div>
    )
  }

  if (!hasAi) {
    return (
      <div className="hidden md:flex flex-1 flex-col items-center justify-center px-6 py-12 text-center">
        <AgentAvatar avatarId={identity.avatarId} size="lg" alt={name} className="mb-5" />
        <h1 className="font-display text-2xl tracking-tight mb-2">{t('ask_name', { name })}</h1>
        <div className="rounded-lg border border-border bg-secondary/40 px-5 py-4 max-w-md mb-6 text-left">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Sparkles className="h-4 w-4" />
            {t('included_in_plan_title')}
          </div>
          <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
            {t('included_in_plan_body', { name })}
          </p>
        </div>
        <Button size="lg" asChild>
          <Link href="/settings/billing">{t('upgrade_to_use', { name })}</Link>
        </Button>
      </div>
    )
  }

  // Hidden on mobile: the sidebar IS the page when no conversation is open.
  // On desktop, fills the right pane with a centered prompt.
  return (
    <div className="hidden md:flex flex-1 flex-col items-center justify-center px-6 py-12 text-center">
      <AgentAvatar avatarId={identity.avatarId} size="lg" alt={name} className="mb-5" />
      <h1 className="font-display text-2xl tracking-tight mb-2">{t('ask_name', { name })}</h1>
      <p className="text-muted-foreground max-w-md mb-6">
        {t('pick_conversation')}
      </p>

      <div className="flex flex-col gap-2 w-full max-w-md mb-6">
        {suggestions.map((s) => (
          <Link
            key={s.label}
            href={`/chat/new?intent=general.help&prompt=${encodeURIComponent(s.prompt)}`}
            className="group flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-left text-sm transition-colors hover:border-foreground/30 hover:bg-secondary/60"
          >
            <span className="flex-1 text-muted-foreground group-hover:text-foreground transition-colors">
              {s.label}
            </span>
            <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60 group-hover:text-foreground transition-colors" />
          </Link>
        ))}
      </div>

      <Button size="lg" variant="outline" asChild>
        <Link href="/chat/new?intent=general.help">{t('write_own_question')}</Link>
      </Button>
    </div>
  )
}
