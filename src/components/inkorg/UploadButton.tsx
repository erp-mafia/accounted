'use client'

import { useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { ArrowUpTrayIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { INBOX_UPLOAD_ACCEPT } from '@/lib/documents/upload-types'
import { formatMegabytes, INBOX_MAX_UPLOAD_BYTES } from '@/lib/documents/upload-size'
import { formatDateLong } from '@/lib/utils'
import { uploadToInbox, type UploadDuplicate, type UploadOutcome } from './attach-underlag'

/**
 * Ladda upp, the page's primary action in the top bar: files chosen here
 * land in the Inkorg as uploads, one at a time over the inbox's own upload
 * (uploadToInbox, the calls the Underlag workspace makes), and show up under
 * Behöver dig once they are read. Nothing is matched to a purchase here:
 * a file for a purchase is dropped on that purchase under Saknar underlag.
 * A file the company already had is not filed again: it joins the item that
 * came in first, and the toast says where that one is (PH 225), since a
 * booked item never shows under Behöver dig.
 *
 * A large selection outruns the inbox's per-minute upload limit: the file
 * that meets it waits for the limit to reset and is sent again, and the
 * button says it is waiting. A file still refused after waiting stops the
 * rest, with one message saying how many were not uploaded and why. The
 * page shows one toast at a time, so that message is the last one shown.
 */
export function UploadButton({ onUploaded }: { onUploaded: () => Promise<void> }) {
  const t = useTranslations('inkorg')
  const { input, pick, progress, label } = useInboxUpload(onUploaded)
  return (
    <>
      {input}
      <Button onClick={pick} loading={progress !== null}>
        {progress === null && <ArrowUpTrayIcon aria-hidden="true" className="h-3.5 w-3.5" />}
        {label ?? t('action_upload')}
      </Button>
    </>
  )
}

/**
 * The upload behind the button, without the button: the hidden file input to
 * render, `pick` to open it (from a click, so the browser allows the file
 * dialog), and what a button says while files go up (`label`, null at rest).
 * The shell's "Ladda upp underlag" (the Att göra and Dokument areas, the
 * rail's plus) uses it from any page, so an upload there is this same upload.
 */
export function useInboxUpload(onUploaded: () => Promise<void>) {
  const t = useTranslations('inkorg')
  // The waiting and stopped wording is the Underlag workspace's, so both uploads say it alike.
  const tUpload = useTranslations('inbox_workspace')
  const locale = useLocale() === 'en' ? 'en' : 'sv'
  const { toast } = useToast()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [waitSec, setWaitSec] = useState<number | null>(null)

  async function upload(files: File[]) {
    if (files.length === 0 || progress) return
    setProgress({ done: 0, total: files.length })
    const failures: Extract<UploadOutcome, { ok: false }>[] = []
    const duplicates: UploadDuplicate[] = []
    let uploaded = 0
    // Set when the upload limit still refuses after waiting: this file and the rest are not uploaded.
    let stopped: { count: number; message: string } | null = null
    try {
      for (const [index, file] of files.entries()) {
        const outcome = await uploadToInbox(file, locale, { onWait: setWaitSec })
        if (!outcome.ok && outcome.reason === 'failed' && outcome.limited) {
          stopped = { count: files.length - index, message: outcome.message }
          break
        }
        if (!outcome.ok) failures.push(outcome)
        else if (outcome.duplicateOf) duplicates.push(outcome.duplicateOf)
        else uploaded += 1
        setProgress((p) => (p ? { ...p, done: p.done + 1 } : p))
      }
    } finally {
      setProgress(null)
      setWaitSec(null)
    }
    if (uploaded > 0) {
      toast({ title: t('uploaded', { count: uploaded }), description: t('uploaded_body', { count: uploaded }) })
    }
    const duplicate = duplicates[0]
    if (duplicate) {
      const when = duplicate.receivedAt ? formatDateLong(duplicate.receivedAt, locale) : null
      toast({
        title: t('upload_duplicate', { count: duplicates.length }),
        description:
          duplicates.length > 1
            ? t('upload_duplicate_many_body')
            : when
              ? t(`upload_duplicate_${duplicate.state}`, { date: when })
              : t(`upload_duplicate_${duplicate.state}_undated`),
      })
    }
    if (uploaded > 0 || duplicates.length > 0) await onUploaded()
    // The page shows one toast at a time: a stopped upload is the message that
    // stays, counting every file that did not go in (any earlier failure too),
    // with the limit's reason, which says when to try again.
    if (stopped) {
      toast({
        title: tUpload('upload_queue_stopped_title'),
        description: [tUpload('upload_queue_stopped_description', { count: stopped.count + failures.length }), stopped.message]
          .filter(Boolean)
          .join(' '),
        variant: 'destructive',
      })
      return
    }
    // One toast for what failed, naming the first reason: the others are almost always the same one.
    const first = failures[0]
    if (first) {
      toast({
        title: failures.length === 1 ? t('attach_failed') : t('upload_failed_some', { count: failures.length }),
        description:
          first.reason === 'too_large'
            ? t('attach_too_large', { size: formatMegabytes(first.size), limit: formatMegabytes(INBOX_MAX_UPLOAD_BYTES) })
            : first.message,
        variant: 'destructive',
      })
    }
  }

  const input = (
    // The inbox route's own list (lib/documents/upload-types), as the workspace's upload uses.
    <input
      ref={inputRef}
      type="file"
      multiple
      accept={INBOX_UPLOAD_ACCEPT}
      className="hidden"
      onChange={(e) => {
        const files = Array.from(e.target.files ?? [])
        e.target.value = ''
        void upload(files)
      }}
    />
  )
  const label =
    waitSec !== null
      ? tUpload('upload_waiting', { seconds: waitSec })
      : progress && progress.total > 1
        ? t('upload_progress', { index: Math.min(progress.done + 1, progress.total), total: progress.total })
        : progress
          ? t('uploading')
          : null
  return { input, pick: () => inputRef.current?.click(), progress, label }
}
