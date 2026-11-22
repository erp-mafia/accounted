import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { StandalonePage } from '@/components/standalone/StandalonePage'
import { FormationFlow } from '@/components/formation/FormationFlow'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import { shareholderAgreementEnabled } from '@/lib/formation/flags'
import { currentFormation, toView } from '@/lib/formation/store'
import { createClient, createServiceClient } from '@/lib/supabase/server'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('formation')
  return { title: t('meta_title') }
}

/**
 * /starta-bolag: start an aktiebolag. The interview, the free package, and
 * the setup once Bolagsverket has registered the company
 * (components/formation, lib/formation).
 */
export default async function StartaBolagPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user || user.is_anonymous) redirect('/login?next=/starta-bolag')

  const row = await currentFormation(createServiceClient(), user.id)
  return (
    <StandalonePage width="guide">
      <FormationFlow
        initial={row ? toView(row) : null}
        ticEnabled={ENABLED_EXTENSION_IDS.has('tic')}
        shareholderAgreement={shareholderAgreementEnabled()}
      />
    </StandalonePage>
  )
}
