'use client'

import { useCallback, useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/use-toast'
import { cn } from '@/lib/utils'
import { AVATAR_OPTIONS } from '@/components/agent/avatars'
import AgentAvatar from '@/components/agent/AgentAvatar'

// Settings surface for the agent's company profile (företagsprofil). The
// onboarding ReviewCard is a one-time wizard; this panel lets the user
// revise the same data afterwards — assistant name + avatar, the profile
// summary the agent reasons from, and a read-only view of the loaded
// specialities (atoms). Backed by GET/PATCH /api/agent/profile.

interface ProfileData {
  display_name: string | null
  avatar_id: string | null
  profile_summary: string | null
  horizontal_atoms: string[]
  vertical_atoms: string[]
  modifier_atoms: string[]
  verified_at: string | null
}

export function AgentProfilePanel() {
  const { toast } = useToast()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [profile, setProfile] = useState<ProfileData | null>(null)
  const [atomTitles, setAtomTitles] = useState<Record<string, string>>({})

  // Editable fields
  const [displayName, setDisplayName] = useState('')
  const [avatarId, setAvatarId] = useState<string>(AVATAR_OPTIONS[0].id)
  const [summary, setSummary] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/agent/profile')
      const json = await res.json()
      const data = json.data as ProfileData | null
      setProfile(data)
      if (data) {
        setDisplayName(data.display_name ?? '')
        setAvatarId(data.avatar_id ?? AVATAR_OPTIONS[0].id)
        setSummary(data.profile_summary ?? '')
        // Resolve atom slugs → human titles for the chips. Best-effort:
        // on failure we fall back to the slug-derived label.
        const allIds = [
          ...(data.horizontal_atoms ?? []),
          ...(data.vertical_atoms ?? []),
          ...(data.modifier_atoms ?? []),
        ]
        if (allIds.length > 0) {
          try {
            const r = await fetch(
              `/api/agent/atom-titles?ids=${encodeURIComponent(allIds.join(','))}`,
            )
            if (r.ok) {
              const t = (await r.json()) as { data?: Record<string, string> }
              setAtomTitles(t.data ?? {})
            }
          } catch {
            // keep empty — chips fall back to slug labels
          }
        }
      }
    } catch {
      toast({ title: 'Kunde inte ladda profilen', variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    void load()
  }, [load])

  async function handleSave() {
    if (!profile) return
    setSaving(true)
    try {
      const body: Record<string, unknown> = { }
      const trimmedName = displayName.trim()
      if (trimmedName !== (profile.display_name ?? '')) {
        body.display_name = trimmedName.length > 0 ? trimmedName : null
      }
      if (avatarId !== (profile.avatar_id ?? AVATAR_OPTIONS[0].id)) {
        body.avatar_id = avatarId
      }
      if (summary.trim() !== (profile.profile_summary ?? '') && summary.trim().length > 0) {
        body.profile_summary = summary.trim()
      }
      if (Object.keys(body).length === 0) {
        toast({ title: 'Inget har ändrats' })
        setSaving(false)
        return
      }
      const res = await fetch('/api/agent/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const text = await res.text()
        throw new Error(text || `HTTP ${res.status}`)
      }
      toast({ title: 'Profilen sparad' })
      await load()
    } catch (err) {
      toast({
        title: 'Kunde inte spara',
        description: err instanceof Error ? err.message : 'Okänt fel',
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  const atomLabel = (slug: string): string =>
    atomTitles[slug] ?? slug.split('/').pop()?.replace(/-/g, ' ') ?? slug

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Företagsprofil</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-24 w-full" />
        </CardContent>
      </Card>
    )
  }

  // No agent built yet — point the user at onboarding rather than showing
  // an empty editor.
  if (!profile) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Företagsprofil</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Du har inte byggt din bokföringsassistent ännu.{' '}
            <a href="/onboarding/agent" className="underline underline-offset-2 hover:text-foreground">
              Bygg den här
            </a>
            , så kan du justera profilen efteråt.
          </p>
        </CardContent>
      </Card>
    )
  }

  const allAtoms = [
    ...(profile.horizontal_atoms ?? []),
    ...(profile.vertical_atoms ?? []),
    ...(profile.modifier_atoms ?? []),
  ]

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Företagsprofil</CardTitle>
        <p className="text-sm text-muted-foreground">
          Det här är vad din assistent vet om företaget. Ändra namn, avatar
          eller sammanfattningen den utgår från.
        </p>
      </CardHeader>
      <CardContent className="space-y-8">
        {/* Identity */}
        <section className="space-y-4">
          <div className="flex items-center gap-3">
            <AgentAvatar avatarId={avatarId} size="lg" className="h-14 w-14" />
            <div className="flex-1">
              <label htmlFor="agent-name" className="block text-sm font-medium mb-1.5">
                Namn
              </label>
              <Input
                id="agent-name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="t.ex. Anna"
                maxLength={60}
              />
            </div>
          </div>
          <div>
            <p className="block text-sm font-medium mb-2">Avatar</p>
            <div className="grid grid-cols-4 gap-3 sm:grid-cols-8">
              {AVATAR_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setAvatarId(opt.id)}
                  aria-label={`Välj avatar ${opt.label}`}
                  className={cn(
                    'aspect-square rounded-full overflow-hidden transition-all',
                    avatarId === opt.id
                      ? 'ring-2 ring-foreground ring-offset-2 ring-offset-background'
                      : 'opacity-70 hover:opacity-100 hover:ring-1 hover:ring-border',
                  )}
                >
                  <AgentAvatar avatarId={opt.id} size="md" className="h-full w-full" />
                </button>
              ))}
            </div>
          </div>
        </section>

        {/* Profile summary */}
        <section>
          <label htmlFor="agent-summary" className="block text-sm font-medium mb-1.5">
            Sammanfattning
          </label>
          <p className="text-xs text-muted-foreground mb-2">
            Assistentens bild av verksamheten. Den läser den här varje gång
            den hjälper dig — håll den uppdaterad om något ändras.
          </p>
          <Textarea
            id="agent-summary"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            rows={5}
            maxLength={2000}
          />
        </section>

        {/* Loaded specialities (read-only) */}
        {allAtoms.length > 0 && (
          <section>
            <p className="block text-sm font-medium mb-2">Inlästa specialiteter</p>
            <p className="text-xs text-muted-foreground mb-3">
              Kunskapsområden assistenten laddat för ditt företag. Justeras
              automatiskt utifrån din verksamhet.
            </p>
            <div className="flex flex-wrap gap-2">
              {allAtoms.map((slug) => (
                <Badge key={slug} variant="secondary" className="font-normal">
                  {atomLabel(slug)}
                </Badge>
              ))}
            </div>
          </section>
        )}

        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={saving}>
            {saving ? 'Sparar…' : 'Spara'}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
