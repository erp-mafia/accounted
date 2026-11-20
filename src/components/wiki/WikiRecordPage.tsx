'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { EmptyState, LoadError } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/ui/page-header'
import { LateReveal, Skeleton } from '@/components/ui/skeleton'
import { useCompany } from '@/contexts/CompanyContext'
import { useFormat } from '@/lib/hooks/use-format'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { isLinkBasis } from '@/lib/links/link-basis'
import { DOC_TYPES } from '@/lib/documents/classify/taxonomy'
import { cn, formatDate } from '@/lib/utils'
import {
  isRecordId,
  isWikiRecordKind,
  type RecordField,
  type RecordLink,
  type RecordMaintainer,
  type WikiRecordKind,
  type WikiRecordView,
} from '@/lib/agent-context/wiki-record'
import { RawText, ScopeStack } from './wiki-parts'

type LoadState =
  | { state: 'loading' }
  | { state: 'ok'; record: WikiRecordView; text: string }
  | { state: 'failed'; description: string }
  | { state: 'missing'; sentence: string }

/** Relations and bases the page names in words (wiki.record.relations / .bases); others show as sent. */
const RELATIONS = new Set(['underlag', 'verifikat', 'bank_row', 'invoice_payment', 'supplier_invoice_payment', 'settlement', 'agreement', 'counterparty', 'source_document', 'document', 'linked'])
/** Kinds of linked records the page names in words (wiki.record.target_kinds). */
const TARGET_KINDS = new Set(['document', 'journal_entry', 'agreement', 'party', 'fact', 'transaction', 'invoice', 'supplier_invoice', 'skattekonto_transaction', 'ledger_settlement'])
const DECIDERS = new Set(['user', 'api_key', 'mcp_oauth', 'cron', 'system', 'agent_chat', 'service_account'])
/** Fields that hold a date: shown as dates, not as the raw timestamp. */
const DATE_FIELDS = new Set(['entry_date', 'received', 'starts_on', 'ends_on', 'valid_from'])
const NUMERIC_FIELDS = new Set(['amount', 'page_count'])
/** Fields that hold a stored state or kind the page names in words (wiki.record.values). */
const CODED_FIELDS = new Set(['admission_state', 'status', 'party_kind'])

/**
 * One record in the wiki: what an agent reads when it opens the record with
 * gnubok_get_record (GET /api/wiki/records/<kind>/<id>). The title in the top
 * bar with the wiki as its parent and the record_ref beside it, the fields
 * with their source, the links grouped by relation with the basis each was
 * made on (a link opens the other record), who kept it current, and the raw
 * answer the agent reads.
 */
