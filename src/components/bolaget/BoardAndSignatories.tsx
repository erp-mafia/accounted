'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { BolagetHeader } from './BolagetHeader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { AttnLine } from '@/components/ui/attn-line'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { TD_CLASS, TH_CLASS, QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { SettingsSelect } from '@/components/settings/SettingsRows'
import { useToast } from '@/components/ui/use-toast'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { cn, formatDate } from '@/lib/utils'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { COMPANY_ROLE_KINDS } from '@/lib/bolaget/types'

interface RoleRow {
  company_role_id: string
  party_id: string
  name: string
  kind: 'person' | 'company'
  identity: string | null
  role: (typeof COMPANY_ROLE_KINDS)[number]
  role_label: string
  valid_from: string | null
  valid_to: string | null
  active: boolean
  source: 'registry_tic' | 'person' | 'decision' | 'document'
  registered_at: string | null
}

interface RolesData {
  as_of: string
  signatory_rule: string | null
  roles: RoleRow[]
  signatory_rules: Array<{ signatory_rule_id: string; rule_text: string; valid_from: string | null; valid_to: string | null; active: boolean; source: string }>
}

interface BoCandidate {
  party_id: string
  name: string
  kind: 'person' | 'company'
  votes_pct: number
  capital_pct: number
  extent: string
}

interface BoData {
  proposal: { as_of: string; owners: BoCandidate[]; indirect: BoCandidate[]; conclusion: 'owners_identified' | 'no_beneficial_owner' }
  confirmed: Array<{ company_role_id: string; party_id: string; name: string; extent: string | null; valid_from: string | null }>
  assessments: Array<{ beneficial_owner_assessment_id: string; assessed_on: string; conclusion: string; owners: Array<{ name?: string }>; changed: boolean; basis: string }>
  differs: boolean
  filing_url: string
}

type FormState = Record<string, string>

const ADDABLE_ROLES = COMPANY_ROLE_KINDS.filter((r) => r !== 'verklig_huvudman')
const NEW_PARTY = '__new'

function today(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm' }).format(new Date())
}

/**
 * Styrelse och firmateckning: who holds which role and since when (ABL 8
 * kap.), the firmateckning over time, and the verkliga huvudmän (LRVH)
 * proposed from the aktiebok and confirmed here with the LRVH 2:1 record.
 */
export function BoardAndSignatories() {
  const t = useTranslations('bolaget_roles')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const { canWrite } = useCanWrite()

  const [asOf, setAsOf] = useState('')
  const [showEnded, setShowEnded] = useState(false)
  const [loading, setLoading] = useState(true)
  const [roles, setRoles] = useState<RolesData | null>(null)
  const [bo, setBo] = useState<BoData | null>(null)
  const [roleForm, setRoleForm] = useState<FormState | null>(null)
  const [ending, setEnding] = useState<(RoleRow & { valid_to: string }) | null>(null)
  const [ruleForm, setRuleForm] = useState<FormState | null>(null)
  const [boForm, setBoForm] = useState<{ owners: Set<string>; family: boolean; familyNote: string; control: boolean; controlNote: string } | null>(null)
  const [confirmBo, setConfirmBo] = useState(false)
  const [busy, setBusy] = useState(false)

  const fail = useCallback(
    (title: string, body: unknown) => toast({ title, description: getErrorMessage(body, { locale, fallback: title }), variant: 'destructive' }),
    [locale, toast],
  )

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const q = asOf ? `?as_of=${asOf}` : ''
      const [rolesRes, boRes] = await Promise.all([fetch(`/api/bolaget/roles${q}`), fetch(`/api/bolaget/beneficial-owners${q}`)])
      const rolesBody = await rolesRes.json().catch(() => ({}))
      const boBody = await boRes.json().catch(() => ({}))
      if (!rolesRes.ok) return fail(t('load_failed'), rolesBody)
      setRoles(rolesBody.data as RolesData)
      if (boRes.ok) {
        const view = boBody.data as BoData
        setBo(view)
        setBoForm({
          owners: new Set((view.confirmed.length > 0 && !view.differs ? view.confirmed : view.proposal.owners).map((o) => o.party_id)),
          family: false,
          familyNote: '',
          control: false,
          controlNote: '',
        })
      }
    } finally {
      setLoading(false)
    }
  }, [asOf, fail, t])

  useEffect(() => {
    void load()
  }, [load])

  const people = useMemo(() => {
    const byId = new Map<string, { party_id: string; name: string }>()
    for (const r of roles?.roles ?? []) byId.set(r.party_id, { party_id: r.party_id, name: r.name })
    for (const o of bo?.proposal.owners ?? []) byId.set(o.party_id, { party_id: o.party_id, name: o.name })
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, 'sv'))
  }, [roles, bo])

  const visibleRoles = (roles?.roles ?? []).filter((r) => r.role !== 'verklig_huvudman' && (showEnded || r.active))

  async function post(url: string, body: unknown, failTitle: string): Promise<boolean> {
    setBusy(true)
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        fail(failTitle, json)
        return false
      }
      return true
    } finally {
      setBusy(false)
    }
  }

  async function addRole() {
    if (!roleForm) return
    const body: Record<string, unknown> = { role: roleForm.role, valid_from: roleForm.valid_from }
    if (roleForm.party && roleForm.party !== NEW_PARTY) body.party_id = roleForm.party
    else {
      body.name = roleForm.name.trim()
      body.kind = roleForm.kind
      if (roleForm.kind === 'company' && roleForm.org_number.trim()) body.org_number = roleForm.org_number.trim()
    }
    if (roleForm.registered_at) body.registered_at = roleForm.registered_at
    if (await post('/api/bolaget/roles', body, t('role_failed'))) {
      toast({ title: t('role_added') })
      setRoleForm(null)
      await load()
    }
  }

  async function endRole() {
    if (!ending) return
    if (await post(`/api/bolaget/roles/${ending.company_role_id}/end`, { valid_to: ending.valid_to }, t('role_failed'))) {
      toast({ title: t('role_ended') })
      setEnding(null)
      await load()
    }
  }

  async function saveRule() {
    if (!ruleForm) return
    if (await post('/api/bolaget/signatory-rules', { rule_text: ruleForm.rule_text, valid_from: ruleForm.valid_from }, t('rule_failed'))) {
      toast({ title: t('rule_saved') })
      setRuleForm(null)
      await load()
    }
  }

  async function saveBo() {
    if (!boForm || !bo) return
    const owners = [...boForm.owners]
    const ok = await post(
      '/api/bolaget/beneficial-owners/assessments',
      {
        assessed_on: today(),
        conclusion: owners.length > 0 ? 'owners_identified' : 'no_beneficial_owner',
        owners: owners.map((party_id) => ({ party_id })),
        family_aggregation_checked: boForm.family,
        family_note: boForm.familyNote || null,
        control_agreements: boForm.control,
        control_note: boForm.controlNote || null,
      },
      t('bo_failed'),
    )
    if (ok) {
      toast({ title: t('bo_saved') })
      await load()
    }
  }

  const field = (state: FormState, set: (s: FormState) => void, key: string) => ({
    id: `br-${key}`,
    value: state[key] ?? '',
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => set({ ...state, [key]: e.target.value }),
  })

  const latest = bo?.assessments[0] ?? null
  const attn = bo && bo.differs ? <AttnLine>{t('attn_bo_differs')}</AttnLine> : latest?.changed ? (
    <AttnLine action={{ label: t('attn_bo_file_action'), href: bo!.filing_url }}>{t('attn_bo_file')}</AttnLine>
  ) : null

  return (
    <div className="space-y-8">
      <BolagetHeader title={t('title')} help={t('help')} asOf={asOf} onAsOfChange={setAsOf} asOfLabel={t('as_of')}>
            {canWrite && (
              <Button size="sm" onClick={() => setRoleForm({ party: people[0]?.party_id ?? NEW_PARTY, name: '', kind: 'person', org_number: '', role: 'styrelseledamot', valid_from: today(), registered_at: '' })}>
                {t('add_role')}
              </Button>
            )}
      </BolagetHeader>

      {attn}

      {loading && !roles ? (
        <div className="space-y-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : roles ? (
        <>
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-4">
              <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">{t('roles_heading')}</h2>
              <button type="button" className={QUIET_LINK_CLASS} onClick={() => setShowEnded((v) => !v)}>
                {showEnded ? t('hide_ended') : t('show_ended')}
              </button>
            </div>
            {visibleRoles.length === 0 ? (
              <EmptyState title={t('roles_empty_title')} description={t('roles_empty_description')} />
            ) : (
              <div className="overflow-x-auto">
                <table className="stagger-enter w-full border-collapse text-[13px]">
                  <thead>
                    <tr>
                      <th className={TH_CLASS}>{t('col_role')}</th>
                      <th className={TH_CLASS}>{t('col_name')}</th>
                      <th className={TH_CLASS}>{t('col_from')}</th>
                      <th className={TH_CLASS}>{t('col_to')}</th>
                      <th className={TH_CLASS}>{t('col_source')}</th>
                      <th className={TH_CLASS} />
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRoles.map((r) => (
                      <tr key={r.company_role_id} className={cn('hover:bg-secondary/35', !r.active && 'text-muted-foreground')}>
                        <td className={TD_CLASS}>{t(`role_${r.role}`)}</td>
                        <td className={TD_CLASS} data-ph-mask="">
                          {r.name}
                        </td>
                        <td className={cn(TD_CLASS, 'tabular-nums')}>{r.valid_from ? formatDate(r.valid_from) : t('unknown')}</td>
                        <td className={cn(TD_CLASS, 'tabular-nums')}>{r.valid_to ? formatDate(r.valid_to) : ''}</td>
                        <td className={cn(TD_CLASS, 'text-xs text-muted-foreground')}>{t(`source_${r.source}`)}</td>
                        <td className={cn(TD_CLASS, 'text-right')}>
                          {canWrite && r.valid_to === null && (
                            <button type="button" className={QUIET_LINK_CLASS} onClick={() => setEnding({ ...r, valid_to: today() })}>
                              {t('end_role')}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="space-y-3">
            <div className="flex items-center justify-between gap-4">
              <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">{t('signatory_heading')}</h2>
              {canWrite && (
                <button type="button" className={QUIET_LINK_CLASS} onClick={() => setRuleForm({ rule_text: roles.signatory_rule ?? '', valid_from: today() })}>
                  {t('change_rule')}
                </button>
              )}
            </div>
            <p className="text-sm">{roles.signatory_rule ?? <span className="text-muted-foreground">{t('rule_missing')}</span>}</p>
            {showEnded &&
              roles.signatory_rules
                .filter((r) => !r.active)
                .map((r) => (
                  <p key={r.signatory_rule_id} className="text-[12.5px] text-muted-foreground">
                    {t('rule_period', { from: r.valid_from ?? t('unknown'), to: r.valid_to ?? '' })}: {r.rule_text}
                  </p>
                ))}
          </section>

          {bo && boForm && (
            <section className="space-y-3">
              <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">{t('bo_heading')}</h2>
              <p className="text-sm text-muted-foreground">{t('bo_intro')}</p>
              {bo.proposal.owners.length === 0 && bo.confirmed.length === 0 ? (
                <p className="text-sm">{t('bo_none_proposed')}</p>
              ) : (
                <div className="space-y-2">
                  {[...new Map([...bo.proposal.owners, ...bo.confirmed.map((c) => ({ party_id: c.party_id, name: c.name, kind: 'person' as const, votes_pct: 0, capital_pct: 0, extent: c.extent ?? '' }))].map((o) => [o.party_id, o])).values()].map((o) => (
                    <label key={o.party_id} className="flex items-start gap-2 text-sm">
                      <Checkbox
                        checked={boForm.owners.has(o.party_id)}
                        disabled={!canWrite}
                        onCheckedChange={(v) => {
                          const next = new Set(boForm.owners)
                          if (v === true) next.add(o.party_id)
                          else next.delete(o.party_id)
                          setBoForm({ ...boForm, owners: next })
                        }}
                      />
                      <span data-ph-mask="">
                        {o.name}
                        <span className="ml-2 text-xs text-muted-foreground">{o.extent}</span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
              {bo.proposal.indirect.length > 0 && (
                <p className="text-[12.5px] text-muted-foreground">
                  {t('bo_indirect', { names: bo.proposal.indirect.map((o) => `${o.name} (${o.votes_pct.toLocaleString('sv-SE')} %)`).join(', ') })}
                </p>
              )}
              {canWrite && (
                <div className="space-y-3 pt-2">
                  <label className="flex items-start gap-2 text-sm">
                    <Checkbox checked={boForm.family} onCheckedChange={(v) => setBoForm({ ...boForm, family: v === true })} />
                    <span>{t('bo_family')}</span>
                  </label>
                  {boForm.family && (
                    <Textarea value={boForm.familyNote} onChange={(e) => setBoForm({ ...boForm, familyNote: e.target.value })} maxLength={2000} rows={2} placeholder={t('bo_note_placeholder')} />
                  )}
                  <label className="flex items-start gap-2 text-sm">
                    <Checkbox checked={boForm.control} onCheckedChange={(v) => setBoForm({ ...boForm, control: v === true })} />
                    <span>{t('bo_control')}</span>
                  </label>
                  {boForm.control && (
                    <Textarea value={boForm.controlNote} onChange={(e) => setBoForm({ ...boForm, controlNote: e.target.value })} maxLength={2000} rows={2} placeholder={t('bo_note_placeholder')} />
                  )}
                  <Button size="sm" variant="outline" onClick={() => setConfirmBo(true)}>
                    {t('bo_confirm')}
                  </Button>
                </div>
              )}
              {bo.assessments.length > 0 && (
                <div className="space-y-1 pt-2">
                  <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{t('bo_history')}</h3>
                  {bo.assessments.map((a) => (
                    <p key={a.beneficial_owner_assessment_id} className="text-[12.5px] text-muted-foreground" data-ph-mask="">
                      {formatDate(a.assessed_on)}:{' '}
                      {a.conclusion === 'no_beneficial_owner' ? t('bo_none') : a.owners.map((o) => o.name ?? '').join(', ')}
                    </p>
                  ))}
                </div>
              )}
            </section>
          )}
        </>
      ) : null}

      <ConfirmDialog
        open={confirmBo}
        onOpenChange={setConfirmBo}
        title={t('bo_confirm_title')}
        description={t('bo_confirm_description', { count: boForm?.owners.size ?? 0 })}
        confirmLabel={t('bo_confirm')}
        onConfirm={saveBo}
      />

      <ConfirmDialog
        open={Boolean(ending)}
        onOpenChange={(open) => (open ? null : setEnding(null))}
        title={t('end_role_title', { name: ending?.name ?? '' })}
        description={t('end_role_description', { role: ending ? t(`role_${ending.role}`) : '' })}
        confirmLabel={t('end_role')}
        onConfirm={endRole}
      >
        {ending && (
          <div className="space-y-1">
            <Label htmlFor="br-valid_to">{t('field_last_day')}</Label>
            <Input id="br-valid_to" type="date" value={ending.valid_to} onChange={(e) => setEnding({ ...ending, valid_to: e.target.value })} className="tabular-nums" />
          </div>
        )}
      </ConfirmDialog>

      <Dialog open={Boolean(roleForm)} onOpenChange={(open) => (open ? null : setRoleForm(null))}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('add_role')}</DialogTitle>
          </DialogHeader>
          {roleForm && (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="br-role">{t('col_role')}</Label>
                <SettingsSelect {...field(roleForm, setRoleForm, 'role')}>
                  {ADDABLE_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {t(`role_${r}`)}
                    </option>
                  ))}
                </SettingsSelect>
              </div>
              <div className="space-y-1">
                <Label htmlFor="br-valid_from">{t('col_from')}</Label>
                <Input {...field(roleForm, setRoleForm, 'valid_from')} type="date" className="tabular-nums" />
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="br-party">{t('col_name')}</Label>
                <SettingsSelect {...field(roleForm, setRoleForm, 'party')}>
                  <option value={NEW_PARTY}>{t('party_new')}</option>
                  {people.map((p) => (
                    <option key={p.party_id} value={p.party_id}>
                      {p.name}
                    </option>
                  ))}
                </SettingsSelect>
              </div>
              {(!roleForm.party || roleForm.party === NEW_PARTY) && (
                <>
                  <div className="space-y-1">
                    <Label htmlFor="br-name">{t('field_name')}</Label>
                    <Input {...field(roleForm, setRoleForm, 'name')} maxLength={200} data-ph-mask="" />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="br-kind">{t('field_kind')}</Label>
                    <SettingsSelect {...field(roleForm, setRoleForm, 'kind')}>
                      <option value="person">{t('kind_person')}</option>
                      <option value="company">{t('kind_company')}</option>
                    </SettingsSelect>
                  </div>
                  {roleForm.kind === 'company' && (
                    <div className="space-y-1">
                      <Label htmlFor="br-org_number">{t('field_org_number')}</Label>
                      <Input {...field(roleForm, setRoleForm, 'org_number')} maxLength={13} className="tabular-nums" />
                    </div>
                  )}
                </>
              )}
              <div className="space-y-1">
                <Label htmlFor="br-registered_at">{t('field_registered_at')}</Label>
                <Input {...field(roleForm, setRoleForm, 'registered_at')} type="date" className="tabular-nums" />
              </div>
              <p className="text-xs text-muted-foreground sm:col-span-2">{t('role_hint')}</p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRoleForm(null)} disabled={busy}>
              {t('cancel')}
            </Button>
            <Button onClick={addRole} loading={busy} disabled={!roleForm?.valid_from}>
              {t('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(ruleForm)} onOpenChange={(open) => (open ? null : setRuleForm(null))}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('change_rule')}</DialogTitle>
          </DialogHeader>
          {ruleForm && (
            <div className="space-y-4">
              <div className="space-y-1">
                <Label htmlFor="br-rule_text">{t('field_rule_text')}</Label>
                <Textarea {...field(ruleForm, setRuleForm, 'rule_text')} maxLength={2000} rows={3} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="br-valid_from">{t('col_from')}</Label>
                <Input {...field(ruleForm, setRuleForm, 'valid_from')} type="date" className="tabular-nums" />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRuleForm(null)} disabled={busy}>
              {t('cancel')}
            </Button>
            <Button onClick={saveRule} loading={busy} disabled={!ruleForm?.rule_text.trim() || !ruleForm?.valid_from}>
              {t('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
