'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { ArrowUpRight, Loader2, Briefcase } from 'lucide-react'
import { performCompanySwitch } from '@/lib/company/switch-client'
import { useToast } from '@/components/ui/use-toast'

/**
 * The home-domain signpost (WL-01): shown instead of the dashboard when the
 * active company is homed on another domain. Never a silent redirect:
 * sessions are per domain, so the user must log in again over there, and the
 * signpost explains why. Companies homed HERE are offered as one-click
 * switches; companies homed elsewhere link to their home domain.
 */
export default function HomeDomainSignpost({
  activeCompanyName,
  homedCompanies,
  foreignCompanies,
}: {
  activeCompanyName: string
  homedCompanies: Array<{ id: string; name: string }>
  foreignCompanies: Array<{ id: string; name: string; domain: string }>
}) {
  const t = useTranslations('signpost')
  const { toast } = useToast()
  const [pendingId, setPendingId] = useState<string | null>(null)

  const handleSwitch = async (companyId: string) => {
    setPendingId(companyId)
    const result = await performCompanySwitch(companyId, { destination: '/' })
    if (result?.error) {
      setPendingId(null)
      toast({ title: t('switch_failed'), variant: 'destructive' })
    }
  }

  return (
    <div className="stagger-enter mx-auto max-w-lg pt-12">
      <div className="flex flex-col items-center text-center">
        <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-xl bg-muted/60">
          <Briefcase className="h-5 w-5 text-muted-foreground" />
        </div>
        <h1 className="font-display text-2xl leading-8 tracking-tight">
          {t('title')}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground text-balance">
          {t('body', { company: activeCompanyName })}
        </p>
      </div>

      {foreignCompanies.length > 0 && (
        <div className="mt-8">
          <ul className="divide-y divide-border border-y border-border">
            {foreignCompanies.map((entry) => (
              <li key={entry.id}>
                <a
                  href={`https://${entry.domain}`}
                  className="group flex items-center gap-3 px-1 py-3 transition-colors duration-150 hover:bg-secondary/35"
                >
                  <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                    {t('managed_via', { company: entry.name, domain: entry.domain })}
                  </span>
                  <ArrowUpRight className="h-4 w-4 flex-shrink-0 text-muted-foreground group-hover:text-foreground" />
                </a>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">{t('login_hint')}</p>
        </div>
      )}

      {homedCompanies.length > 0 && (
        <div className="mt-10">
          <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
            {t('homed_here')}
          </h2>
          <ul className="mt-2 divide-y divide-border border-y border-border">
            {homedCompanies.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  onClick={() => void handleSwitch(entry.id)}
                  disabled={pendingId !== null}
                  className="flex w-full items-center gap-3 px-1 py-3 text-left transition-colors duration-150 hover:bg-secondary/35 disabled:opacity-50"
                >
                  <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                    {entry.name}
                  </span>
                  {pendingId === entry.id ? (
                    <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin text-muted-foreground" />
                  ) : (
                    <span className="text-xs text-muted-foreground">{t('open_company')}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
