'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import { Mail, Loader2, Send, Paperclip, X, FileText } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/components/ui/use-toast'
import { submitFeedback } from '@/lib/support/submit-feedback'
import { useCompanyOptional } from '@/contexts/CompanyContext'
import {
  SUPPORT_ATTACHMENT_ACCEPT,
  SUPPORT_MAX_ATTACHMENTS,
  SUPPORT_MAX_ATTACHMENT_TOTAL_BYTES,
  isSupportedAttachmentType,
} from '@/lib/support/attachments'
import { shrinkImageForUpload } from '@/lib/documents/shrink-image'
import { formatMegabytes, isShrinkableImage } from '@/lib/documents/upload-size'

interface SupportLinkProps {
  variant?: 'inline' | 'muted'
  subject?: string
  children?: React.ReactNode
  className?: string
}

/** An attachment plus the preview URL that has to be revoked when it goes. */
interface PendingAttachment {
  file: File
  previewUrl: string | null
}

function totalBytes(items: PendingAttachment[]): number {
  return items.reduce((sum, item) => sum + item.file.size, 0)
}

export function SupportLink({
  variant = 'inline',
  subject,
  children,
  className,
}: SupportLinkProps) {
  const t = useTranslations('support_link')
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [isPreparing, setIsPreparing] = useState(false)
  const [isSending, setIsSending] = useState(false)
  const [sent, setSent] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { toast } = useToast()
  const companyCtx = useCompanyOptional()

  // Object URLs outlive the render that made them. Removing a chip and
  // closing the dialog revoke their own; this covers the last case, unmounting
  // with attachments still pending. The ref is what makes the unmount cleanup
  // see the current list instead of the empty one it closed over.
  const attachmentsRef = useRef<PendingAttachment[]>([])
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Ingestion runs one batch at a time. Re-encoding a photo takes long enough
  // that a paste can land mid-shrink, and two overlapping runs would both
  // start from the pre-drop list and last-write-wins away one of the batches.
  const queueRef = useRef<Promise<void>>(Promise.resolve())
  useEffect(() => {
    attachmentsRef.current = attachments
  }, [attachments])
  useEffect(() => {
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
      attachmentsRef.current.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl))
    }
  }, [])

  if (companyCtx?.isSandbox) return null

  /**
   * Shared by the file picker, drag-drop and paste. Paste is the one that
   * matters most: a screenshot goes from Win+Shift+S straight into the
   * message without ever becoming a file on disk.
   */
  function addFiles(incoming: File[]) {
    if (!incoming.length || isSending) return queueRef.current
    queueRef.current = queueRef.current.then(() => ingestFiles(incoming))
    return queueRef.current
  }

  async function ingestFiles(incoming: File[]) {
    // Send stays disabled for as long as this runs: submitting mid-shrink
    // would mail the message without the file the user just watched land.
    setIsPreparing(true)
    const next = [...attachmentsRef.current]
    let rejectedType = false
    let rejectedCount = false
    let rejectedSize = false

    for (const raw of incoming) {
      if (!isSupportedAttachmentType(raw.type)) {
        rejectedType = true
        continue
      }
      if (next.length >= SUPPORT_MAX_ATTACHMENTS) {
        rejectedCount = true
        break
      }

      // A phone photo is routinely several times the whole budget. Re-encode
      // it to what is left rather than making the user shrink it themselves.
      const remaining = SUPPORT_MAX_ATTACHMENT_TOTAL_BYTES - totalBytes(next)
      const file = isShrinkableImage(raw.type)
        ? await shrinkImageForUpload(raw, remaining)
        : raw

      if (file.size > remaining) {
        rejectedSize = true
        continue
      }

      next.push({
        file,
        previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
      })
    }

    if (rejectedType) {
      toast({ title: t('attach_unsupported'), variant: 'destructive' })
    }
    if (rejectedCount) {
      toast({
        title: t('attach_too_many', { count: SUPPORT_MAX_ATTACHMENTS }),
        variant: 'destructive',
      })
    }
    if (rejectedSize) {
      toast({
        title: t('attach_too_large', {
          limit: formatMegabytes(SUPPORT_MAX_ATTACHMENT_TOTAL_BYTES),
        }),
        variant: 'destructive',
      })
    }

    attachmentsRef.current = next
    setAttachments(next)
    setIsPreparing(false)
  }

  function removeAttachment(index: number) {
    const target = attachmentsRef.current[index]
    if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl)
    const next = attachmentsRef.current.filter((_, i) => i !== index)
    attachmentsRef.current = next
    setAttachments(next)
  }

  function resetAttachments() {
    attachmentsRef.current.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl))
    attachmentsRef.current = []
    setAttachments([])
  }

  function handlePaste(e: React.ClipboardEvent) {
    const clipboard = e.clipboardData
    const pasted = Array.from(clipboard?.files ?? [])
    if (!pasted.length) return
    // Copying from Excel or Outlook puts a rendered bitmap on the clipboard
    // NEXT TO the text, so a file being present does not mean the user pasted
    // one. Text wins: swallowing a pasted invoice row would be worse than
    // making them use the attach button for that screenshot.
    const types = Array.from(clipboard?.types ?? [])
    if (types.includes('text/plain') || types.includes('text/html')) return
    e.preventDefault()
    void addFiles(pasted)
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setIsDragging(false)
    void addFiles(Array.from(e.dataTransfer?.files ?? []))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (message.trim().length < 5) return

    setIsSending(true)
    const result = await submitFeedback({
      subject,
      message: message.trim(),
      files: attachments.map((a) => a.file),
    })
    setIsSending(false)

    if (result.ok) {
      setSent(true)
      closeTimerRef.current = setTimeout(() => {
        setOpen(false)
        setSent(false)
        setMessage('')
        resetAttachments()
      }, 2000)
    } else {
      toast({
        title: t('send_failed_title'),
        description: result.error || t('send_failed_fallback'),
        variant: 'destructive',
      })
    }
  }

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (!next) {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
      setSent(false)
      setMessage('')
      setIsDragging(false)
      resetAttachments()
    }
  }

  const trigger =
    variant === 'muted' ? (
      <button
        type="button"
        className={cn(
          'inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer',
          className
        )}
      >
        <Mail className="h-3 w-3" />
        {children ?? t('default_label')}
      </button>
    ) : (
      <button
        type="button"
        className={cn(
          'inline-flex items-center gap-1 text-primary hover:text-primary/80 underline-offset-4 hover:underline transition-colors text-sm cursor-pointer',
          className
        )}
      >
        {children ?? t('default_label')}
      </button>
    )

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('dialog_title')}</DialogTitle>
          <DialogDescription>
            {t('dialog_description')}
          </DialogDescription>
        </DialogHeader>

        {sent ? (
          <div className="flex flex-col items-center py-6 gap-3">
            <div className="p-3 rounded-full bg-success/10">
              <Send className="h-6 w-6 text-success" />
            </div>
            <p className="text-sm font-medium">{t('thanks')}</p>
          </div>
        ) : (
          <form
            onSubmit={handleSubmit}
            onPaste={handlePaste}
            onDragOver={(e) => {
              e.preventDefault()
              setIsDragging(true)
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            className={cn(
              'rounded-lg transition-colors',
              isDragging && 'ring-2 ring-primary ring-offset-2 ring-offset-background'
            )}
          >
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={t('placeholder')}
              className="min-h-[120px] resize-none"
              maxLength={5000}
              disabled={isSending}
              autoFocus
            />
            <p className="text-xs text-muted-foreground mt-1.5">
              {t('char_count', { count: message.length })}
            </p>

            {attachments.length > 0 && (
              <ul className="mt-3 flex flex-wrap gap-2">
                {attachments.map((attachment, index) => (
                  <li
                    key={`${attachment.file.name}-${index}`}
                    className="relative flex items-center gap-2 rounded-full border bg-muted/40 py-1 pl-1 pr-7 max-w-full"
                  >
                    {attachment.previewUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={attachment.previewUrl}
                        alt=""
                        className="h-8 w-8 rounded-full object-cover"
                      />
                    ) : (
                      <FileText className="h-8 w-8 p-1.5 text-muted-foreground" aria-hidden />
                    )}
                    <span className="truncate text-xs max-w-[10rem]" title={attachment.file.name}>
                      {attachment.file.name}
                    </span>
                    <span className="text-[10px] text-muted-foreground shrink-0">
                      {formatMegabytes(attachment.file.size)}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeAttachment(index)}
                      disabled={isSending}
                      aria-label={t('remove_attachment')}
                      className="absolute right-1 top-1/2 -translate-y-1/2 rounded-full p-0.5 text-muted-foreground hover:text-foreground cursor-pointer"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-3 flex items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={SUPPORT_ATTACHMENT_ACCEPT}
                className="hidden"
                onChange={(e) => {
                  void addFiles(Array.from(e.target.files ?? []))
                  // Reset so picking the same file twice still fires onChange.
                  e.target.value = ''
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isSending || isPreparing || attachments.length >= SUPPORT_MAX_ATTACHMENTS}
                onClick={() => fileInputRef.current?.click()}
              >
                <Paperclip className="mr-2 h-3.5 w-3.5" />
                {t('attach_label')}
              </Button>
              <span className="text-xs text-muted-foreground">{t('attach_hint')}</span>
            </div>

            <DialogFooter className="mt-4">
              <Button
                type="button"
                variant="ghost"
                onClick={() => handleOpenChange(false)}
                disabled={isSending}
              >
                {t('cancel')}
              </Button>
              <Button
                type="submit"
                disabled={isSending || isPreparing || message.trim().length < 5}
              >
                {isSending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t('sending')}
                  </>
                ) : (
                  <>
                    <Send className="mr-2 h-4 w-4" />
                    {t('send')}
                  </>
                )}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
