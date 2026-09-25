'use client'

import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { AttnLine } from '@/components/ui/attn-line'
import { Copy, Check, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { copyToClipboard } from '@/lib/browser/copy-to-clipboard'

type CopyState = 'idle' | 'copied' | 'failed'

/** A select-all code block with a copy button (MCP URLs, config, one-time keys). */
export function CopyBlock({ text, copyAriaLabel }: { text: string; copyAriaLabel: string }) {
  const t = useTranslations('settings_api_keys')
  const [state, setState] = useState<CopyState>('idle')

  async function handleCopy() {
    // The write is the first await, so the click's user activation still holds.
    const result = await copyToClipboard(text)
    if (result !== 'copied') {
      // Never imply success. The block stays on screen and is select-all, so
      // the user can copy it by hand: with no clipboard there is no other way.
      setState('failed')
      return
    }
    setState('copied')
    setTimeout(() => setState('idle'), 2000)
  }

  return (
    <div className="relative group">
      <pre className="select-all rounded-lg bg-muted p-4 pr-12 text-xs font-mono overflow-x-auto whitespace-pre-wrap break-all">
        {text}
      </pre>
      <Button
        variant="outline"
        size="icon-sm"
        className={cn(
          'absolute right-1.5 top-1.5 transition-opacity focus-visible:opacity-100 pointer-coarse:opacity-100',
          state === 'failed' ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
        )}
        onClick={handleCopy}
        aria-label={copyAriaLabel}
      >
        {state === 'copied' ? (
          <Check className="h-3.5 w-3.5 text-success" />
        ) : state === 'failed' ? (
          <AlertTriangle className="h-3.5 w-3.5 text-attn" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </Button>
      {/* Live region is always mounted so the message is announced when it
          appears, not merely inserted. */}
      <div role="status" aria-live="polite">
        {state === 'failed' && <AttnLine className="mt-1.5">{t('copy_failed')}</AttnLine>}
      </div>
    </div>
  )
}
