'use client'

import { useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { ArrowUpTrayIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { INBOX_UPLOAD_ACCEPT } from '@/lib/documents/upload-types'
import { formatMegabytes, INBOX_MAX_UPLOAD_BYTES } from '@/lib/documents/upload-size'
import { uploadToInbox, type UploadOutcome } from './attach-underlag'

/**
 * Ladda upp, the page's primary action in the top bar: files chosen here
 * land in the Inkorg as uploads, one at a time over the inbox's own upload
 * (uploadToInbox, the calls the Underlag workspace makes), and show up under
 * Behöver dig once they are read. Nothing is matched to a purchase here:
 * a file for a purchase is dropped on that purchase under Saknar underlag.
 */
export function UploadButton({ onUploaded }: { onUploaded: () => Promise<void> }) {
  const t = useTranslations('inkorg')
  const locale = useLocale() === 'en' ? 'en' : 'sv'
  const { toast } = useToast()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)

  async function upload(files: File[]) {
    if (files.length === 0 || progress) return
    setProgress({ done: 0, total: files.length })
    const failures: Extract<UploadOutcome, { ok: false }>[] = []
    let uploaded = 0
    try {
      for (const file of files) {
        const outcome = await uploadToInbox(file, locale)
        if (outcome.ok) uploaded += 1
        else failures.push(outcome)
        setProgress((p) => (p ? { ...p, done: p.done + 1 } : p))
      }
    } finally {
      setProgress(null)
    }
    if (uploaded > 0) {
      toast({ title: t('uploaded', { count: uploaded }), description: t('uploaded_body', { count: uploaded }) })
      await onUploaded()
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

  return (
    <>
      {/* The inbox route's own list (lib/documents/upload-types), as the workspace's upload uses. */}
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
      <Button size="sm" onClick={() => inputRef.current?.click()} loading={progress !== null}>
        {progress === null && <ArrowUpTrayIcon aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />}
        {progress && progress.total > 1
          ? t('upload_progress', { index: Math.min(progress.done + 1, progress.total), total: progress.total })
          : progress
            ? t('uploading')
            : t('action_upload')}
      </Button>
    </>
  )
}
