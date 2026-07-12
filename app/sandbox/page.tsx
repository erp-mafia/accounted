'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { Loader2 } from 'lucide-react'
import { getBranding } from '@/lib/branding/service'
import { BrandWordmark } from '@/components/branding/BrandWordmark'

const branding = getBranding()

export default function SandboxPage() {
  const [isLoading, setIsLoading] = useState(false)
  const [isLoggedIn, setIsLoggedIn] = useState<boolean | null>(null)
  const { toast } = useToast()
  const router = useRouter()
  const supabase = createClient()

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      setIsLoggedIn(user !== null && !user.is_anonymous)
    })
  }, [supabase.auth])

  const handleStartSandbox = async () => {
    setIsLoading(true)

    try {
      const { error } = await supabase.auth.signInAnonymously()
      if (error) {
        toast({
          title: 'Kunde inte starta sandlådan',
          description: error.message,
          variant: 'destructive',
        })
        setIsLoading(false)
        return
      }

      const res = await fetch('/api/sandbox/seed', { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        // Clean up the orphaned anonymous session so the user can retry cleanly
        await supabase.auth.signOut()
        toast({
          title: 'Kunde inte skapa demodata',
          description: 'Försök igen om en stund.',
          variant: 'destructive',
        })
        setIsLoading(false)
        return
      }

      // Full page load to ensure middleware picks up the new session cookies
      window.location.href = '/'
    } catch {
      toast({
        title: 'Något gick fel',
        description: 'Försök igen om en stund.',
        variant: 'destructive',
      })
      setIsLoading(false)
    }
  }

  // Loading state while checking auth
  if (isLoggedIn === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-background to-primary/[0.03]">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  // Already logged in as a real user
  if (isLoggedIn) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-b from-background to-primary/[0.03] p-4">
        <div className="w-full max-w-sm animate-slide-up">
          <div className="text-center mb-10">
            <BrandWordmark size="hero" className="mb-2" />
          </div>

          <div className="rounded-xl border bg-card p-6" style={{ boxShadow: 'var(--shadow-md)' }}>
            <h1 className="text-lg font-medium tracking-tight text-center mb-2">
              Du är redan inloggad
            </h1>
            <p className="text-sm text-muted-foreground text-center leading-relaxed">
              Sandlådan kräver att du inte är inloggad. Öppna ett inkognitofönster
              eller logga ut först.
            </p>
          </div>

          <div className="mt-6 flex flex-col items-center gap-3">
            <Button asChild className="w-full h-11">
              <Link href="/">Gå till dashboard</Link>
            </Button>
          </div>
        </div>
      </div>
    )
  }

  // Sandbox landing
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-b from-background to-primary/[0.03] p-4">
      <div className="w-full max-w-sm animate-slide-up">
        <div className="text-center mb-10">
          <BrandWordmark size="hero" className="mb-2" />
          <h1 className="text-xl font-medium tracking-tight mt-3">
            Testa {branding.appName.toLowerCase()} utan att registrera dig
          </h1>
          <p className="text-muted-foreground text-sm mt-2 leading-relaxed">
            Utforska ett fullt demoföretag med riktig data: helt gratis.
          </p>
        </div>

        <div className="rounded-xl border bg-card p-6" style={{ boxShadow: 'var(--shadow-md)' }}>
          <p className="mb-6 rounded-lg border border-border bg-secondary/40 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
            AI-assistenten och externa tjänster (e-post, bankuppkoppling,
            valutakurser, Skatteverket) är avstängda i sandlådan: de
            kräver ett riktigt konto.
          </p>

          <Button
            className="w-full h-11"
            onClick={handleStartSandbox}
            disabled={isLoading}
          >
            {isLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Startar...
              </>
            ) : (
              'Starta sandbox'
            )}
          </Button>

          <p className="text-xs text-muted-foreground/70 text-center mt-3">
            Dina data raderas automatiskt efter 24 timmar
          </p>
        </div>

        <p className="mt-6 text-center text-sm text-muted-foreground">
          Har du redan ett konto?{' '}
          <Link
            href="/login"
            className="font-medium text-foreground underline underline-offset-2 hover:text-primary transition-colors"
          >
            Logga in
          </Link>
        </p>
      </div>
    </div>
  )
}
