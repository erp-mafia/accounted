'use client'

import { useId, useState, type FormEvent } from 'react'
import { useTranslations } from 'next-intl'
import useSWR from 'swr'
import { BookOpen, Plus } from 'lucide-react'
import { useCompany } from '@/contexts/CompanyContext'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { useFormat } from '@/lib/hooks/use-format'
import { SkillBodySchema } from '@/lib/agent-skills/validation'
import type { CatalogSkill } from '@/lib/agent-skills/catalog'
import { HandoffButton } from '@/components/ai-handoff/HandoffButton'
import { PageHeader } from '@/components/ui/page-header'
import { HelpPopover } from '@/components/ui/help-popover'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { TH_CLASS, TD_CLASS } from '@/components/ui/dry-table'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { SlideOver, SlideOverContent, SlideOverHeader, SlideOverBody } from '@/components/ui/slide-over'

type SkillSummary = Omit<CatalogSkill, 'body'>

async function readData<T>(url: string): Promise<T> {
  const response = await fetch(url)
  if (!response.ok) throw new Error('Skills request failed')
  return (await response.json()).data as T
}

export function SkillsPage() {
  const { company } = useCompany()
  return company ? <CompanySkills key={company.id} companyId={company.id} /> : null
}

function CompanySkills({ companyId }: { companyId: string }) {
  const t = useTranslations('skills_page')
  const { formatDateLong } = useFormat()
  const { canWrite } = useCanWrite()
  const { data, error, isLoading, mutate } = useSWR(['/api/skills', companyId], ([url]) => readData<SkillSummary[]>(url))
  const [selected, setSelected] = useState<string | null>(null)
  const [editor, setEditor] = useState<CatalogSkill | 'new' | null>(null)
  const [sharing, setSharing] = useState<SkillSummary | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState(false)
  const detail = useSWR(selected ? ['/api/skills', companyId, selected] : null, ([url, , slug]) => readData<CatalogSkill>(`${url}?slug=${encodeURIComponent(slug)}`))

  async function change(url: string, method: string, body?: unknown): Promise<boolean> {
    setBusy(true)
    setFailure(false)
    try {
      const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
      if (!response.ok) throw new Error('Skill save failed')
      await mutate()
      await detail.mutate()
      return true
    } catch {
      setFailure(true)
      return false
    } finally {
      setBusy(false)
    }
  }

  return <div className="space-y-8">
    <PageHeader title={t('title')} help={<HelpPopover><p>{t('help')}</p></HelpPopover>} action={<Button disabled={!canWrite} onClick={() => setEditor('new')}><Plus className="mr-2 h-4 w-4" aria-hidden />{t('new')}</Button>} />
    {failure && !editor && !sharing && <p role="alert" className="text-sm text-destructive">{t('save_failed')}</p>}
    {isLoading ? <Skeleton className="h-12 w-full" /> : error ? <div role="alert"><p>{t('load_failed')}</p><Button variant="outline" onClick={() => void mutate()}>{t('retry')}</Button></div> : !data?.length ? <EmptyState icon={BookOpen} title={t('empty')} description={t('help')} /> : <div className="overflow-x-auto stagger-enter">
      <table className="w-full border-collapse text-[13px]">
        <thead><tr><th className={TH_CLASS}>{t('name')}</th><th className={TH_CLASS}>{t('source')}</th><th className={TH_CLASS}>{t('status')}</th><th className={TH_CLASS}><span className="sr-only">{t('actions')}</span></th></tr></thead>
        <tbody>{data.map((skill) => <tr key={skill.slug} className="border-b border-border hover:bg-secondary/35">
          <td className={TD_CLASS}><button type="button" data-ph-mask className="text-left underline-offset-4 hover:underline focus-visible:underline" onClick={() => setSelected(skill.slug)}>{skill.name}</button></td>
          <td className={TD_CLASS}>{skill.tier === 'own' || skill.tier === 'community' ? <Badge variant="outline">{t(skill.tier)}</Badge> : <span className="text-muted-foreground">Accounted</span>}</td>
          <td className={TD_CLASS}><span className="text-muted-foreground">{skill.shareStatus && skill.shareStatus !== 'private' ? t(skill.shareStatus) : skill.active ? t('active') : t('available')}{skill.installations.some((row) => row.scope === 'team') ? ` · ${t('team')}` : ''}</span></td>
          <td className={TD_CLASS}><div className="flex justify-end gap-2">
            {!skill.active && skill.tier !== 'own' && <Button variant="outline" size="sm" disabled={!canWrite || busy} onClick={() => void change('/api/skills', 'POST', { kind: 'catalog', atom_id: skill.slug })}>{t('add')}</Button>}
            <Button variant="ghost" size="sm" onClick={() => setSelected(skill.slug)}>{t('details')}</Button>
          </div></td>
        </tr>)}</tbody>
      </table>
    </div>}
    <SlideOver open={selected !== null} onOpenChange={(open) => { if (!open) setSelected(null) }}>
      <SlideOverContent aria-describedby={undefined} data-ph-mask>
        <SlideOverHeader title={detail.data?.name ?? t('details')} closeLabel={t('close')} />
        <SlideOverBody className="space-y-4">
          {detail.error ? <p role="alert">{t('load_failed')}</p> : !detail.data ? <Skeleton className="h-12 w-full" /> : <>
            <p className="text-sm">{detail.data.summary}</p>
            <p className="text-xs text-muted-foreground">{detail.data.tier === 'own' ? t(`${detail.data.shareStatus ?? 'private'}_help`) : detail.data.reviewedAt ? t(detail.data.tier === 'community' ? 'community_reviewed' : 'accounted_reviewed', { date: formatDateLong(detail.data.reviewedAt) }) : t('review_unknown')}</p>
            <div className="flex flex-wrap gap-2">
              <HandoffButton disabled={detail.data.shareStatus === 'withdrawn'} task={{ kind: `skill:${detail.data.slug}` }} />
              {detail.data.tier === 'own' && detail.data.shareStatus === 'private' && <>
                <Button variant="outline" disabled={!canWrite || busy} onClick={() => setEditor(detail.data!)}>{t('edit')}</Button>
                <Button variant="outline" disabled={!canWrite || busy} onClick={() => setSharing(detail.data!)}>{t('share')}</Button>
              </>}
              {detail.data.installations.map((row) => !detail.data?.shareStatus || detail.data.shareStatus === 'private' ? <Button key={row.installation_id} variant="outline" disabled={!canWrite || busy} onClick={async () => { if (await change(`/api/skills/${row.installation_id}`, 'DELETE')) setSelected(null) }}>{t('remove_scope', { scope: t(row.scope) })}</Button> : null)}
              {['submitted', 'published'].includes(detail.data.shareStatus ?? '') && <Button variant="outline" disabled={!canWrite || busy} onClick={async () => { if (await change(`/api/skills/${detail.data!.installations[0].installation_id}`, 'PATCH', { action: 'withdraw' })) setSelected(null) }}>{t('withdraw')}</Button>}
            </div>
            <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed" data-ph-mask>{detail.data.body}</pre>
          </>}
        </SlideOverBody>
      </SlideOverContent>
    </SlideOver>
    {editor && <SkillEditor key={editor === 'new' ? 'new' : editor.slug} skill={editor === 'new' ? null : editor} busy={busy} failure={failure} onClose={() => { setEditor(null); setFailure(false) }} onSave={async (values) => {
      const saved = await change(editor === 'new' ? '/api/skills' : `/api/skills/${editor.installations[0].installation_id}`, editor === 'new' ? 'POST' : 'PATCH', { ...values, ...(editor === 'new' ? { kind: 'own' } : { action: 'edit' }) })
      if (saved) setEditor(null)
    }} />}
    {sharing && <ShareDialog busy={busy} failure={failure} onClose={() => { setSharing(null); setFailure(false) }} onSubmit={async (handle) => { if (await change(`/api/skills/${sharing.installations[0].installation_id}`, 'PATCH', { action: 'submit', confirmed_no_customer_data: true, author_handle: handle })) setSharing(null) }} />}
  </div>
}

