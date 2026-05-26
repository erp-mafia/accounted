'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import { Mail, Loader2, Send } from 'lucide-react'
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

interface SupportLinkProps {
  variant?: 'inline' | 'muted'
  subject?: string
  children?: React.ReactNode
  className?: string
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
  const [isSending, setIsSending] = useState(false)
  const [sent, setSent] = useState(false)
  const { toast } = useToast()
  const companyCtx = useCompanyOptional()

  if (companyCtx?.isSandbox) return null

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (message.trim().length < 5) return

    setIsSending(true)
    const result = await submitFeedback({ subject, message: message.trim() })
    setIsSending(false)

    if (result.ok) {
      setSent(true)
      setTimeout(() => {
        setOpen(false)
        setSent(false)
        setMessage('')
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
            <DialogFooter className="mt-4">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setOpen(false)}
                disabled={isSending}
              >
                {t('cancel')}
              </Button>
              <Button
                type="submit"
                disabled={isSending || message.trim().length < 5}
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
