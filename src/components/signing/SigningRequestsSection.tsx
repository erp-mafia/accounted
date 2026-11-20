'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Section } from '@/components/arkiv/DefList'
import type { SigningRequestView } from '@/lib/signing/requests'
import { SigningRequestCard } from './SigningRequestCard'
import { getSigningRequest, listSigningRequests } from './signing-client'

/**
 * The Signering section of an Arkiv record: every request over the document
 * (or that produced it, on a signed copy or an evidence package), newest
 * first. Rendered only once there is one; `reloadKey` reads them again after
 * a new request was sent from the record's header.
 */
export function SigningRequestsSection({ documentId, available, reloadKey = 0 }: { documentId: string; available: boolean; reloadKey?: number }) {
  const t = useTranslations('signing')
  const [requests, setRequests] = useState<SigningRequestView[] | null>(null)

  const load = useCallback(async () => {
    const list = await listSigningRequests({ documentId })
    // A completed request whose signed copy never landed is sealed by its own read: ask once, show what it answers.
    return Promise.all(
      list.map((r) =>
        r.state === 'completed' && (!r.signed_document_id || !r.evidence_document_id) ? getSigningRequest(r.signing_request_id).catch(() => r) : r,
      ),
    )
  }, [documentId])

  const reload = useCallback(() => {
    load().then(setRequests, () => undefined)
  }, [load])

  useEffect(() => {
    let cancelled = false
    load().then(
      (list) => {
        if (!cancelled) setRequests(list)
      },
      () => {
        // A section that cannot be read stays away; the document itself is unaffected.
        if (!cancelled) setRequests([])
      },
    )
    return () => {
      cancelled = true
    }
  }, [load, reloadKey])

  if (!requests || requests.length === 0) return null
  return (
    <Section title={t('section_title')} help={t('section_help')}>
      <div className="stagger-enter space-y-6">
        {requests.map((r) => (
          <SigningRequestCard key={r.signing_request_id} request={r} available={available} onChanged={reload} />
        ))}
      </div>
    </Section>
  )
}
