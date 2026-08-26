'use client'

import { useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import { FileText, Loader2, Mail, Paperclip, Send, X } from 'lucide-react'
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
  SUPPORT_MAX_ATTACHMENT_TOTAL_MB,
  isSupportedAttachmentType,
} from '@/lib/support/attachments'
import { shrinkImageForUpload } from '@/lib/documents/shrink-image'
import { isShrinkableImage } from '@/lib/documents/upload-size'

interface SupportLinkProps {
  variant?: 'inline' | 'muted'
  subject?: string
  children?: React.ReactNode
  className?: string
}

type AttachmentError = 'unsupported' | 'too_many' | 'too_large'

function totalBytes(files: File[]): number {
  return files.reduce((sum, file) => sum + file.size, 0)
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
  const [attachments, setAttachments] = useState<File[]>([])
  const [isPreparing, setIsPreparing] = useState(false)
  const [isSending, setIsSending] = useState(false)
  const [sent, setSent] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const attachmentGenerationRef = useRef(0)
  const { toast } = useToast()
  const companyCtx = useCompanyOptional()

  if (companyCtx?.isSandbox) return null

  function showAttachmentError(error: AttachmentError) {
    if (error === 'unsupported') {
      toast({ title: t('attach_unsupported'), variant: 'destructive' })
      return
    }
    if (error === 'too_many') {
      toast({
        title: t('attach_too_many', { count: SUPPORT_MAX_ATTACHMENTS }),
        variant: 'destructive',
      })
      return
    }
    toast({
      title: t('attach_too_large', { limit: SUPPORT_MAX_ATTACHMENT_TOTAL_MB }),
      variant: 'destructive',
    })
  }

  async function addFiles(incoming: File[]) {
    if (!incoming.length || isPreparing || isSending) return

    const generation = attachmentGenerationRef.current
    setIsPreparing(true)
    try {
      const next = [...attachments]
      let firstError: AttachmentError | null = null

      for (const original of incoming) {
        if (!isSupportedAttachmentType(original.type)) {
          firstError ??= 'unsupported'
          continue
        }
        if (next.length >= SUPPORT_MAX_ATTACHMENTS) {
          firstError ??= 'too_many'
          break
        }

        const remaining = SUPPORT_MAX_ATTACHMENT_TOTAL_BYTES - totalBytes(next)
        const file = original.size > remaining && isShrinkableImage(original.type)
          ? await shrinkImageForUpload(original, remaining)
          : original

        if (file.size > remaining) {
          firstError ??= 'too_large'
          continue
        }
        next.push(file)
      }

      if (generation === attachmentGenerationRef.current) {
        setAttachments(next)
        if (firstError) showAttachmentError(firstError)
      }
    } finally {
      setIsPreparing(false)
    }
  }

  function resetAttachments() {
    attachmentGenerationRef.current += 1
    setAttachments([])
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (message.trim().length < 5) return

    setIsSending(true)
    const result = await submitFeedback({
      subject,
      message: message.trim(),
      files: attachments,
    })
    setIsSending(false)

    if (result.ok) {
      setSent(true)
      setTimeout(() => {
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
      setSent(false)
      setMessage('')
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
          <form onSubmit={handleSubmit}>
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

            {attachments.length > 0 ? (
              <ul className="mt-3 space-y-2">
                {attachments.map((file, index) => (
                  <li
                    key={`${file.name}-${file.size}-${index}`}
                    className="ph-no-capture flex min-w-0 items-center gap-2 rounded-lg border border-border px-3 py-1"
                  >
                    <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate text-xs">
                      {file.name}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => setAttachments((current) => current.filter((_, i) => i !== index))}
                      disabled={isSending || isPreparing}
                      aria-label={t('remove_attachment')}
                      className="shrink-0"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}

            <div className="mt-3 flex flex-col items-start gap-2 sm:flex-row sm:items-center">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={SUPPORT_ATTACHMENT_ACCEPT}
                className="hidden"
                disabled={isSending || isPreparing}
                onChange={(e) => {
                  void addFiles(Array.from(e.target.files ?? []))
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
                {isPreparing ? (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Paperclip className="mr-2 h-3.5 w-3.5" />
                )}
                {t('attach_label')}
              </Button>
              <span className="text-xs text-muted-foreground">
                {t('attach_hint', {
                  count: SUPPORT_MAX_ATTACHMENTS,
                  limit: SUPPORT_MAX_ATTACHMENT_TOTAL_MB,
                })}
              </span>
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
