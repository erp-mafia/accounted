'use client'

import { useId, useState } from 'react'
import { useTranslations } from 'next-intl'
import useSWR from 'swr'
import { Copy, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { AiConnectorDialog } from '@/components/onboarding/AiConnectorDialog'
import { useCompany } from '@/contexts/CompanyContext'
import { useBranding } from '@/lib/branding/brand-context'
import { AI_CLIENTS, aiChatLink, aiConnectAction, openAiConnector, pickConnectedAiClient, type AiClient } from '@/lib/onboarding/ai-clients'
import { buildAccountingPrompt, handoffRecordCount, MAX_HANDOFF_INSTRUCTIONS, MAX_HANDOFF_RECORDS } from '@/lib/ai-handoff/prompt'
import { taskSkills, type AccountingTaskRequest } from '@/lib/ai-handoff/tasks'
import type { CatalogSkill } from '@/lib/agent-skills/catalog'

interface Props {
  task: AccountingTaskRequest
  clients?: AiClient[]
  preferredClient?: AiClient
  onOpen?: () => void
  disabled?: boolean
}

export function HandoffButton(props: Props) {
  const { company } = useCompany()
  return company ? <CompanyHandoff key={company.id} company={company} {...props} /> : null
}

function CompanyHandoff({ company, task, clients, preferredClient, onOpen, disabled }: Props & { company: { id: string; name: string } }) {
  const t = useTranslations('ai_handoff')
  const { appName } = useBranding()
  const instructionsId = useId()
  const { data } = useSWR(clients === undefined ? ['/api/ai/connections', company.id] : null, async ([url]) => {
    const response = await fetch(url)
    if (!response.ok) throw new Error('Connection lookup failed')
    return (await response.json()).data as AiClient[]
  })
  const connected = clients ?? data ?? []
  const primary = pickConnectedAiClient(connected, preferredClient)
  const [snapshot, setSnapshot] = useState<AccountingTaskRequest | null>(null)
  const catalog = useSWR(snapshot ? ['/api/skills', company.id] : null, async ([url]) => {
    const response = await fetch(url)
    if (!response.ok) throw new Error('Skills lookup failed')
    return (await response.json()).data as Omit<CatalogSkill, 'body'>[]
  })
  const skills = [...new Set([
    ...(snapshot ? taskSkills(snapshot.kind) : []),
    ...(catalog.data ?? []).filter((skill) => skill.active && skill.tier !== 'workflow').map((skill) => skill.slug),
  ])]
  const [client, setClient] = useState<AiClient>(primary ?? 'claude')
  const [instructions, setInstructions] = useState('')
  const [editedPrompt, setEditedPrompt] = useState<string | null>(null)
  const [copiedPrompt, setCopiedPrompt] = useState<string | null>(null)
  const [copyFailed, setCopyFailed] = useState(false)
  const [connector, setConnector] = useState<{ open: string; copy: string | null } | null>(null)
  const selected = AI_CLIENTS.find((item) => item.id === client)!
  const tooMany = snapshot !== null && handoffRecordCount(snapshot) > MAX_HANDOFF_RECORDS
  const prompt = snapshot && !tooMany ? editedPrompt ?? buildAccountingPrompt({ company, task: snapshot, instructions }, t) : ''

  function open() {
    setSnapshot(structuredClone(task))
    setClient(primary ?? 'claude')
    setInstructions('')
    setEditedPrompt(null)
    setCopiedPrompt(null)
    setCopyFailed(false)
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(prompt)
      setCopiedPrompt(prompt)
      setCopyFailed(false)
    } catch {
      setCopiedPrompt(null)
      setCopyFailed(true)
    }
  }

  function connect() {
    const action = aiConnectAction(client, { origin: window.location.origin, appName })
    if (action.copy) setConnector(action)
    else openAiConnector(action.open)
  }

  return <>
    <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={open}>
      {primary ? t('do_with', { client: AI_CLIENTS.find((item) => item.id === primary)!.name }) : t('do_with_ai')}
    </Button>
    <Dialog open={snapshot !== null} onOpenChange={(isOpen) => { if (!isOpen) setSnapshot(null) }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">{t('cli_help')}</p>
        <p className="text-sm font-medium" data-ph-mask>{company.name}</p>
        <div className="flex flex-wrap gap-2" role="group" aria-label={t('choose_ai')}>
          {AI_CLIENTS.map((item) => <Button key={item.id} variant={client === item.id ? 'secondary' : 'outline'} size="sm" aria-pressed={client === item.id} onClick={() => setClient(item.id)}>{item.name}</Button>)}
        </div>
        {!connected.includes(client) && <div className="space-y-2 rounded-lg border p-3">
          <p className="text-sm text-muted-foreground">{t('connect_help', { client: selected.name })}</p>
          <Button variant="outline" size="sm" onClick={connect}>{t('connect', { client: selected.name })}</Button>
        </div>}
        <details><summary className="cursor-pointer text-xs text-muted-foreground">{t('skills_preview')}</summary>
          <p className="mt-2 break-words text-xs text-muted-foreground" data-ph-mask>{t('skills', { skills: skills.join(', ') || t('discovered_skills') })}</p>
        </details>
        <div className="space-y-2">
          <Label htmlFor={instructionsId}>{t('instructions')}</Label>
          <Textarea id={instructionsId} data-ph-mask value={instructions} maxLength={MAX_HANDOFF_INSTRUCTIONS} rows={3} onChange={(event) => { setInstructions(event.target.value); setEditedPrompt(null) }} placeholder={t('instructions_placeholder')} />
        </div>
        {tooMany ? <p role="alert" className="text-sm text-destructive">{t('too_many', { max: MAX_HANDOFF_RECORDS })}</p> : <details open={copyFailed || undefined}>
          <summary className="cursor-pointer text-sm">{t('exact_prompt')}</summary>
          <Textarea className="mt-2" data-ph-mask rows={12} value={prompt} onChange={(event) => setEditedPrompt(event.target.value)} aria-label={t('exact_prompt')} />
        </details>}
        {copyFailed && <p role="alert" className="text-sm text-destructive">{t('copy_failed')}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => void copy()} disabled={!prompt.trim()} aria-live="polite"><Copy className="mr-2 h-4 w-4" aria-hidden />{copiedPrompt === prompt && prompt ? t('copied') : t('copy')}</Button>
          <Button asChild disabled={!prompt.trim()}><a href={aiChatLink(client)} target="_blank" rel="noopener noreferrer" aria-disabled={!prompt.trim()} onClick={(event) => { if (!prompt.trim()) event.preventDefault(); else onOpen?.() }}>{t('open', { client: selected.name })}<ExternalLink className="ml-2 h-4 w-4" aria-hidden /></a></Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <AiConnectorDialog action={connector} onClose={() => setConnector(null)} />
  </>
}
