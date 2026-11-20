import type { Metadata } from 'next'
import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { Button } from '@/components/ui/button'
import { StandaloneMessage } from '@/components/standalone/StandalonePage'
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
  const tAuth = await getTranslations('auth')
  const service = createServiceClientNoCookies()
  const resolved = await resolveAttestBatch(service, token).catch((error) => {
    // A failed read shows the same "no longer valid" page; the log keeps the cause (never the token).
    log.warn('attest batch link not resolved', { message: error instanceof Error ? error.message : String(error) })
    return null
  })

  // Unknown, expired and used read the same: the link no longer opens
  // anything, and the invoices can still be attested in the app.
  const gone = (
    <StandaloneMessage title={t('gone_title')} body={t('gone_body')}>
      <Button asChild size="lg" variant="outline">
        <Link href="/login">{tAuth('login_button')}</Link>
      </Button>
    </StandaloneMessage>
  )
  if (!resolved?.ok) return gone
  if (!(await attesterCanStillDecide(service, resolved.batch))) return gone

  const data = await describeAttestBatch(service, resolved.batch)
  return <AttestBatchPage token={token} initial={data} />
}
