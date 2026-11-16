'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { StatusGlyph } from '@/components/ui/status-glyph'
import { cn } from '@/lib/utils'
import { getBranding } from '@/lib/branding/service'

interface RetentionNoticeProps {
  variant: 'company' | 'account'
  className?: string
}

/**
 * Shared BFL retention notice shown before destructive actions that
 * affect bookkeeping data. Keeps the legal copy consistent between the
 * account danger zone and the company danger zone.
 *
 * Swedish Bokföringslagen (BFL) 7 kap. 2§ requires räkenskapsinformation
 * to be retained for 7 years. Accounted is the system of record, so deleting
 * a company or an account does not remove the underlying data: it only
 * hides it from the UI and anonymizes PII where applicable.
 */
export function RetentionNotice({ variant, className }: RetentionNoticeProps) {
  const t = useTranslations('retention_notice')
  const { appName } = getBranding()
  const copy =
    variant === 'company'
      ? {
          title: t('company_title'),
          body: (
            <>
              {t('company_body_prefix', { appName: appName.toLowerCase() })}
              <Link
                href="/settings/backup"
                className="underline underline-offset-2 hover:text-foreground"
              >
                {t('company_body_link')}
              </Link>
              {t('company_body_suffix')}
            </>
          ),
        }
      : {
          title: t('account_title'),
          body: (
            <>
              {t('account_body_prefix')}
              <Link
                href="/settings/backup"
                className="underline underline-offset-2 hover:text-foreground"
              >
                {t('account_body_link')}
              </Link>
              {t('account_body_suffix')}
            </>
          ),
        }

  return (
    <div
      className={cn(
        // Stil v3: no box inside a dialog; the red glyph and the title carry it.
        'flex gap-2',
        className
      )}
    >
      <StatusGlyph tone="error" size={16} className="mt-0.5" />
      <div className="space-y-0.5 text-sm">
        <p className="font-medium text-destructive">{copy.title}</p>
        <p className="text-muted-foreground">{copy.body}</p>
      </div>
    </div>
  )
}
