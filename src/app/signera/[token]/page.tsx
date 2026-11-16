import { StandaloneMessage } from '@/components/standalone/StandalonePage'
import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { SigningPage } from '@/components/signing/SigningPage'
import { signerTokenBase } from '@/components/signing/signing-client'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createLogger } from '@/lib/logger'
import { describeForSigner, resolveSignerByToken } from '@/lib/signing/ceremony'

// The token is the authentication: no session, no company context. Signers
// are often outside the company and have no account, so the page is never
// indexed and speaks plain language, as the payment signing page under
// /betala does.
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('signing_page')
  return { title: t('meta_title'), robots: { index: false, follow: false } }
}

export const dynamic = 'force-dynamic'

function MessageShell({ title, body }: { title: string; body: string }) {
  return <StandaloneMessage title={title} body={body} />
}

export default async function SigneraPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const t = await getTranslations('signing_page')
  const service = createServiceClientNoCookies()
  // Never log the token: the logger gets the signer id once it resolved.
  const resolved = await resolveSignerByToken(service, token).catch(() => 'error' as const)
  if (resolved === 'error') return <MessageShell title={t('load_failed_title')} body={t('load_failed_body')} />

  // A malformed, unknown or replaced link (a reminder mints a new one) and an
  // archived company read the same: the link no longer opens anything, and
  // whoever sent it can send a new one. A closed request still opens, on its
  // end state, so a signer can see what happened.
  if (!resolved.ok) return <MessageShell title={t('invalid_title')} body={t('invalid_body')} />

  const log = createLogger('signera-page').child({ companyId: resolved.request.company_id, signingRequestId: resolved.request.id, signerId: resolved.signer.id })
  const initial = await describeForSigner({ service, request: resolved.request, signer: resolved.signer, log }).catch((error: unknown) => {
    log.error('signing page describe failed', error instanceof Error ? error : new Error(String(error)))
    return null
  })
  if (!initial) return <MessageShell title={t('load_failed_title')} body={t('load_failed_body')} />

  return <SigningPage basePath={signerTokenBase(token)} initial={initial} variant="public" />
}
