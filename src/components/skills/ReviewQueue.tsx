'use client'

import { useState } from 'react'
import Link from 'next/link'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { ArrowLeft, ArrowUpRight, ShieldAlert } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import type { PendingItem, ReviewSubmission } from '@/lib/agent-skills/community-review'
import { COMMUNITY_REPO } from '@/lib/agent-skills/community-repo'
import styles from './skills.module.css'

type ReviewData = { submissions: ReviewSubmission[]; pending: PendingItem[] }

async function readReview(url: string): Promise<ReviewData> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return (await response.json()).data as ReviewData
}

/**
 * Accounted's review list. Shared own items, as the exact file that would be
 * published: opening one as a pull request (GitHub's editor, filled in, as
 * the reviewer) also approves that exact text, or send it back with a reason
 * the author sees. And merged texts no reviewer approved yet (edited on
 * GitHub, or contributed there): nothing reaches an AI until approved here.
 */
export function ReviewQueue() {
  const t = useTranslations('skills_registry')
  const list = useSWR('/api/community/submissions', readReview)
  return (
    <div className={styles.apage}>
      <PageHeader title={t('review_title')} />
      <Link href="/skills" className={styles.back}><ArrowLeft className="h-4 w-4" aria-hidden />{t('back_to_agents')}</Link>
      <p className={styles.muted}>{t('review_lede', { repo: COMMUNITY_REPO })}</p>
      {list.error && <p role="alert" className={styles.muted}>{t('load_failed')}</p>}
      {list.data && list.data.submissions.length === 0 && list.data.pending.length === 0 && <div className={styles.placeEmpty}>{t('review_empty')}</div>}
      {(list.data?.submissions.length ?? 0) > 0 && (
        <section className={styles.catSection}>
          <div className={styles.catHead}><h2>{t('review_submissions')}</h2></div>
          <ul className={styles.reviewList}>
            {list.data!.submissions.map((s) => <Submission key={s.id} submission={s} onDone={() => void list.mutate()} />)}
          </ul>
        </section>
      )}
      {(list.data?.pending.length ?? 0) > 0 && (
        <section className={styles.catSection}>
          <div className={styles.catHead}><h2>{t('review_pending')}</h2></div>
          <p className={styles.muted}>{t('review_pending_lede')}</p>
          <ul className={styles.reviewList}>
            {list.data!.pending.map((p) => <Pending key={p.slug} item={p} onDone={() => void list.mutate()} />)}
          </ul>
        </section>
      )}
    </div>
  )
}

function Submission({ submission: s, onDone }: { submission: ReviewSubmission; onDone: () => void }) {
  const t = useTranslations('skills_registry')
  const [copied, setCopied] = useState(false)
  const [sendBack, setSendBack] = useState(false)
  const [reason, setReason] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'failed'>('idle')

  // Opening it as a pull request approves this exact file: merged unchanged, the sync publishes it.
  function approve() {
    void fetch(`/api/community/submissions/${s.id}/approve`, { method: 'POST', keepalive: true })
  }
  async function copy() {
    approve()
    try { await navigator.clipboard.writeText(s.skill_md); setCopied(true) } catch { setCopied(false) }
  }
  async function submitSendBack() {
    setState('sending')
    const response = await fetch(`/api/community/submissions/${s.id}/send-back`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: reason.trim() }) })
    if (response.ok) { onDone(); return }
    setState('failed')
  }

  return (
    <li className={styles.reviewItem}>
      <div className={styles.reviewHead}>
        <div>
          <b>{s.title}</b>
          <small className={styles.muted}>{t(`kind_one_${s.kind}`)} · @{s.author} · community/{s.slug}</small>
        </div>
      </div>
      {s.privacy.length > 0 && (
        <p className={styles.reviewAlert} role="alert">
          <ShieldAlert className="h-4 w-4" aria-hidden />
          {t('review_privacy', { found: s.privacy.map((p) => `${t(`review_privacy_kinds.${p.kind}`)}: ${p.sample}`).join(', ') })}
        </p>
      )}
      <pre className={styles.reviewFile} data-ph-mask="">{s.skill_md}</pre>
      <div className="flex flex-wrap items-center gap-2">
        {s.github_url
          ? <Button asChild size="sm" className="gap-2"><a href={s.github_url} target="_blank" rel="noreferrer" onClick={approve}>{t('review_open_pr')}<ArrowUpRight className="h-4 w-4" aria-hidden /></a></Button>
          : <span className={styles.muted}>{t('review_too_long')}</span>}
        <Button size="sm" variant="outline" onClick={() => void copy()}>{t(copied ? 'copied' : 'review_copy')}</Button>
        <Button size="sm" variant="outline" onClick={() => setSendBack(!sendBack)}>{t('review_send_back')}</Button>
      </div>
      {sendBack && (
        <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); if (reason.trim().length >= 3) void submitSendBack() }}>
          <textarea className={styles.textEdit} rows={3} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder={t('review_reason_placeholder')} aria-label={t('review_reason')} />
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={reason.trim().length < 3} loading={state === 'sending'}>{t('review_send_back_confirm')}</Button>
            {state === 'failed' && <span role="alert" className={styles.muted}>{t('save_failed')}</span>}
          </div>
        </form>
      )}
    </li>
  )
}

function Pending({ item, onDone }: { item: PendingItem; onDone: () => void }) {
  const t = useTranslations('skills_registry')
  const [state, setState] = useState<'idle' | 'sending' | 'failed' | 'changed'>('idle')
  async function publish() {
    setState('sending')
    const response = await fetch(`/api/community/items/${item.slug}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sha: item.sha }) })
    if (response.ok) { onDone(); return }
    setState(response.status === 409 ? 'changed' : 'failed')
  }
  return (
    <li className={styles.reviewItem}>
      <div className={styles.reviewHead}>
        <div>
          <b>{item.title}</b>
          <small className={styles.muted}>{t(`kind_one_${item.kind}`)}{item.author ? ` · @${item.author}` : ''} · community/{item.slug}</small>
        </div>
      </div>
      {item.privacy.length > 0 && (
        <p className={styles.reviewAlert} role="alert">
          <ShieldAlert className="h-4 w-4" aria-hidden />
          {t('review_privacy', { found: item.privacy.map((p) => `${t(`review_privacy_kinds.${p.kind}`)}: ${p.sample}`).join(', ') })}
        </p>
      )}
      <pre className={styles.reviewFile} data-ph-mask="">{item.body}</pre>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" loading={state === 'sending'} onClick={() => void publish()}>{t('review_approve')}</Button>
        <Button asChild size="sm" variant="outline" className="gap-2"><a href={item.source} target="_blank" rel="noreferrer">{t('review_view_source')}<ArrowUpRight className="h-4 w-4" aria-hidden /></a></Button>
        {state === 'failed' && <span role="alert" className={styles.muted}>{t('save_failed')}</span>}
        {state === 'changed' && <span role="alert" className={styles.muted}>{t('review_changed')}</span>}
      </div>
    </li>
  )
}
