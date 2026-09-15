'use client'

import { useState, type MouseEvent } from 'react'
import { useTranslations } from 'next-intl'
import { ChevronDown, Copy, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useCompany } from '@/contexts/CompanyContext'
import { AI_CLIENTS, aiChatLink, pickConnectedAiClient, type AiClient } from '@/lib/onboarding/ai-clients'
import type { AiTask } from '@/lib/worklist/ai-task'

const pillClass =
  'inline-flex h-6 shrink-0 items-center gap-2 rounded-full bg-primary px-3 text-[11.5px] text-primary-foreground transition-colors duration-150 hover:bg-primary/85 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

/**
 * "Gör i Claude": the pill on an Att göra row that hands that row to a
 * connected AI client. Same pill on Hem and in the books act's Klart step.
 *
 * Renders nothing while no client is connected: the connect offer is the
 * kopplingar row on Hem and the client chips in the Klart step, never a
 * pill on every row. With several clients connected the pill leads with
 * the preferred (or first) one and a caret picks another.
 *
 * The click opens a dialog with the prompt: the user copies it, then
 * "Fortsätt till Claude" opens an empty chat where they paste. Company data
 * never enters an external URL, which is why the prompt travels via the
 * clipboard and not a query string.
 */
export function AiTaskAction({
  clients,
  task,
  preferredClient,
  onOpen,
  disabled = false,
}: {
  clients: AiClient[]
  task: AiTask
  preferredClient?: AiClient
  /** Called when the chat opens: the Klart step marks the act done here. */
  onOpen?: () => void
  disabled?: boolean
}) {
  const t = useTranslations('dashboard')
  const { company } = useCompany()
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const [handoffClient, setHandoffClient] = useState<AiClient | null>(null)

  const connected = AI_CLIENTS.filter((c) => clients.includes(c.id))
  if (connected.length === 0 || !company) return null

  // The OAuth connection follows the user and may have been made for another
  // company, so the prompt names the company being handed off.
  const prompt = `${t('ai_task_company', { name: company.name, id: company.id })}\n\n${t(`ai_task_${task.category}`, { count: task.count })}`
  const primaryId = pickConnectedAiClient(clients, preferredClient)
  const primary = connected.find((client) => client.id === primaryId)!
  const others = connected.filter((client) => client.id !== primaryId)
  const selected = connected.find((client) => client.id === handoffClient)

  function open(client: AiClient) {
    if (disabled) return
    setCopied(false)
    setCopyFailed(false)
    setHandoffClient(client)
  }

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(prompt)
      setCopyFailed(false)
      setCopied(true)
    } catch {
      setCopied(false)
      setCopyFailed(true)
    }
  }

  function openChat(event: MouseEvent<HTMLAnchorElement>) {
    if (disabled) {
      event.preventDefault()
      return
    }
    onOpen?.()
    setHandoffClient(null)
  }

  return (
    <>
      <span className="inline-flex items-center gap-1">
        <button type="button" className={pillClass} onClick={() => open(primary.id)} disabled={disabled}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={primary.logo} alt="" className="h-3 w-3 rounded-full" />
          {t('ai_do_with', { client: primary.name })}
        </button>
        {others.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className={`${pillClass} px-2`} disabled={disabled} aria-label={t('ai_fix_first_other')}>
                <ChevronDown className="h-3 w-3" aria-hidden />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {others.map((c) => (
                <DropdownMenuItem key={c.id} onSelect={() => open(c.id)}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={c.logo} alt="" className="mr-2 h-4 w-4" />
                  {t('ai_do_with', { client: c.name })}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </span>
      <Dialog open={!!selected} onOpenChange={(isOpen) => { if (!isOpen) setHandoffClient(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('ai_review_title', { client: selected?.name ?? '' })}</DialogTitle>
            <DialogDescription>{t('ai_review_description', { client: selected?.name ?? '' })}</DialogDescription>
          </DialogHeader>
          <Textarea readOnly rows={7} value={prompt} aria-label={t('ai_review_prompt')} onFocus={(event) => event.currentTarget.select()} />
          {copyFailed && <p className="text-sm text-destructive" role="alert">{t('ai_copy_failed')}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => void copyPrompt()} aria-live="polite">
              <Copy className="mr-2 h-4 w-4" aria-hidden />
              {copied ? t('ai_prompt_copied') : t('ai_copy_prompt')}
            </Button>
            {selected && <Button asChild>
              <a href={aiChatLink(selected.id)} target="_blank" rel="noopener noreferrer" onClick={openChat} aria-disabled={disabled} tabIndex={disabled ? -1 : undefined}>
                {t('ai_open_client', { client: selected.name })}
                <ExternalLink className="ml-2 h-4 w-4" aria-hidden />
              </a>
            </Button>}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
