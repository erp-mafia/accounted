'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { useLocale, useTranslations } from 'next-intl'
import { useCompany } from '@/contexts/CompanyContext'
import { AttnLine } from '@/components/ui/attn-line'
import { Button } from '@/components/ui/button'
import { getErrorMessage } from '@/lib/errors/get-error-message'

const ROOT = '/api/extensions/ext/arcim-migration/invoice-completion'
interface Block { consentId: string; blockId: string; reason: string }
async function readStatus(url: string): Promise<Block | null> {
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) throw new Error('Invoice completion status unavailable')
  return (await response.json()).data
}

export default function InvoiceCompletionRecovery({ onReconnect }: { onReconnect: (consentId: string) => void }) {
  const t = useTranslations('extensions')
  const locale = useLocale()
  const { company, role } = useCompany()
  const { data: block, error: statusError, mutate } = useSWR(company ? [ROOT, company.id] : null, ([url]) => readStatus(url), { refreshInterval: 15_000 })
  const [retrying, setRetrying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expiredConsent, setExpiredConsent] = useState<string | null>(null)
  const [queued, setQueued] = useState(false)
  const statusNotice = statusError ? <p className="text-sm text-muted-foreground" role="status">{t('ext_arcim_job_connection')}</p> : null
  if (!block) return statusNotice ?? (queued ? <p className="text-sm text-muted-foreground" role="status">{t('ext_arcim_completion_queued')}</p> : null)

  const reconnect = block.reason === 'PROVIDER_AUTH_EXPIRED' || expiredConsent === block.consentId
  async function retry() {
    if (!block || retrying) return
    setRetrying(true); setError(null)
    try {
      const response = await fetch(`${ROOT}/retry`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ consentId: block.consentId, blockId: block.blockId }) })
      const result = await response.json()
      if (!response.ok) {
        if (result.error?.code === 'PROVIDER_AUTH_EXPIRED') setExpiredConsent(block.consentId)
        if (response.status === 409) await mutate()
        throw result
      }
      setQueued(true)
      await mutate()
    } catch (failure) { setError(getErrorMessage(failure, { locale: locale === 'en' ? 'en' : 'sv' })) }
    finally { setRetrying(false) }
  }

  return <div className="space-y-2" aria-live="polite">
    <AttnLine>{t(reconnect ? 'ext_arcim_completion_reconnect_needed'
      : block.reason === 'PROVIDER_RESOURCE_FORBIDDEN' ? 'ext_arcim_completion_permission_needed' : 'ext_arcim_completion_license_needed')}
      {' '}<Button variant="link" className="h-auto p-0 text-xs text-inherit underline" disabled={retrying || role === 'viewer'}
        onClick={() => reconnect ? onReconnect(block.consentId) : void retry()}>
        {t(reconnect ? 'ext_arcim_job_reconnect' : 'ext_arcim_completion_retry')}
      </Button>
    </AttnLine>
    {statusNotice}
    {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
  </div>
}
