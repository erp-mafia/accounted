'use client'

import { useEffect, useState } from 'react'
import { isLegalPersonOrgNumber } from '@/lib/parties/scb/org-number'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { VTD_CLASS, VTH_CLASS } from '@/components/ui/dry-table'
import { Skeleton } from '@/components/ui/skeleton'
import { SlideOver, SlideOverBody, SlideOverContent, SlideOverHeader } from '@/components/ui/slide-over'
import type { Dossier, PartyRole, RegisterPeriod } from '@/lib/parties/register'
import { formatCurrency, formatDate, formatOrgNumber } from '@/lib/utils'
import { AccountNub } from './AccountNub'
import { formatPaymentIdentity, rhythmLabel, roleLabel } from './format'
import type { MergeCandidate } from './MergeDialog'

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">{children}</h2>
}

const REGISTRY_FIELDS = [
  'f_tax',
  'vat_registration',
  'employer_registration',
  'company_status',
  'legal_form',
  'bolagsverket_status',
  'employees_band',
  'industry',
  'postal_address',
  'seat',
  'registered_at',
  'active_since',
  'active_until',
  'phone',
  'email',
  'workplaces',
  'trade_name',
] as const

/** Live registry facts, in the order the dossier shows them. */
function registryFacts(facts: Dossier['facts']): Dossier['facts'] {
  const scb = facts.filter((f) => f.source === 'registry_scb')
  return REGISTRY_FIELDS.flatMap((field) => scb.filter((f) => f.field === field))
}

function registryLabel(t: (k: string) => string, field: string): string {
  return REGISTRY_FIELDS.includes(field as (typeof REGISTRY_FIELDS)[number]) ? t(`fact_${field}`) : field
}

/** Coded facts show their label; address and seat compose; the rest print. */
function registryValue(value: unknown): React.ReactNode {
  if (value === null || value === undefined) return '·'
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  const v = value as Record<string, unknown>
  if (typeof v.label === 'string') {
    return v.warning ? <span className="text-warning">{v.label}</span> : v.label
  }
  if ('street' in v || 'city' in v) {
    return [v.co, v.street, [v.postal_code, v.city].filter(Boolean).join(' ')].filter(Boolean).join(', ')
  }
  if ('code' in v) return String(v.code)
  if ('municipality_code' in v) return [v.municipality_code, v.county_code].filter(Boolean).join(' · ')
  return JSON.stringify(v)
}

function Row({ label, value, note }: { label: string; value: React.ReactNode; note?: React.ReactNode }) {
  return (
    <tr>
      <th className={`${VTH_CLASS} w-36`}>{label}</th>
      <td className={VTD_CLASS}>
        <div className="tabular-nums">{value}</div>
        {note ? <div className="text-xs text-muted-foreground">{note}</div> : null}
      </td>
    </tr>
  )
}

/**
 * Moment 3: the dossier. Money and booking knowledge come from the ledger;
 * "Vad Accounted vet" lists every fact with its source; promotion and
 * merge are one action each and always confirm up front.
 */
