'use client'

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { useTranslations } from 'next-intl'
import useSWR from 'swr'
import { useCompany } from '@/contexts/CompanyContext'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { useBranding } from '@/lib/branding/brand-context'
import type { CatalogSkill } from '@/lib/agent-skills/catalog'
import type { WorklistCategory } from '@/lib/worklist/types'
import { FREE_SKILLS, REGISTRY_SKILLS, skillsToDoNow, type RegistrySkillId } from '@/lib/agent-skills/registry'
import { AI_CLIENTS, aiConnectAction, openAiConnector, pickConnectedAiClient, type AiClient } from '@/lib/onboarding/ai-clients'
import { createAiStatusPoller, type AiStatusPoller } from '@/lib/onboarding/ai-status-poll'
import { PageHeader } from '@/components/ui/page-header'
import { HelpPopover } from '@/components/ui/help-popover'
import { Button } from '@/components/ui/button'
import { SkillSheet, type SheetTarget } from './SkillSheet'
import { SkillCreator, type CreatorMode, type KeyRect } from './SkillCreator'
import { SkillMarks } from './SkillMarks'
import { Spark, centerIn, prefersReducedMotion, wait } from './spark'
import styles from './skills.module.css'

type SkillSummary = Omit<CatalogSkill, 'body'>
type OwnRow = { slug: string; name: string; summary: string; installationId: string }
type PageState = 'loading' | 'locked' | 'waiting' | 'unlocking' | 'open'
type Row = { key: string; name: string; desc: string; own?: OwnRow; id?: RegistrySkillId }

/** Set once the unlock ("Gnistan fortsätter") has played in this browser. */
const UNLOCK_SEEN_KEY = 'accounted.skills.unlock-seen'

function readSeen(): boolean {
  try { return window.localStorage.getItem(UNLOCK_SEEN_KEY) === '1' } catch { return false }
}
function markSeen(): void {
  try { window.localStorage.setItem(UNLOCK_SEEN_KEY, '1') } catch { /* private mode: the unlock simply plays again */ }
}

/** Null when the status is unavailable: a failed read never makes a connected client look disconnected. */
async function fetchConnections(signal: AbortSignal): Promise<AiClient[] | null> {
  try {
    const response = await fetch('/api/ai/connections', { signal })
    if (!response.ok) return null
    return (await response.json()).data as AiClient[]
  } catch {
    return null
  }
}

/**
 * Local development only: /skills?ai=claude (or chatgpt, grok) shows the page
 * as connected without a real MCP connection. Compiled out of production.
 */
function simulatedClient(): AiClient | null {
  if (process.env.NODE_ENV !== 'development') return null
  const value = new URLSearchParams(window.location.search).get('ai')
  return AI_CLIENTS.find((c) => c.id === value)?.id ?? null
}

/** The "Att göra" counts; a failed read tags nothing rather than breaking the page. */
async function readWorklist(url: string): Promise<Partial<Record<WorklistCategory, number>>> {
  const response = await fetch(url)
  if (!response.ok) return {}
  return ((await response.json()).data as { counts: Record<WorklistCategory, number> }).counts
}

async function readCatalog(url: string): Promise<SkillSummary[]> {
  const response = await fetch(url)
  if (!response.ok) throw new Error('Skills request failed')
  return (await response.json()).data as SkillSummary[]
}

export function SkillsPage() {
  const { company } = useCompany()
  return company ? <Registry key={company.id} companyId={company.id} /> : null
}

