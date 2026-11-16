'use client'

import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { useCompanyOptional } from '@/contexts/CompanyContext'
import { formatOrgNumberDisplay } from '@/lib/invariants/org-number'
import { GMAIL_ACCESS_EMAIL, gmailAccessMailto } from './mail-connections'

/**
 * Gmail is closed for this company: one button that opens the person's own
 * mail program with the request to us already written. It goes to Accounted
 * on every host, a byrå's branded one included (GMAIL_ACCESS_EMAIL).
 */
export function RequestGmailAccessButton({ variant = 'default' }: { variant?: 'default' | 'outline' }) {
  const t = useTranslations('mail')
  const company = useCompanyOptional()?.company ?? null
  const name = company?.name ?? ''
  const named = company?.org_number ? `${name} (${formatOrgNumberDisplay(company.org_number)})` : name
  const href = gmailAccessMailto(
    GMAIL_ACCESS_EMAIL,
    t('request_access_subject', { company: name }),
    t('request_access_body', { company: named }),
  )
  return (
    <Button asChild variant={variant}>
      <a href={href}>{t('request_access_action')}</a>
    </Button>
  )
}
