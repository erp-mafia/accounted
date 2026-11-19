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
 * (lib/support/dock.ts). `pill` adds the floating button that opens it, for
 * a person who had the built-in assistant's button in this corner.
 *
 * Mounted by the dashboard layout for a company with the support assistant
 * and without the built-in chat: the chat's own button and sheet hold the
 * same corner while a company still has them.
 */
export function SupportDock({ pill, pillHidden = false }: { pill: boolean; pillHidden?: boolean }) {
  const dock = useSupportDock()
  const companyId = useCompanyOptional()?.company?.id

  useEffect(() => mountSupportDock(), [])

  return (
    <>
      {pill && <SupportAskTrigger hidden={pillHidden} open={dock.open} onOpen={() => openSupportDock()} />}
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
