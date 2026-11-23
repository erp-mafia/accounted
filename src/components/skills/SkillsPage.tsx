'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { SpinnerIcon } from '@/components/icons'
import useSWR from 'swr'
import { useCompany } from '@/contexts/CompanyContext'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { useBranding } from '@/lib/branding/brand-context'
import { AI_CLIENTS, aiConnectAction, aiPrefilledChatLink, openAiConnector, pickConnectedAiClient, type AiClient, type AiConnection } from '@/lib/onboarding/ai-clients'
import { createAiStatusPoller, type AiStatusPoller } from '@/lib/onboarding/ai-status-poll'
import { PageHeader } from '@/components/ui/page-header'
import { HelpPopover } from '@/components/ui/help-popover'
import { Button } from '@/components/ui/button'
import { AttnLine } from '@/components/ui/attn-line'
import { LoadError } from '@/components/ui/empty-state'
import { ConnectGate } from './ConnectGate'
import { Catalog, CatalogCreateMenu } from './Catalog'
import { KindsIntro } from './KindsIntro'
import type { ItemKind } from './hues'
import { trackInstructions } from './track'
import { ConnectHero } from './ConnectHero'
import { fetchConnections, isOwnItem, readAgents, readCatalog, readOptions, readUsage, simulatedClient, simulatedConnection } from './data'
import styles from './skills.module.css'


type PageState = 'loading' | 'locked' | 'waiting' | 'open'

/**
 * Agentinstruktioner: what the company gives the AI it brings (flows,
 * knowledge, analyses), from Accounted, the community or the company itself,
 * as a catalogue (Catalog.tsx). This component owns the AI connection and the
 * connect gate. `hrefBase` lets the sandbox demo link to its own pages.
 *
 * `knowledgeOnly`: the page is the knowledge kind alone, under that name:
 * no kinds to switch between, no Egna | Upptäck, no first-visit explanation
 * of the three kinds and no Skapa. A company's own items keep their pages.
 */
export function SkillsPage({ hrefBase = '/skills', knowledgeOnly = false }: { hrefBase?: string; knowledgeOnly?: boolean }) {
  const { company } = useCompany()
  return company ? <Registry key={company.id} companyId={company.id} hrefBase={hrefBase} knowledgeOnly={knowledgeOnly} /> : null
}

