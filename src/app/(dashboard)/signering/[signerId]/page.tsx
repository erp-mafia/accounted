import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getDashboardAuthContext } from '../../request-context'
import { PageHeader } from '@/components/ui/page-header'
import { RouteLoadError } from '@/components/ui/route-load-error'
import { annualReportStepAnchor } from '@/components/bokslut/StepSectionHeader'
import { SigningPage } from '@/components/signing/SigningPage'
import { memberSignerBase } from '@/components/signing/signing-client'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { isUuid } from '@/lib/invariants/uuid'
import { createLogger } from '@/lib/logger'
import { describeForSigner, resolveMemberSigner } from '@/lib/signing/ceremony'

/**
 * /signering/[signerId]: a signing request addressed to the logged-in member,
 * signed here without the mailed link (re-minting a link would stop the
 * mailed one). The same page as /signera/[token], through the member door
 * (/api/signing/me/[signerId]). The signer row names its company, so this
 * works whichever company is active. Not under /signera: that path is the
 * public link's.
 */
export default async function MemberSigningPage({ params }: { params: Promise<{ signerId: string }> }) {
  const { signerId } = await params
  const { user } = await getDashboardAuthContext()
  if (!user || !isUuid(signerId)) notFound()
  const t = await getTranslations('signing_page')

  const service = createServiceClientNoCookies()
  const log = createLogger('signering-page').child({ signerId })
  const resolved = await resolveMemberSigner(service, signerId, user.id).catch((err) => {
    log.warn('member signer could not be resolved', err)
    return null
  })
  const message = (title: string, body: string) => (
    <div className="space-y-8">
      <PageHeader title={title} />
      <p className="text-[13px] text-muted-foreground">{body}</p>
    </div>
  )
  // A read that failed says so where the document would be, with "Försök igen".
  const loadFailed = (
    <div className="space-y-8">
      <PageHeader title={t('load_failed_title')} />
      <RouteLoadError title={t('load_failed_title')} description={t('load_failed_body')} />
    </div>
  )
  if (!resolved) return loadFailed
  if (!resolved.ok) {
    if (resolved.reason === 'not_signer') return message(t('member_not_signer_title'), t('member_not_signer_body'))
    notFound()
  }

  const initial = await describeForSigner({ service, request: resolved.request, signer: resolved.signer, log }).catch((error: unknown) => {
    log.error('member signing page describe failed', error instanceof Error ? error : new Error(String(error)))
    return null
  })
  if (!initial) return loadFailed

  // The board's årsredovisning: once signed, the årsstämma date is next, then
  // Digital inlämning (the fastställelseintyg is signed at Bolagsverket).
  let nextStep: { body: string; href: string; label: string } | null = null
  if (resolved.request.annual_report_version_id) {
    const { data: version } = await service
      .from('annual_report_versions')
      .select('fiscal_period_id')
      .eq('company_id', resolved.request.company_id)
      .eq('id', resolved.request.annual_report_version_id)
      .maybeSingle()
    const fiscalPeriodId = (version as { fiscal_period_id?: string } | null)?.fiscal_period_id
    if (fiscalPeriodId) {
      nextStep = {
        body: t('ar_next_body'),
        href: `/bookkeeping/year-end/arsredovisning?period=${fiscalPeriodId}#${annualReportStepAnchor('agm')}`,
        label: t('ar_next_link'),
      }
    }
  }

  return <SigningPage basePath={memberSignerBase(signerId)} initial={initial} variant="member" nextStep={nextStep} />
}