function SkillEditor({ skill, busy, failure, onClose, onSave }: {
  skill: CatalogSkill | null; busy: boolean; failure: boolean; onClose: () => void
  onSave: (values: { name: string; description: string; body: string; scope?: 'company' | 'team' }) => Promise<void>
}) {
  const t = useTranslations('skills_page')
  const id = useId()
  const [name, setName] = useState(skill?.name ?? '')
  const [description, setDescription] = useState(skill?.summary ?? '')
  const [body, setBody] = useState(skill?.body ?? '')
  const [team, setTeam] = useState(false)
  const valid = SkillBodySchema.safeParse(body).success
  function save(event: FormEvent) {
    event.preventDefault()
    if (valid) void onSave({ name, description, body, ...(!skill ? { scope: team ? 'team' as const : 'company' as const } : {}) })
  }
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose() }}><DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
    <DialogHeader><DialogTitle>{t(skill ? 'edit' : 'new')}</DialogTitle><DialogDescription>{t('editor_help')}</DialogDescription></DialogHeader>
    <form onSubmit={save} className="space-y-4" data-ph-mask>
      <div className="space-y-2"><Label htmlFor={`${id}-name`}>{t('name')}</Label><Input id={`${id}-name`} value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required /></div>
      <div className="space-y-2"><Label htmlFor={`${id}-description`}>{t('description')}</Label><Input id={`${id}-description`} value={description} onChange={(event) => setDescription(event.target.value)} maxLength={500} required /></div>
      <div className="space-y-2"><Label htmlFor={`${id}-body`}>{t('body')}</Label><Textarea id={`${id}-body`} value={body} onChange={(event) => setBody(event.target.value)} rows={12} required /><p className="text-xs text-muted-foreground">{t('bytes', { bytes: new TextEncoder().encode(body).length })}</p>{body && !valid && <p role="alert" className="text-sm text-destructive">{t('invalid_body')}</p>}</div>
      {!skill && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={team} onChange={(event) => setTeam(event.target.checked)} />{t('team_scope')}</label>}
      {failure && <p role="alert" className="text-sm text-destructive">{t('save_failed')}</p>}
      <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={onClose}>{t('cancel')}</Button><Button type="submit" disabled={busy || !valid || !name.trim() || !description.trim()}>{t('save')}</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>
}

function ShareDialog({ busy, failure, onClose, onSubmit }: { busy: boolean; failure: boolean; onClose: () => void; onSubmit: (handle: string) => Promise<void> }) {
  const t = useTranslations('skills_page')
  const id = useId()
  const [handle, setHandle] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose() }}><DialogContent>
    <DialogHeader><DialogTitle>{t('share')}</DialogTitle><DialogDescription>{t('share_help')}</DialogDescription></DialogHeader>
    <Label htmlFor={id}>{t('author_handle')}</Label><Input id={id} data-ph-mask value={handle} onChange={(event) => setHandle(event.target.value)} maxLength={39} />
    <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />{t('confirm_share')}</label>
    {failure && <p role="alert" className="text-sm text-destructive">{t('save_failed')}</p>}
    <DialogFooter><Button variant="outline" disabled={busy} onClick={onClose}>{t('cancel')}</Button><Button disabled={busy || !confirmed || !/^[a-z0-9][a-z0-9-]{0,38}$/.test(handle)} onClick={() => void onSubmit(handle)}>{t('submit')}</Button></DialogFooter>
  </DialogContent></Dialog>
}
