'use client'

import { useTranslations } from 'next-intl'
import { InkText } from '@/components/onboarding/journey/ink'
import { Button } from '@/components/ui/button'
import { MailboxList } from '@/components/inkorg/AddMailboxDialog'
import { useCompany } from '@/contexts/CompanyContext'
import { usesPersonnummerAsOrgNumber } from '@/lib/company/entity-type'
import { isLegalPersonOrgNumber } from '@/lib/invariants/org-number'
import type { MailboxDoor } from '@/lib/inkorg/mailboxes'
import type { BooksCtx } from '../context'

/** The ways in that connect without leaving the page: WhatsApp and Gmail open other pages and stay out. */
const DOCS_DOORS: readonly MailboxDoor[] = ['intake_email', 'kivra', 'billo']
/** For a company neither mailbox provider can serve: the address alone. */
const ADDRESS_ONLY: readonly MailboxDoor[] = ['intake_email']

/** Underlagen: where receipts and invoices arrive, the mailbox rows inline. */
export function DocsStep({ ctx }: { ctx: BooksCtx }) {
  const t = useTranslations('books')
  const { company } = useCompany()
  // Kivra and Billo have a company mailbox only for a legal person's number
  // (lib/digital-mailboxes/connect.ts refuses the rest), so a sole trader, or
  // a company with no number yet, is shown the address and not two buttons
  // that can only refuse.
  const companyMailboxes = isLegalPersonOrgNumber(company?.org_number)
  // Where the company is the person, the question says "dina", as the company questions do.
  const personOwned = company ? usesPersonnummerAsOrgNumber(company.entity_type) : false
  return (
    <div className="jny-qstep">
      <h1 className="jny-qtitle">
        <InkText text={t(personOwned ? 'docs_title_owner' : 'docs_title')} />
      </h1>
      <p className="agent-lead">{t(companyMailboxes ? 'docs_sub' : 'docs_sub_address')}</p>
      <div className="docs-list">
        <MailboxList doors={companyMailboxes ? DOCS_DOORS : ADDRESS_ONLY} receiveOnly connectVariant="outline" connectLabel={t('docs_connect')} />
      </div>
      <div className="jny-qactions">
        <Button size="lg" onClick={() => ctx.dispatch({ type: 'AFTER_DOCS', flags: ctx.flags })}>{t('continue')}</Button>
      </div>
    </div>
  )
}
