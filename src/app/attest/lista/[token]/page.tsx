import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { AttestBatchPage } from '@/components/supplier-invoices/AttestBatchPage'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createLogger } from '@/lib/logger'
import { resolveAttestBatch } from '@/lib/supplier-invoices/attest-batches'
import { describeAttestBatch } from '@/lib/supplier-invoices/attest-batch-route'
import { attesterCanStillDecide } from '@/lib/supplier-invoices/attest-link-route'

// The token is the authentication: no session, no company context. The page
// is never indexed, like the single invoice's attest page under /attest/<token>.
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('attest_batch_page')
  return { title: t('meta_title'), robots: { index: false, follow: false } }
}

export const dynamic = 'force-dynamic'

const log = createLogger('attest-batch-page')

export default async function AttestBatchRoute({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const t = await getTranslations('attest_batch_page')
  const service = createServiceClientNoCookies()
  const resolved = await resolveAttestBatch(service, token).catch((error) => {
    // A failed read shows the same "no longer valid" page; the log keeps the cause (never the token).
    log.warn('attest batch link not resolved', { message: error instanceof Error ? error.message : String(error) })
    return null
  })

  // Unknown, expired and used read the same: the link no longer opens
  // anything, and the invoices can still be attested in the app.
  const gone = (
    <main className="min-h-dvh bg-background flex items-center justify-center px-4 md:px-6">
      <div className="max-w-md w-full rounded-lg border border-border p-6 space-y-2">
        <h1 className="font-display text-2xl tracking-tight">{t('gone_title')}</h1>
        <p className="text-[13px] text-muted-foreground">{t('gone_body')}</p>
      </div>
    </main>
  )
  if (!resolved?.ok) return gone
  if (!(await attesterCanStillDecide(service, resolved.batch))) return gone

  const data = await describeAttestBatch(service, resolved.batch)
  return <AttestBatchPage token={token} initial={data} />
}