function Registry({ companyId, hrefBase, knowledgeOnly }: { companyId: string; hrefBase: string; knowledgeOnly: boolean }) {
  const t = useTranslations('skills_registry')
  // The top bar carries the menu row's name (Agenter › Arbetssätt).
  const tNav = useTranslations('nav')
  const tCommon = useTranslations('common')
  const { canWrite } = useCanWrite()
  const { appName } = useBranding()
  const catalog = useSWR(['/api/skills', companyId], ([url]) => readCatalog(url))
  const options = useSWR(['/api/agents/knowledge', companyId], ([url]) => readOptions(url))
  const usage = useSWR(['/api/skills/usage', companyId], ([url]) => readUsage(url))
  const own = (catalog.data ?? []).filter(isOwnItem)

  // ── connection: asked on load and whenever the user comes back to the tab ──
  const [connection, setConnection] = useState<AiConnection | null>(null)
  const [pending, setPending] = useState<AiClient | null>(null)
  const [checkedOnce, setCheckedOnce] = useState(false)
  const pollerRef = useRef<AiStatusPoller | null>(null)
  useEffect(() => {
    const simulated = simulatedClient()
    const poller = createAiStatusPoller({
      fetchStatus: simulated ? async () => simulatedConnection(simulated) : fetchConnections,
      onStatus: setConnection,
      isHidden: () => document.visibilityState === 'hidden',
    })
    pollerRef.current = poller
    poller.check()
    const onBack = () => { if (document.visibilityState === 'visible') poller.check() }
    window.addEventListener('focus', onBack)
    document.addEventListener('visibilitychange', onBack)
    return () => {
      window.removeEventListener('focus', onBack)
      document.removeEventListener('visibilitychange', onBack)
      poller.stop()
      pollerRef.current = null
    }
  }, [])
  // Any live agent key opens the page, also one that names no client (an
  // older key, Cursor): offering the connect again only fails in the client
  // with "a connector with this URL already exists". Work is still handed to
  // a verified client, or Claude by default.
  const isConnected = connection?.connected ?? false
  // Once an AI is connected nothing is pending any more.
  const waitingFor = isConnected ? null : pending
  const state: PageState = connection === null ? 'loading' : isConnected ? 'open' : waitingFor ? 'waiting' : 'locked'
  const client = pickConnectedAiClient(connection?.clients ?? [], waitingFor ?? undefined) ?? waitingFor ?? 'claude'
  const agents = useSWR(['/api/agents', companyId, client], ([url, , c]) => readAgents(`${url}?client=${c}`))

  const companyIndustry = agents.data?.agents[0]?.company.find((c) => c.tier === 'vertical')?.id ?? null

  // ── connect ──
  const [addressCopy, setAddressCopy] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [gateOpen, setGateOpen] = useState(false)
  const connectAction = (target: AiClient) => aiConnectAction(target, { origin: window.location.origin, appName })
  function connect(target: AiClient) {
    trackInstructions('instructions_connect_clicked', { client: target, surface: 'page' })
    setGateOpen(false)
    setPending(target)
    setAddressCopy('idle')
    setCheckedOnce(false)
    // Claude has an add-connector deep link. ChatGPT and Grok get the address to paste first.
    if (target === 'claude') openAiConnector(connectAction(target).open)
    pollerRef.current?.attempt(target)
  }
  function reopen(target: AiClient) {
    openAiConnector(connectAction(target).open)
    pollerRef.current?.attempt(target)
  }
  async function copyAddress(address: string) {
    try {
      await navigator.clipboard.writeText(address)
      setAddressCopy('copied')
    } catch {
      setAddressCopy('failed')
    }
  }
  function createAgent(kind: ItemKind) {
    trackInstructions('instructions_create_clicked', { mode: 'ai', kind, connected: isConnected })
    if (!isConnected) setGateOpen(true)
    else openAiConnector(aiPrefilledChatLink(client, t(`create_prompt_${kind}`)))
  }

  const pendingName = waitingFor ? AI_CLIENTS.find((c) => c.id === waitingFor)!.name : ''
  const address = waitingFor && waitingFor !== 'claude' ? connectAction(waitingFor).copy : null
  // The connection being made: its address and steps, in whichever view the connect started from.
  const waitingBanner = state === 'waiting' && waitingFor ? (
    <section className={styles.gateBanner}>
      <div className={styles.pin}>
        <SpinnerIcon className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden />
        <h2>{waitingFor === 'claude' ? t('wait_claude_title') : t('wait_title', { client: pendingName })}</h2>
        {waitingFor === 'claude' ? <p>{t('wait_claude_body')}</p> : (
          <>
            {address && (
              <div className={styles.addr}>
                <code aria-label={t('server_address')}>{address}</code>
                <Button onClick={() => void copyAddress(address)}>{t(addressCopy === 'copied' ? 'copied' : 'copy')}</Button>
              </div>
            )}
            {addressCopy === 'failed' && <p role="status">{t('copy_failed')}</p>}
            <ol className={styles.stepsl}>
              <li>{t('step_1')}</li>
              <li>{t(`step_2_${waitingFor}`, { appName })}</li>
              <li>{t('step_3')}</li>
            </ol>
          </>
        )}
        <div className={styles.btns}>
          <Button variant="outline" onClick={() => reopen(waitingFor)}>{t('open_client', { client: pendingName })}</Button>
          <Button onClick={() => { setCheckedOnce(true); pollerRef.current?.check() }}>{t('check_again')}</Button>
        </div>
        {checkedOnce && <p role="status">{t('still_waiting', { client: pendingName })}</p>}
        <button type="button" className="text-xs text-muted-foreground underline underline-offset-4" onClick={() => setPending(null)}>{t('cancel')}</button>
      </div>
    </section>
  ) : null

  return (
    <div className={styles.page} data-state={state}>
      <PageHeader
        title={knowledgeOnly ? t('kind_rules') : tNav('v3_skills')}
        help={<HelpPopover><p>{knowledgeOnly ? t('help_knowledge') : t('help')}</p></HelpPopover>}
        action={knowledgeOnly ? undefined : <CatalogCreateMenu hrefBase={hrefBase} client={client} canWrite={canWrite} onCreate={createAgent} />}
      />

      {/* The first visit's explanation sits above the catalogue, so it is read before the featured item. */}
      {!knowledgeOnly && <KindsIntro companyId={companyId} />}

      {/* The catalogue could not load: said before it, with "Försök igen". */}
      {catalog.error &&
        (catalog.data ? (
          <AttnLine action={{ label: t('retry'), onClick: () => void catalog.mutate() }}>{tCommon('refresh_failed')}</AttnLine>
        ) : (
          <LoadError title={t('load_failed')} onRetry={() => void catalog.mutate()} />
        ))}

      <Catalog
        hrefBase={hrefBase}
        catalog={catalog.data ?? []}
        options={options.data ?? []}
        overview={agents.data}
        usage={usage.data}
        own={own}
        companyIndustry={companyIndustry}
        client={client}
        aiReady={isConnected}
        canWrite={canWrite}
        onCreate={createAgent}
        gate={state === 'locked' ? <ConnectHero onConnect={connect} /> : waitingBanner}
        pending={waitingBanner}
        knowledgeOnly={knowledgeOnly}
      />
      {!canWrite && <p className={styles.note}>{t('viewer_note')}</p>}

      <ConnectGate open={gateOpen} onClose={() => setGateOpen(false)} onConnect={connect} />
    </div>
  )
}

