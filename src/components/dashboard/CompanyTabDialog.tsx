'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useCompany } from '@/contexts/CompanyContext'
import { performCompanySwitch } from '@/lib/company/switch-client'
import { Button } from '@/components/ui/button'
import { resolveObservedCompanyName } from '@/lib/company/tab-guard'

/**
 * The blocking dialog of the cross-tab guard (CompanyTabSync raises it): this
 * tab shows one company, the session has another active. Its two buttons are
 * the only exits: switch back to this tab's company, or load the new one.
 * Loaded when it is first raised, not with the page.
 */
export default function CompanyTabDialog({
  currentCompanyId,
  observedCompanyId,
}: {
  /** The company this tab renders. */
  currentCompanyId: string
  /** The company the session has active now, when known: the dialog names it. */
  observedCompanyId: string | null
}) {
  const { company, companies, foreignCompanies } = useCompany()
  const t = useTranslations('company_tab_guard')
  const [resolving, setResolving] = useState(false)

  const newCompanyName = resolveObservedCompanyName(
    observedCompanyId,
    companies,
    foreignCompanies ?? [],
  )

  const handleSwitchBack = async () => {
    setResolving(true)
    // Re-activate THIS tab's company and reload the page we are on (same
    // company, so its data is still valid). Other tabs get the broadcast and
    // face the same dialog: the hazard is symmetric by design.
    const result = await performCompanySwitch(currentCompanyId, {
      destination: window.location.pathname + window.location.search,
    })
    if (result?.error) {
      // Membership lost or persist failure: this tab cannot win the company
      // back, so the only safe exit left is loading the new company.
      window.location.assign('/')
    }
  }

  const handleReloadAsNew = () => {
    setResolving(true)
    // Land on the start page: the current path may not exist (or worse, mean
    // another object) under the new company.
    window.location.assign('/')
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="company-tab-guard-title"
    >
      {/* Veil: deliberately no click-to-close and no Esc: the dialog is
          blocking, its two buttons are the only exits (WL-09). */}
      <div className="absolute inset-0 bg-background/80 backdrop-blur-sm" aria-hidden="true" />
      <div className="relative w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-[var(--shadow-lg)]">
        <h2 id="company-tab-guard-title" className="text-lg leading-6">
          {t('title')}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {newCompanyName
            ? t('body_named', { company: company?.name ?? '', newCompany: newCompanyName })
            : t('body', { company: company?.name ?? '' })}
        </p>
        {/* Both labels carry a company name of any length: let the row wrap and
            each label break, or two long names push the buttons out of the card. */}
        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
          <Button
            variant="outline"
            className="max-w-full whitespace-normal"
            disabled={resolving}
            onClick={handleReloadAsNew}
          >
            {newCompanyName
              ? t('reload_as_named', { newCompany: newCompanyName })
              : t('reload_as_new')}
          </Button>
          <Button
            className="max-w-full whitespace-normal"
            disabled={resolving}
            onClick={() => void handleSwitchBack()}
          >
            {t('switch_back', { company: company?.name ?? '' })}
          </Button>
        </div>
      </div>
    </div>
  )
}
