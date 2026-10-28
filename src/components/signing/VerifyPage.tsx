'use client'

import { useRef, useState } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { AttnLine } from '@/components/ui/attn-line'
import { Button } from '@/components/ui/button'
import { BrandWordmark } from '@/components/branding/BrandWordmark'
import { useBranding } from '@/lib/branding/brand-context'
import type { VerifiedSigning } from '@/lib/signing/verify'

/** Larger files are not signable anyway (10 MB plus the evidence page): no need to hash them. */
const MAX_FILE_BYTES = 25 * 1024 * 1024

type Result =
  | { kind: 'idle' }
  | { kind: 'checking'; fileName: string }
  | { kind: 'found'; fileName: string; sha256: string; signing: VerifiedSigning }
  | { kind: 'not_found'; fileName: string; sha256: string }
  | { kind: 'error'; message: 'too_large' | 'failed' | 'rate_limited' }

async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * The public check of a signed file: pick a PDF, the browser hashes it, and
 * the page says whether it is a copy signed through Accounted (who signed,
 * as what, when) or not. The file itself is never uploaded.
 */
export function VerifyPage() {
  const t = useTranslations('verify_page')
  const format = useFormatter()
  const { appName } = useBranding()
  const input = useRef<HTMLInputElement>(null)
  const [result, setResult] = useState<Result>({ kind: 'idle' })
  const moment = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'long', timeStyle: 'short' })

  async function check(file: File) {
    if (file.size > MAX_FILE_BYTES) {
      setResult({ kind: 'error', message: 'too_large' })
      return
    }
    setResult({ kind: 'checking', fileName: file.name })
    try {
      const sha256 = await sha256Hex(file)
      const res = await fetch('/api/verifiera', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sha256 }),
      })
      if (res.status === 429) {
        setResult({ kind: 'error', message: 'rate_limited' })
        return
      }
      if (!res.ok) throw new Error(`verify answered ${res.status}`)
      const body = (await res.json()) as { data: ({ found: true } & VerifiedSigning) | { found: false } }
      if (body.data.found) {
        const { found: _found, ...signing } = body.data
        setResult({ kind: 'found', fileName: file.name, sha256, signing })
      } else {
        setResult({ kind: 'not_found', fileName: file.name, sha256 })
      }
    } catch {
      setResult({ kind: 'error', message: 'failed' })
    }
  }

  return (
    <main className="min-h-dvh bg-background px-4 py-10 md:px-6">
      <div className="mx-auto w-full max-w-2xl space-y-8">
        <header className="space-y-4">
          <BrandWordmark size="inline" />
          <div className="space-y-1">
            <h1 className="font-display text-2xl tracking-tight">{t('title')}</h1>
            <p className="text-[13px] text-muted-foreground">{t('intro', { app: appName })}</p>
          </div>
        </header>

        <section className="space-y-4 rounded-lg border border-border p-6">
          <input
            ref={input}
            type="file"
            accept="application/pdf,.pdf"
            className="sr-only"
            aria-label={t('choose_file')}
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) void check(file)
            }}
          />
          <div className="flex flex-wrap items-center gap-4">
            <Button onClick={() => input.current?.click()} loading={result.kind === 'checking'}>
              {t('choose_file')}
            </Button>
            <p className="text-[12.5px] text-muted-foreground">{t('privacy')}</p>
          </div>

          {result.kind === 'found' && (
            <div className="space-y-4 border-t border-border pt-4">
              <div className="space-y-1">
                <h2 className="font-display text-xl tracking-tight">{result.signing.match === 'signed_copy' ? t('found_title') : t('found_original_title')}</h2>
                <p className="text-[13px] text-muted-foreground" data-ph-mask="">
                  {t('found_body', { title: result.signing.title, company: result.signing.company_name, moment: moment(result.signing.completed_at) })}
                </p>
                {result.signing.match === 'original' && <p className="text-[13px] text-muted-foreground">{t('found_original_body')}</p>}
              </div>
              <ul className="space-y-2" data-ph-mask="">
                {result.signing.signers.map((s, i) => (
                  <li key={`${s.name}-${i}`} className="flex items-baseline justify-between gap-4 text-[13px]">
                    <span className="min-w-0 truncate">{s.role_label ? `${s.name}, ${s.role_label}` : s.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{t('signed_with_bankid', { moment: moment(s.signed_at) })}</span>
                  </li>
                ))}
              </ul>
              <p className="break-all font-mono text-[12.5px] text-muted-foreground">{result.sha256}</p>
            </div>
          )}

          {result.kind === 'not_found' && (
            <div className="space-y-1 border-t border-border pt-4">
              <h2 className="font-display text-xl tracking-tight">{t('not_found_title')}</h2>
              <p className="text-[13px] text-muted-foreground" data-ph-mask="">
                {t('not_found_body', { file: result.fileName, app: appName })}
              </p>
              <p className="break-all font-mono text-[12.5px] text-muted-foreground">{result.sha256}</p>
            </div>
          )}

          {result.kind === 'error' && <AttnLine>{t(`error_${result.message}`)}</AttnLine>}
        </section>
      </div>
    </main>
  )
}