export function PartyDossier({
  partyId,
  period,
  canWrite,
  busy,
  onClose,
  onPromote,
  onDismiss,
  onMerge,
  onFetchRegistry,
  fetching = false,
  reloadKey,
}: {
  partyId: string | null
  period: RegisterPeriod
  canWrite: boolean
  busy: boolean
  onClose: () => void
  onPromote: (id: string, roles: PartyRole[]) => void
  onDismiss: (id: string) => void
  onMerge: (subject: MergeCandidate, suggested: MergeCandidate[]) => void
  /** Fetch registry facts from SCB for this party; undefined hides the button. */
  onFetchRegistry?: (id: string) => void
  fetching?: boolean
  reloadKey: number
}) {
  const t = useTranslations('parties')
  // { partyId, reloadKey } stamps the loaded dossier, so "loading" and
  // "failed" are derived instead of set from inside the effect.
  const [loaded, setLoaded] = useState<{ partyId: string; reloadKey: number; dossier: Dossier | null } | null>(null)
  const current = loaded && loaded.partyId === partyId && loaded.reloadKey === reloadKey ? loaded : null
  const dossier = partyId ? (current?.dossier ?? (loaded?.partyId === partyId ? loaded.dossier : null)) : null
  const loading = Boolean(partyId) && current === null
  const failed = Boolean(partyId) && current !== null && current.dossier === null

  useEffect(() => {
    if (!partyId) return
    let cancelled = false
    const key = reloadKey
    fetch(`/api/parties/${partyId}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status))
        const json = (await res.json()) as { data: Dossier }
        if (!cancelled) setLoaded({ partyId, reloadKey: key, dossier: json.data })
      })
      .catch(() => {
        if (!cancelled) setLoaded({ partyId, reloadKey: key, dossier: null })
      })
    return () => {
      cancelled = true
    }
  }, [partyId, reloadKey])

  const p = dossier?.party
  const stats = p?.stats ?? null
  const suggested = p?.status === 'suggested'
  const kicker = p ? (suggested ? t('dossier_kicker_suggested') : roleLabel(t, p.roles)) : ''
  const subtitle = stats
    ? [
        t('dossier_seen', { count: stats.occurrences }),
        rhythmLabel(t, stats.rhythm),
        stats.lastSeen ? t('dossier_last', { date: formatDate(stats.lastSeen) }) : '',
        stats.variants.length > 1 ? t('dossier_variants', { count: stats.variants.length }) : '',
      ]
        .filter(Boolean)
        .join(' · ')
    : ''
  const legalName = p?.legalName ?? (dossier?.facts.find((f) => f.field === 'legal_name')?.value as string | undefined) ?? null
  const orgFact = dossier?.facts.find((f) => f.field === 'org_number')
  const docsFor = (field: string) => {
    const f = dossier?.facts.find((x) => x.field === field)
    const n = (f?.reference as { docs?: number } | null)?.docs
    return n ? t('fact_from_documents', { count: n }) : f?.source === 'ledger' ? t('fact_from_ledger') : f?.source === 'user' ? t('fact_from_user') : ''
  }
  const dominant = dossier?.facts.find((f) => f.field === 'dominant_account')?.value as { account?: string; count?: number } | undefined

  return (
    <SlideOver open={Boolean(partyId)} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <SlideOverContent>
        <SlideOverHeader kicker={kicker} title={p?.displayName ?? (loading ? '…' : '')} />
        <SlideOverBody>
          {loading && !dossier ? (
            <div className="space-y-3">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : failed || !dossier || !p ? (
            <p className="text-sm text-muted-foreground">{t('load_failed')}</p>
          ) : (
            <div className="space-y-8">
              <div className="space-y-3">
                {subtitle ? <p className="text-[13px] text-muted-foreground">{subtitle}</p> : null}
                <div className="flex flex-wrap gap-2">
                  {suggested || !p.roles.supplierId ? (
                    <Button
                      type="button"
                      size="sm"
                      variant={p.defaultRoles.includes('supplier') ? 'default' : 'outline'}
                      onClick={() => onPromote(p.id, ['supplier'])}
                      disabled={!canWrite || busy}
                    >
                      {t('promote_supplier')}
                    </Button>
                  ) : null}
                  {suggested || !p.roles.customerId ? (
                    <Button
                      type="button"
                      size="sm"
                      variant={p.defaultRoles.includes('customer') && !p.defaultRoles.includes('supplier') ? 'default' : 'outline'}
                      onClick={() => onPromote(p.id, ['customer'])}
                      disabled={!canWrite || busy}
                    >
                      {t('promote_customer')}
                    </Button>
                  ) : null}
                  {onFetchRegistry && isLegalPersonOrgNumber(p.orgNumber) ? (
                    <Button type="button" size="sm" variant="outline" onClick={() => onFetchRegistry(p.id)} disabled={!canWrite || busy || fetching}>
                      {fetching ? t('fetching_registry') : t('fetch_registry')}
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!canWrite || busy}
                    onClick={() =>
                      onMerge(
                        { id: p.id, displayName: p.displayName, orgNumber: p.orgNumber, status: p.status },
                        dossier.similar.map((s) => ({ id: s.id, displayName: s.displayName, orgNumber: s.orgNumber, status: s.status })),
                      )
                    }
                  >
                    {t('merge')}
                  </Button>
                  {suggested ? (
                    <Button type="button" size="sm" variant="ghost" onClick={() => onDismiss(p.id)} disabled={!canWrite || busy}>
                      {t('dismiss')}
                    </Button>
                  ) : null}
                </div>
              </div>

              <section className="space-y-3">
                <SectionTitle>{t('section_money')}</SectionTitle>
                <table className="w-full text-[13px]">
                  <tbody>
                    {stats?.expenseSek || !stats?.revenueSek ? (
                      <Row
                        label={t('money_expense')}
                        value={formatCurrency(stats?.expenseSek ?? 0)}
                        note={period === '12m' ? t('money_period_12m') : t('money_period_all')}
                      />
                    ) : null}
                    {stats?.revenueSek ? (
                      <Row
                        label={t('money_revenue')}
                        value={formatCurrency(stats.revenueSek)}
                        note={period === '12m' ? t('money_period_12m') : t('money_period_all')}
                      />
                    ) : null}
                    {stats?.firstSeen ? <Row label={t('money_first')} value={formatDate(stats.firstSeen)} /> : null}
                    {stats?.lastSeen ? <Row label={t('money_last')} value={formatDate(stats.lastSeen)} /> : null}
                  </tbody>
                </table>
              </section>

              <section className="space-y-3">
                <SectionTitle>{t('section_bookkeeping')}</SectionTitle>
                <table className="w-full text-[13px]">
                  <tbody>
                    <Row
                      label={t('bk_account')}
                      value={<AccountNub account={stats?.dominantAccount ?? dominant?.account ?? null} />}
                      note={
                        stats?.dominantAccount && stats.occurrences
                          ? t('bk_account_share', {
                              count: Math.round((stats.dominantShare ?? 0) * (stats.occurrences + 2) - 1) || dominant?.count || 0,
                              total: stats.occurrences,
                            })
                          : undefined
                      }
                    />
                    <Row label={t('bk_when')} value={t('bk_when_value')} />
                  </tbody>
                </table>
              </section>

              <section className="space-y-3">
                <SectionTitle>{t('section_facts')}</SectionTitle>
                <table className="w-full text-[13px]">
                  <tbody>
                    <Row
                      label={t('fact_name')}
                      value={p.displayName}
                      note={stats && stats.variants.length > 1 ? stats.variants.slice(0, 3).join(', ') : undefined}
                    />
                    <Row label={t('fact_legal_name')} value={legalName ?? <span className="text-muted-foreground">{t('fact_missing')}</span>} note={legalName ? docsFor('legal_name') : undefined} />
                    <Row
                      label={t('fact_org')}
                      value={p.orgNumber ? formatOrgNumber(p.orgNumber) : <span className="text-muted-foreground">{t('fact_missing')}</span>}
                      note={p.orgNumber && orgFact ? docsFor('org_number') : undefined}
                    />
                    <Row label={t('fact_vat')} value={p.vatNumber ?? <span className="text-muted-foreground">{t('fact_missing')}</span>} />
                    {dossier.identities.map((i) => (
                      <Row
                        key={i.id}
                        label={i.scheme === 'bankgiro' ? t('fact_bankgiro') : i.scheme === 'plusgiro' ? t('fact_plusgiro') : i.scheme}
                        value={formatPaymentIdentity(i.scheme, i.value)}
                        note={`${t('fact_from_documents', { count: i.seenCount })} · ${i.status === 'known' ? t('identity_known') : t('identity_unverified')}`}
                      />
                    ))}
                    {registryFacts(dossier.facts).map((f) => (
                      <Row key={f.id} label={registryLabel(t, f.field)} value={registryValue(f.value)} note={`${t('source_scb')} · ${formatDate(f.fetchedAt ?? f.recordedAt)}`} />
                    ))}
                  </tbody>
                </table>
              </section>

              <section className="space-y-3">
                <SectionTitle>{t('section_vouchers')}</SectionTitle>
                {dossier.vouchers.length === 0 ? (
                  <p className="text-[13px] text-muted-foreground">{t('vouchers_none')}</p>
                ) : (
                  <table className="w-full text-[13px]">
                    <tbody>
                      {dossier.vouchers.map((v) => (
                        <tr key={v.id}>
                          <td className={`${VTD_CLASS} w-24 whitespace-nowrap text-muted-foreground tabular-nums`}>{formatDate(v.entryDate)}</td>
                          <td className={`${VTD_CLASS} truncate`}>
                            {v.voucher ? <span className="text-muted-foreground">{v.voucher} · </span> : null}
                            {v.description}
                          </td>
                          <td className={`${VTD_CLASS} text-right tabular-nums`}>{v.amount ? formatCurrency(v.amount) : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>

              {dossier.decisions.length > 0 ? (
                <section className="space-y-3">
                  <SectionTitle>{t('section_history')}</SectionTitle>
                  <table className="w-full text-[13px]">
                    <tbody>
                      {dossier.decisions.map((d) => (
                        <tr key={d.id}>
                          <td className={`${VTD_CLASS} w-24 whitespace-nowrap text-muted-foreground tabular-nums`}>{formatDate(d.createdAt)}</td>
                          <td className={VTD_CLASS}>
                            {['confirm', 'dismiss', 'merge', 'split', 'undo'].includes(d.kind) ? t(`decision_${d.kind}`) : d.kind}
                            {d.note ? <span className="text-muted-foreground"> · {d.note}</span> : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              ) : null}
            </div>
          )}
        </SlideOverBody>
      </SlideOverContent>
    </SlideOver>
  )
}
