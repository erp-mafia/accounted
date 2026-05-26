'use client'

import { useEffect, useState } from 'react'
import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import { HelpCircle } from 'lucide-react'
import { SettingsNav } from '@/components/settings/SettingsSidebar'
import { useCompany } from '@/contexts/CompanyContext'
import { createClient } from '@/lib/supabase/client'
import { useAgentSheet } from '@/components/agent/AgentSheetProvider'

const TAB_TO_ROUTE: Record<string, string> = {
  company: '/settings/company',
  invoicing: '/settings/invoicing',
  bookkeeping: '/settings/bookkeeping',
  tax: '/settings/tax',
  team: '/settings/team',
  banking: '/settings/banking',
  templates: '/settings/templates',
  'agent-memory': '/settings/assistant',
  assistant: '/settings/assistant',
  account: '/settings/account',
  api: '/settings/api',
}

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const { company } = useCompany()
  const [isSandbox, setIsSandbox] = useState(false)
  const { openAgentSheet, identity } = useAgentSheet()
  // Derive panel slug from pathname so settings.help knows which panel the
  // user is looking at. Falls back to null on /settings root.
  const panel = pathname?.match(/^\/settings\/([^/]+)/)?.[1] ?? null
  const agentName = identity.displayName?.trim() || 'assistenten'

  // Fetch sandbox status
  useEffect(() => {
    if (!company?.id) return
    const supabase = createClient()
    supabase
      .from('company_settings')
      .select('is_sandbox')
      .eq('company_id', company.id)
      .single()
      .then(({ data }) => {
        if (data?.is_sandbox) setIsSandbox(true)
      })
  }, [company?.id])

  // Handle legacy ?tab= URLs
  useEffect(() => {
    const tab = searchParams.get('tab')
    if (tab && TAB_TO_ROUTE[tab]) {
      router.replace(TAB_TO_ROUTE[tab])
    }
  }, [searchParams, router])

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl md:text-3xl font-medium tracking-tight">Inställningar</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Hantera ditt företag och konto
          </p>
        </div>
        <button
          type="button"
          onClick={() => openAgentSheet({
            intentId: 'settings.help',
            intentArgs: { panel },
            contextRef: panel ? `settings:${panel}` : 'settings',
          })}
          className="shrink-0 inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
          title={`Fråga ${agentName} om dessa inställningar`}
        >
          <HelpCircle className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Fråga {agentName}</span>
        </button>
      </div>

      <SettingsNav isSandbox={isSandbox} />

      <div>{children}</div>
    </div>
  )
}
