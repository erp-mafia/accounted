'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'

const ROOT = '/api/import/northmill'
interface Session {
  id: string
  state: 'starting' | 'login' | 'accounts' | 'ready' | 'failed'
  expiresAt: string
  error?: string
  actions?: { id: string; label: string }[]
  canExport?: boolean
}

/** The existing file wizard owns preview, account matching and import confirmation. */
export default function NorthmillFetch({ onFile, disabled }: { onFile: (file: File) => void; disabled: boolean }) {
  const t = useTranslations('import')
  const [enabled, setEnabled] = useState(false)
  const [session, setSession] = useState<Session | null>(null)
  const [image, setImage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const currentId = useRef<string | null>(null)
  const mounted = useRef(true)
  const imageUrl = useRef<string | null>(null)

  useEffect(() => {
    mounted.current = true
    const controller = new AbortController()
    void fetch(ROOT, { signal: controller.signal, cache: 'no-store' })
      .then(response => response.ok ? response.json() : null)
      .then(data => { if (!controller.signal.aborted) setEnabled(data?.enabled === true) }).catch(() => { /* Optional availability or best-effort cleanup; worker TTL closes abandoned sessions. */ })
    return () => {
      mounted.current = false
      controller.abort()
      if (currentId.current) void fetch(`${ROOT}/${currentId.current}`, { method: 'DELETE', keepalive: true }).catch(() => { /* Optional availability or best-effort cleanup; worker TTL closes abandoned sessions. */ })
      if (imageUrl.current) URL.revokeObjectURL(imageUrl.current)
    }
  }, [])

  const sessionId = session?.id
  const sessionState = session?.state
  useEffect(() => {
    if (!sessionId || sessionState === 'ready' || sessionState === 'failed') return
    const id = sessionId
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    let failures = 0
    async function poll() {
      try {
        const response = await fetch(`${ROOT}/${id}`, { cache: 'no-store', signal: controller.signal })
        if (response.status === 409) { timer = setTimeout(() => void poll(), 1000); return }
        if (!response.ok) throw new Error(response.status === 410 || response.status === 404 ? 'expired' : 'failed')
        const next = await response.json() as Session
        if (controller.signal.aborted) return
        setSession(next)
        failures = 0
        if (next.state === 'ready' || next.state === 'failed') return
        if (next.state !== 'starting') {
          const screen = await fetch(`${ROOT}/${id}/screen`, { cache: 'no-store', signal: controller.signal })
          if (screen.ok) {
            const blob = await screen.blob()
            if (controller.signal.aborted) return
            const url = URL.createObjectURL(blob)
            const old = imageUrl.current
            imageUrl.current = url
            setImage(url)
            if (old) URL.revokeObjectURL(old)
          }
        }
      } catch (failure) {
        if (controller.signal.aborted) return
        failures++
        if (failure instanceof Error && failure.message === 'expired') { setError('northmill_expired'); return }
        if (failures >= 3) { setError('northmill_failed'); return }
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 1000)
    }
    void poll()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [sessionId, sessionState])

  async function cancel() {
    const id = currentId.current
    currentId.current = null
    setSession(null)
    setImage(null)
    setError(null)
    if (imageUrl.current) { URL.revokeObjectURL(imageUrl.current); imageUrl.current = null }
    if (id) await fetch(`${ROOT}/${id}`, { method: 'DELETE', keepalive: true }).catch(() => { /* Optional availability or best-effort cleanup; worker TTL closes abandoned sessions. */ })
  }
  async function start() {
    setBusy(true); setError(null)
    try {
      const response = await fetch(ROOT, { method: 'POST' })
      if (!response.ok) throw new Error('start')
      const data = await response.json() as Session
      if (!mounted.current) { void fetch(`${ROOT}/${data.id}`, { method: 'DELETE', keepalive: true }); return }
      currentId.current = data.id
      setSession(data)
    } catch { if (mounted.current) setError('northmill_failed') }
    finally { if (mounted.current) setBusy(false) }
  }
  async function act(body: { type: 'navigate'; id: string } | { type: 'export' }) {
    const id = currentId.current
    if (!id) return
    setBusy(true); setError(null)
    try {
      const response = await fetch(`${ROOT}/${id}/action`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!response.ok) {
        const failure = await response.json().catch(() => null)
        if (currentId.current === id && mounted.current) {
          setError(failure?.error === 'COMPANY_MISMATCH' ? 'northmill_company' : 'northmill_layout')
        }
        return
      }
      const next = await response.json() as Session
      if (currentId.current === id && mounted.current) setSession(next)
    } catch { if (currentId.current === id && mounted.current) setError('northmill_layout') }
    finally { if (mounted.current) setBusy(false) }
  }
  async function preview() {
    const id = currentId.current
    if (!id) return
    setBusy(true)
    try {
      const response = await fetch(`${ROOT}/${id}/file`, { cache: 'no-store' })
      if (!response.ok) throw new Error('file')
      const blob = await response.blob()
      if (currentId.current !== id || !mounted.current) return
      await cancel()
      onFile(new File([blob], 'northmill.csv', { type: 'text/csv' }))
    } catch { if (mounted.current) setError('northmill_failed') }
    finally { if (mounted.current) setBusy(false) }
  }
  if (!enabled) return null
  return <section className="space-y-3 rounded-lg border p-4" aria-label={t('northmill_title')}>
    <p className="font-medium">{t('northmill_title')}</p>
    <p className="text-sm text-muted-foreground">{t('northmill_description')}</p>
    {!session ? <Button variant="outline" onClick={() => void start()} disabled={disabled || busy} loading={busy}>{t('northmill_start')}</Button> : <>
      <p role="status" className="text-sm">{t(`northmill_state_${session.state}`)}</p>
      {image && session.state !== 'ready' && <div className="overflow-auto rounded-md border bg-white">
        {/* Bank screenshots are short-lived authenticated blobs and cannot use the image optimizer. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={image} alt={t('northmill_screen')} className="mx-auto h-auto max-w-full" />
      </div>}
      <div className="flex flex-wrap gap-2">
        {session.actions?.map(action => <Button key={action.id} variant="outline" disabled={busy} onClick={() => void act({ type: 'navigate', id: action.id })}>{action.label}</Button>)}
        {session.canExport && <Button disabled={busy} loading={busy} onClick={() => void act({ type: 'export' })}>{t('northmill_export')}</Button>}
        {session.state === 'ready' && <Button disabled={busy} loading={busy} onClick={() => void preview()}>{t('northmill_preview')}</Button>}
        <Button variant="ghost" disabled={busy} onClick={() => void cancel()}>{t('northmill_cancel')}</Button>
      </div>
    </>}
    {(error || session?.error) && <p role="alert" className="text-sm text-destructive">{t(error || 'northmill_failed')}</p>}
  </section>
}
