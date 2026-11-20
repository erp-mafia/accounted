'use client'

import { useEffect } from 'react'
import { SupportAskTrigger } from '@/components/support/SupportAskTrigger'
import { SupportLink } from '@/components/ui/support-link'
import { useCompanyOptional } from '@/contexts/CompanyContext'
import { closeSupportDock, mountSupportDock, openSupportDock, useSupportDock } from '@/lib/support/dock'

/**
 * The support, docked in the bottom right corner of the app: a panel beside
 * the page, not a dialog over it.
 *
 * The AI assistant often answers with where to go. In a dialog that answer
 * was gone the moment the user went there: the dialog covers the page, and a
 * link in the answer closed it. Docked, the answer is read while the user
 * clicks through the app, and the panel is still there on the next page,
 * since the layout that holds it does not change between them.
 *
 * Every door to the assistant on the page opens this one panel
 * (lib/support/dock.ts), and the floating button in the corner is one of
 * them: for everyone, until a person hides it (`pillHidden`, their own
 * choice for this button, brought back under Inställningar > Ditt konto).
 *
 * Mounted by the dashboard layout for a company with the support assistant
 * and without the built-in chat: the chat's own button and sheet hold the
 * same corner while a company still has them.
 */
export function SupportDock({ pillHidden = false }: { pillHidden?: boolean }) {
  const dock = useSupportDock()
  const companyId = useCompanyOptional()?.company?.id

  useEffect(() => mountSupportDock(), [])

  return (
    <>
      <SupportAskTrigger hidden={pillHidden} open={dock.open} onOpen={() => openSupportDock()} />
      {dock.open && (
        <SupportLink
          // A conversation never follows the user into another company.
          key={companyId}
          variant="hidden"
          presentation="panel"
          subject={dock.subject}
          open
          onOpenChange={(next) => {
            if (!next) closeSupportDock()
          }}
        />
      )}
    </>
  )
}