export function WikiRecordPage({ kind, id }: { kind: string; id: string }) {
  const t = useTranslations('wiki')
  const locale = useLocale() as ErrorLocale
  const { company } = useCompany()
  const valid = isWikiRecordKind(kind) && isRecordId(id)
  const [load, setLoad] = useState<LoadState>(valid ? { state: 'loading' } : { state: 'missing', sentence: t('record.not_found') })

  const fetchRecord = useCallback(async () => {
    if (!valid) return
    setLoad({ state: 'loading' })
    try {
      const res = await fetch(`/api/wiki/records/${kind}/${id}`)
      const body = (await res.json().catch(() => null)) as { data?: { record: WikiRecordView; text: string }; error?: { code?: string } } | null
      if (res.ok && body?.data) {
        setLoad({ state: 'ok', record: body.data.record, text: body.data.text })
        return
      }
      const code = body?.error?.code
      if (res.status === 404 || res.status === 400) {
        setLoad({
          state: 'missing',
          sentence: code === 'ARKIV_NOT_ENABLED' ? t('record.not_enabled') : code === 'AGENT_CONTEXT_UNAVAILABLE' ? t('unavailable') : t('record.not_found'),
        })
        return
      }
      setLoad({ state: 'failed', description: getErrorMessage(body, { locale, statusCode: res.status }) })
    } catch (err) {
      setLoad({ state: 'failed', description: getErrorMessage(err, { locale }) })
    }
  }, [valid, kind, id, locale, t])

  useEffect(() => {
    void fetchRecord()
  }, [fetchRecord])

  const kindLabel = valid ? t(`record.kinds.${kind as WikiRecordKind}`) : t('title')
  const parent = { label: t('record.parent'), href: '/wiki' }

  if (load.state !== 'ok') {
    return (
      <div className="space-y-8">
        <PageHeader title={kindLabel} parent={parent} />
        {load.state === 'loading' && <RecordSkeleton />}
        {load.state === 'failed' && <LoadError title={t('record.load_failed_title')} description={load.description} onRetry={() => void fetchRecord()} />}
        {load.state === 'missing' && <EmptyState title={load.sentence} actionLabel={t('record.back')} actionHref="/wiki" />}
      </div>
    )
  }

  const { record, text } = load
  const title = record.title ?? t('record.untitled')
  return (
    <div className="space-y-8">
      <PageHeader
        title={<span data-ph-mask="">{title}</span>}
        parent={parent}
        meta={<span className="font-mono text-xs">{record.record_ref}</span>}
        action={
          record.native_href ? (
            <Button size="toolbar" variant="outline" asChild>
              {record.kind === 'document' ? (
                <a href={record.native_href} target="_blank" rel="noreferrer">
                  {t(`record.open_native.${record.kind}`)}
                </a>
              ) : (
                <Link href={record.native_href}>{t(`record.open_native.${record.kind as 'journal_entry' | 'agreement'}`)}</Link>
              )}
            </Button>
          ) : undefined
        }
      />

      <ScopeStack
        levels={[
          ...(company?.name ? [{ level: 'company' as const, name: company.name }] : []),
          { level: 'record' as const, name: title, detail: kindLabel },
        ]}
      />

      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-8">
          <FieldsSection fields={record.fields} />
          <LinksSection links={record.links} unavailable={record.links_unavailable} />
        </div>
        <aside className="min-w-0 space-y-8">
          <MaintainerSection maintainer={record.maintainer} />
        </aside>
      </div>

      <RawText text={text} subject="record" />
    </div>
  )
}

function RecordSkeleton() {
  return (
    <LateReveal>
      <div className="space-y-3" aria-busy>
        {[1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-11 w-full" />
        ))}
      </div>
    </LateReveal>
  )
}

function SectionHead({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="-mx-2 border-b-hairline px-2 pb-2 text-[13px] font-medium text-strong">
      {children}
    </h2>
  )
}

function FieldsSection({ fields }: { fields: RecordField[] }) {
  const t = useTranslations('wiki')
  const tArkiv = useTranslations('arkiv')
  const { formatDateLong } = useFormat()
  // Stored codes in words: the archive's own type names, the wiki's for the states.
  const fieldValue = (f: RecordField): string => {
    if (f.label === 'doc_type' && (DOC_TYPES as readonly string[]).includes(f.value)) return tArkiv(`types.${f.value}`)
    if (f.label === 'agreement_kind' && tArkiv.has(`types.agreement.${f.value}`)) return tArkiv(`types.agreement.${f.value}`)
    if (CODED_FIELDS.has(f.label) && t.has(`record.values.${f.value}`)) return t(`record.values.${f.value}`)
    return f.value
  }
  if (fields.length === 0) return null
  return (
    <section aria-labelledby="wiki-record-fields">
      <SectionHead id="wiki-record-fields">{t('record.fields_title')}</SectionHead>
      <dl className="-mx-2">
        {fields.map((f) => (
          <div key={f.label} className="grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 border-b-hairline px-2 py-2.5 text-[13px] last:border-b-0">
            <div className="grid min-w-0 gap-x-4 gap-y-0.5 sm:grid-cols-[170px_minmax(0,1fr)]">
              <dt className="text-muted-foreground">{t(`record.fields.${f.label}`)}</dt>
              <dd className={cn('min-w-0 break-words', DATE_FIELDS.has(f.label) ? 'date-figures' : NUMERIC_FIELDS.has(f.label) && 'tabular-nums')} data-ph-mask="">
                {DATE_FIELDS.has(f.label) ? (f.label === 'received' ? formatDateLong(f.value) : formatDate(f.value)) : fieldValue(f)}
              </dd>
            </div>
            <span className="text-xs text-muted-foreground">{t(`sources.${f.source}`)}</span>
          </div>
        ))}
      </dl>
    </section>
  )
}