function Registry({ companyId }: { companyId: string }) {
  const t = useTranslations('skills_registry')
  const { canWrite } = useCanWrite()
  const { appName } = useBranding()
  const catalog = useSWR(['/api/skills', companyId], ([url]) => readCatalog(url))
  const worklist = useSWR(['/api/worklist/counts', companyId], ([url]) => readWorklist(url))
  const doNow = skillsToDoNow(worklist.data ?? {})
  const own: OwnRow[] = (catalog.data ?? [])
    .filter((skill) => skill.tier === 'own' && skill.shareStatus !== 'withdrawn' && skill.installations[0])
    .map((skill) => ({ slug: skill.slug, name: skill.name, summary: skill.summary, installationId: skill.installations[0].installation_id }))

  // ── connection: asked on load and whenever the user comes back to the tab ──
  const [connected, setConnected] = useState<AiClient[] | null>(null)
  const [pending, setPending] = useState<AiClient | null>(null)
  const [checkedOnce, setCheckedOnce] = useState(false)
  const pollerRef = useRef<AiStatusPoller | null>(null)
  useEffect(() => {
    const simulated = simulatedClient()
    const poller = createAiStatusPoller({
      fetchStatus: simulated ? async () => [simulated] : fetchConnections,
      onStatus: setConnected,
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

  // ── elements the spark hops between ──
  const pageRef = useRef<HTMLDivElement>(null)
  const heroRef = useRef<HTMLElement>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const cardRefs = useRef<(HTMLDivElement | null)[]>([])
  const rowAnchors = useRef(new Map<string, HTMLSpanElement>())
  const rowOrder = useRef<string[]>([])
  const createRef = useRef<HTMLButtonElement>(null)
  const createLedRef = useRef<HTMLSpanElement>(null)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  // ── Gnista: every visit, the spark leaves the headline and lights the three keys ──
  const [litKeys, setLitKeys] = useState(0)
  const [ringKey, setRingKey] = useState<number | null>(null)
  const loadIn = useRef<Promise<void> | null>(null)
  useEffect(() => {
    if (loadIn.current) return // Strict Mode runs effects twice in dev: one spark only.
    const hero = heroRef.current
    const title = titleRef.current
    if (!hero || !title || prefersReducedMotion() || !hero.animate) {
      setLitKeys(FREE_SKILLS)
      loadIn.current = Promise.resolve()
      return
    }
    const run = async () => {
      const h = title.getBoundingClientRect()
      const b = hero.getBoundingClientRect()
      const spark = new Spark(hero, { x: h.left - b.left + 4, y: h.bottom - b.top + 8 }, styles.spark)
      try {
        await wait(450)
        for (let i = 0; i < FREE_SKILLS; i++) {
          const card = cardRefs.current[i]
          if (!alive.current || !card) return
          await spark.hop(card, 560, 54)
          if (!alive.current) return
          setLitKeys(i + 1)
          setRingKey(i)
          await wait(240)
        }
        await spark.fade()
      } finally {
        spark.remove()
        if (alive.current) { setRingKey(null); setLitKeys(FREE_SKILLS) }
      }
    }
    loadIn.current = run()
  }, [])

  // ── Gnistan fortsätter: the spark lights the list, once after connecting ──
  const [unlocking, setUnlocking] = useState<number | null>(null)
  const [createLit, setCreateLit] = useState(false)
  const startedUnlock = useRef(false)
  const shouldUnlock = (list: AiClient[] | null, waitingFor: AiClient | null) =>
    !!list?.length && !startedUnlock.current && (waitingFor !== null || !readSeen())
  const runUnlock = useCallback(async () => {
    startedUnlock.current = true
    setPending(null)
    setUnlocking(0)
    await loadIn.current
    const page = pageRef.current
    const from = cardRefs.current[FREE_SKILLS - 1]
    const anchors = rowOrder.current.map((key) => rowAnchors.current.get(key)).filter((el): el is HTMLSpanElement => !!el)
    if (!page || !from || prefersReducedMotion() || !page.animate) {
      markSeen()
      setUnlocking(null)
      return
    }
    const start = centerIn(page, from)
    const spark = new Spark(page, { x: start.x, y: start.y + from.getBoundingClientRect().height / 2 }, `${styles.spark} ${styles.sparkInk}`)
    try {
      await wait(250)
      for (let i = 0; i < anchors.length; i++) {
        if (!alive.current) return
        await spark.hop(anchors[i], 300, 26)
        setUnlocking(i + 1)
        await wait(70)
      }
      if (createLedRef.current && alive.current) {
        await spark.hop(createLedRef.current, 800, 60)
        setCreateLit(true)
        await wait(150)
      }
      await spark.fade()
    } finally {
      spark.remove()
      markSeen()
      if (alive.current) { setCreateLit(false); setUnlocking(null) }
    }
  }, [])
  useEffect(() => {
    if (shouldUnlock(connected, pending)) void runUnlock()
  }, [connected, pending, runUnlock])

  const isConnected = (connected?.length ?? 0) > 0
  const state: PageState = connected === null
    ? 'loading'
    : unlocking !== null || shouldUnlock(connected, pending)
      ? 'unlocking'
      : isConnected ? 'open' : pending ? 'waiting' : 'locked'
  const client = pickConnectedAiClient(connected ?? [], pending ?? undefined) ?? pending ?? 'claude'

  // ── connect ──
  const [addressCopy, setAddressCopy] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [creator, setCreator] = useState<CreatorMode | null>(null)
  const connectAction = (target: AiClient) => aiConnectAction(target, { origin: window.location.origin, appName })
  function connect(target: AiClient) {
    setCreator(null)
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

  // ── sheet, creator, and the forged key landing in the list ──
  const [sheet, setSheet] = useState<SheetTarget | null>(null)
  const [landing, setLanding] = useState<string | null>(null)
  const [hitRow, setHitRow] = useState<string | null>(null)

  async function saveOwn(skill: { name: string; description: string; body: string }, mode: CreatorMode): Promise<string | null> {
    try {
      const edit = mode.kind === 'edit'
      const response = await fetch(edit ? `/api/skills/${mode.installationId}` : '/api/skills', {
        method: edit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(edit ? { action: 'edit', ...skill } : { kind: 'own', scope: 'company', ...skill }),
      })
      if (!response.ok) return null
      if (edit) return mode.installationId
      return ((await response.json()).data as { id: string }).id
    } catch {
      return null
    }
  }
  async function deleteOwn(target: Extract<SheetTarget, { kind: 'own' }>): Promise<boolean> {
    try {
      const response = await fetch(`/api/skills/${target.installationId}`, { method: 'DELETE' })
      if (!response.ok) return false
      setSheet(null)
      await catalog.mutate()
      return true
    } catch {
      return false
    }
  }
  // "Hem": the forged key leaves the closing creator and flies into its row.
  const flyFrom = useRef<KeyRect | null>(null)
  function onSaved(installationId: string, key: KeyRect | null) {
    flyFrom.current = key
    setCreator(null)
    setSheet(null)
    setLanding(installationId)
    void catalog.mutate()
  }
  function openRow(row: Row) {
    setSheet(row.own
      ? { kind: 'own', slug: row.own.slug, name: row.own.name, installationId: row.own.installationId }
      : { kind: 'registry', id: row.id!, locked: rowsLocked })
  }
  const landingSlug = landing ? own.find((row) => row.installationId === landing)?.slug : undefined
  useEffect(() => {
    if (!landingSlug) return
    setLanding(null)
    const page = pageRef.current
    const anchor = rowAnchors.current.get(landingSlug)
    const button = createRef.current
    const from = flyFrom.current
    flyFrom.current = null
    if (!page || !anchor || !button || prefersReducedMotion() || !page.animate) { setHitRow(landingSlug); return }
    const row = anchor.closest(`.${styles.row}`)
    if (from && row) {
      const to = row.getBoundingClientRect()
      const key = document.createElement('div')
      key.className = styles.flykey
      key.setAttribute('aria-hidden', 'true')
      key.textContent = from.name
      Object.assign(key.style, { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px` })
      document.body.appendChild(key)
      const dx = to.left - from.left, dy = to.top - from.top, sx = to.width / from.width, sy = to.height / from.height
      const flight = key.animate([
        { transform: 'none' },
        { transform: `translate(${dx}px, ${dy - 60}px) scale(${sx}, ${sy})`, offset: 0.7 },
        { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, opacity: 1 },
      ], { duration: 1100, easing: 'cubic-bezier(.6, 0, .2, 1)', fill: 'forwards' })
      void flight.finished.catch(() => {}).finally(() => {
        key.remove()
        if (alive.current) setHitRow(landingSlug)
      })
      return
    }
    const spark = new Spark(page, centerIn(page, button), `${styles.spark} ${styles.sparkInk}`)
    void (async () => {
      try {
        await wait(450)
        if (!alive.current) return
        await spark.hop(anchor, 900, 40)
        if (alive.current) setHitRow(landingSlug)
        await spark.fade()
      } finally {
        spark.remove()
      }
    })()
  }, [landingSlug])

  // ── derived view ──
  const top = REGISTRY_SKILLS.slice(0, FREE_SKILLS)
  const rows: Row[] = [
    ...own.map((row) => ({ key: row.slug, name: row.name, desc: row.summary, own: row })),
    ...REGISTRY_SKILLS.slice(FREE_SKILLS).map((skill) => ({ key: skill.id, name: t(`skills.${skill.id}.name`), desc: t(`skills.${skill.id}.desc`), id: skill.id })),
  ]
  useEffect(() => { rowOrder.current = rows.map((row) => row.key) })
  const rowsLocked = state === 'locked' || state === 'waiting' || state === 'loading'
  const sheetKey = sheet?.kind === 'registry' ? sheet.id : null
  const pendingName = pending ? AI_CLIENTS.find((c) => c.id === pending)!.name : ''
  const address = pending && pending !== 'claude' ? connectAction(pending).copy : null

  return (
    <div ref={pageRef} className={styles.page} data-state={state}>
      <PageHeader
        title={t('title')}
        help={<HelpPopover><p>{t('help')}</p></HelpPopover>}
        action={
          <span className={styles.createWrap} data-burn={state === 'open' ? '' : undefined}>
            <Button ref={createRef} disabled={!canWrite} onClick={() => setCreator(isConnected ? { kind: 'create' } : { kind: 'gate' })}>
              <span ref={createLedRef} className={styles.cled} data-on={createLit || state === 'open' ? '' : undefined} aria-hidden />
              {t('create')}
            </Button>
          </span>
        }
      />

      <section ref={heroRef} className={styles.hero} data-anim="">
        <div className={styles.intro}>
          <h2 ref={titleRef}>{t('hero_title')}</h2>
        </div>
        <div className={styles.cards}>
          {top.map((skill, i) => (
            <div
              key={skill.id}
              ref={(el) => { cardRefs.current[i] = el }}
              className={styles.card}
              style={{ '--i': i } as CSSProperties}
              data-lit={litKeys > i ? '' : undefined}
              data-ring={ringKey === i ? '' : undefined}
              data-down={sheetKey === skill.id ? '' : undefined}
              data-now={doNow.has(skill.id) ? '' : undefined}
            >
              <button type="button" className={styles.face} onClick={() => setSheet({ kind: 'registry', id: skill.id, locked: !isConnected })}>
                <span className={styles.faceTop}>
                  <SkillMarks id={skill.id} />
                  {doNow.has(skill.id) && <span className={styles.now}>{t('now_tag')}</span>}
                  <span className={styles.led} aria-hidden />
                </span>
                <h3>{t(`skills.${skill.id}.name`)}</h3>
                <p>{t(`skills.${skill.id}.short`)}</p>
                <span className={styles.open} aria-hidden>{t('open_hint')}</span>
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className={styles.lower} aria-label={t('title')}>
        {!canWrite && <p className={styles.note}>{t('viewer_note')}</p>}
        {catalog.error && <p role="alert" className={styles.note}>{t('load_failed')} <button type="button" className="underline underline-offset-4" onClick={() => void catalog.mutate()}>{t('retry')}</button></p>}
        <div className={styles.veilwrap}>
          <ul className={styles.rows} aria-hidden={rowsLocked || undefined}>
            {rows.map((row, i) => (
              <li key={row.key}>
                <div
                  className={styles.row}
                  style={{ '--i': i } as CSSProperties}
                  data-own={row.own ? '' : undefined}
                  data-now={row.id && doNow.has(row.id) ? '' : undefined}
                  data-hit={hitRow === row.key || (unlocking !== null && i < unlocking) ? '' : undefined}
                >
                  <span className={styles.anchor} ref={(el) => { if (el) rowAnchors.current.set(row.key, el); else rowAnchors.current.delete(row.key) }} aria-hidden />
                  <button type="button" className={styles.rowMain} tabIndex={rowsLocked ? -1 : undefined} onClick={() => openRow(row)}>
                    <span className={styles.nm} data-ph-mask={row.own ? '' : undefined}>{row.name}</span>
                  </button>
                  <span className={styles.ds} data-ph-mask={row.own ? '' : undefined}>{row.desc}</span>
                  {row.id && <SkillMarks id={row.id} />}
                  {row.id && doNow.has(row.id) && <span className={`${styles.now} ${styles.nowLight}`}>{t('now_tag')}</span>}
                  <span className={styles.open} aria-hidden>{t('open_hint')}</span>
                </div>
              </li>
            ))}
          </ul>
          <div className={styles.plate} data-gone={state === 'locked' || state === 'waiting' ? undefined : ''}>
            {state === 'locked' && (
              <div className={styles.pin}>
                <h2>{t('sign_title')}</h2>
                <div className={styles.btns}>
                  {AI_CLIENTS.map((c, i) => (
                    <button key={c.id} type="button" className={i === 0 ? styles.sbtn : `${styles.sbtn} ${styles.sbtnGhost}`} onClick={() => connect(c.id)}>
                      {i === 0 ? t('connect_client', { client: c.name }) : c.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {state === 'waiting' && pending && (
              <div className={styles.pin}>
                <span className={styles.waitled} aria-hidden />
                <h2>{pending === 'claude' ? t('wait_claude_title') : t('wait_title', { client: pendingName })}</h2>
                {pending === 'claude' ? <p>{t('wait_claude_body')}</p> : (
                  <>
                    {address && (
                      <div className={styles.addr}>
                        <code aria-label={t('server_address')}>{address}</code>
                        <Button size="sm" onClick={() => void copyAddress(address)}>{t(addressCopy === 'copied' ? 'copied' : 'copy')}</Button>
                      </div>
                    )}
                    {addressCopy === 'failed' && <p role="status">{t('copy_failed')}</p>}
                    <ol className={styles.stepsl}>
                      <li>{t('step_1')}</li>
                      <li>{t('step_2', { client: pendingName })}</li>
                      <li>{t('step_3')}</li>
                    </ol>
                  </>
                )}
                <div className={styles.btns}>
                  <Button variant="outline" onClick={() => reopen(pending)}>{t('open_client', { client: pendingName })}</Button>
                  <Button onClick={() => { setCheckedOnce(true); pollerRef.current?.check() }}>{t('check_again')}</Button>
                </div>
                {checkedOnce && <p role="status">{t('still_waiting', { client: pendingName })}</p>}
                <button type="button" className="text-xs text-muted-foreground underline underline-offset-4" onClick={() => setPending(null)}>{t('cancel')}</button>
              </div>
            )}
          </div>
        </div>
      </section>

      <SkillSheet
        target={sheet}
        companyId={companyId}
        client={client}
        canWrite={canWrite}
        onClose={() => setSheet(null)}
        onConnect={(target) => { setSheet(null); connect(target) }}
        onEdit={(target) => { setSheet(null); setCreator({ kind: 'edit', installationId: target.installationId }) }}
        onDelete={deleteOwn}
      />
      <SkillCreator mode={creator} client={client} pageRef={pageRef} onClose={() => setCreator(null)} onConnect={connect} onSave={saveOwn} onSaved={onSaved} />
    </div>
  )
}
