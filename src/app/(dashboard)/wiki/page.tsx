import { Suspense } from 'react'
import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@/components/ui/page-header'
import { HelpPopover } from '@/components/ui/help-popover'
import { WikiViews } from '@/components/wiki/WikiViews'
import { isArkivBrainEnabled } from '@/lib/arkiv/flag'
import { isAgentPictureEnabled } from '@/lib/env/agent-picture-switch'
import { wikiPlace } from '@/lib/agent-context/wiki-views'
import { getDashboardCompanyId } from '../request-context'

/**
 * Wiki: everything an agent receives about the company, landing on the
 * context view (what the briefing holds, part by part), with the map,
 * facts, memory and skills one segment away. Replaces "Vad din agent vet".
 *
 * Fakta (what Arkiv has read out of the company's documents) exists only
 * inside the Arkiv rollout. Outside it nothing reads the documents, so the
 * view is not offered.
 *
 * For a company in AGENT_PICTURE_COMPANY_IDS the context view is the agent
 * picture, and its help says what the picture is. A `view` that names a row
 * of the picture (wikiPlace) shows the picture with that row open, under the
 * picture's own title. The switch is read here, on the server: the browser
 * gets a boolean.
 */
export default async function WikiPage({ searchParams }: { searchParams: Promise<{ view?: string | string[] }> }) {
  const t = await getTranslations('wiki')
  const companyId = await getDashboardCompanyId()
  const facts = !!companyId && isArkivBrainEnabled(companyId)
  const picture = isAgentPictureEnabled(companyId)
  // The top bar names the view, as the menu does: Kontext and Minne are rows
  // of Agenter, Karta a row of Företaget (nav-v3.ts), all views of this page.
  const raw = (await searchParams).view
  const place = wikiPlace({ view: Array.isArray(raw) ? raw[0] : raw }, { picture, facts })
  const view = place.show === 'view' ? place.view : 'context'
  return (
    <>
      <PageHeader title={t(`view_${view}`)} help={<HelpPopover>{place.show === 'picture' ? t('picture.help') : t('help')}</HelpPopover>} />
      <Suspense>
        <WikiViews facts={facts} picture={picture} />
      </Suspense>
    </>
  )
}