function LinksSection({ links, unavailable }: { links: RecordLink[]; unavailable: boolean }) {
  const t = useTranslations('wiki')
  const groups = new Map<string, RecordLink[]>()
  for (const l of links) groups.set(l.relation, [...(groups.get(l.relation) ?? []), l])
  return (
    <section aria-labelledby="wiki-record-links" className="space-y-2">
      <SectionHead id="wiki-record-links">{t('record.links_title')}</SectionHead>
      {unavailable && <div className="py-2 text-[13px] text-muted-foreground">{t('record.links_unavailable')}</div>}
      {links.length === 0 && !unavailable && <div className="py-2 text-[13px] text-muted-foreground">{t('record.links_none')}</div>}
      {[...groups.entries()].map(([relation, list]) => (
        <div key={relation}>
          <div className="flex h-8 items-center gap-2 text-xs font-medium text-muted-foreground">
            {RELATIONS.has(relation) ? t(`record.relations.${relation}`) : relation}
            <span className="tabular-nums">· {list.length}</span>
          </div>
          <ul className="-mx-2">
            {list.map((l, i) => (
              <LinkRow key={`${l.target_kind}-${l.target_id ?? i}`} link={l} />
            ))}
          </ul>
        </div>
      ))}
    </section>
  )
}

function LinkRow({ link }: { link: RecordLink }) {
  const t = useTranslations('wiki')
  const kind = TARGET_KINDS.has(link.target_kind) ? t(`record.target_kinds.${link.target_kind}`) : null
  const name = link.label ?? kind ?? link.target_kind
  const basis = link.basis ? (isLinkBasis(link.basis) ? t(`record.bases.${link.basis}`) : link.basis) : t('record.bases.none')
  return (
    <li className="group grid min-h-11 grid-cols-1 items-center gap-x-4 gap-y-0.5 border-b-hairline px-2 py-2.5 text-[13px] transition-colors duration-150 last:border-b-0 hover:bg-secondary/35 sm:grid-cols-[minmax(0,1fr)_auto]">
      <span className="min-w-0 truncate">
        {link.href ? (
          <Link href={link.href} className="text-foreground underline decoration-foreground/25 underline-offset-[3px] hover:decoration-foreground/60" data-ph-mask="">
            {name}
          </Link>
        ) : (
          <span data-ph-mask="">{name}</span>
        )}
        {link.target_id && !link.label ? <span className="ml-2 font-mono text-xs text-muted-foreground">{link.target_id.slice(0, 8)}</span> : null}
        {link.duplicate ? <span className="ml-2 text-xs text-muted-foreground">{t('record.duplicate')}</span> : null}
      </span>
      <span className="text-xs text-muted-foreground sm:text-right">{basis}</span>
    </li>
  )
}

function MaintainerSection({ maintainer }: { maintainer: RecordMaintainer | null }) {
  const t = useTranslations('wiki')
  const { formatDateLong } = useFormat()
  return (
    <section aria-labelledby="wiki-record-maintained">
      <SectionHead id="wiki-record-maintained">{t('record.maintained_title')}</SectionHead>
      {!maintainer ? (
        <div className="py-3 text-[13px] text-muted-foreground">{t('record.maintained_none')}</div>
      ) : (
        <div className="space-y-1 py-3 text-[13px]">
          {maintainer.proposed_by && (
            <div className="text-strong" data-ph-mask="">
              {maintainer.proposed_by.label
                ? t('record.proposed_by', {
                    who: maintainer.proposed_by.model
                      ? t('record.proposed_model', { who: maintainer.proposed_by.label, model: maintainer.proposed_by.model })
                      : maintainer.proposed_by.label,
                  })
                : t('record.proposed_by_unknown')}
            </div>
          )}
          <div className="text-xs text-muted-foreground">
            {maintainer.decided_at ? t('record.decided', { date: formatDateLong(maintainer.decided_at) }) : null}{' '}
            {DECIDERS.has(maintainer.decided_by.actor_type) ? t(`record.decided_by.${maintainer.decided_by.actor_type}`) : maintainer.decided_by.actor_type}
            {maintainer.decided_by.label ? <span data-ph-mask=""> ({maintainer.decided_by.label})</span> : null}
          </div>
          {maintainer.agent_reason && (
            <div className="text-xs text-muted-foreground" data-ph-mask="">
              {t('record.agent_reason', { reason: maintainer.agent_reason })}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
