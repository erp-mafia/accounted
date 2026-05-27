'use client'

import { useState } from 'react'
import { Pencil, X, Loader2, ArrowLeft, ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { AVATAR_OPTIONS } from '@/components/agent/avatars'
import AgentAvatar from '@/components/agent/AgentAvatar'

interface InitialFields {
  entity_type_label: string
  sni_codes: { code: string; name: string }[]
  purpose: string | null
  city: string | null
  fiscal_period: string | null
  vat_period: string | null
  f_skatt: string | null
  employees: string | null
}

interface ProfilePayload {
  company_id: string
  horizontal_atoms: string[]
  vertical_atoms: string[]
  modifier_atoms: string[]
  is_multi_vertical: boolean
  profile_summary: string
  // Still carried from the composer + stored on the profile row, but no
  // longer surfaced as a form step here — the Phase C chat intake owns the
  // questions now (reads them server-side). Kept on the type so the payload
  // shape stays aligned with the stream event.
  verification_questions: string[]
  uncertainty_notes: string[]
  composer_model: string
  composed_at: string
}

interface Props {
  companyId: string
  companyName: string
  initialFields: InitialFields
  // Pre-fetched atom titles from agent_atom_registry — used to render chips
  // with the authored title instead of a naive slug-derived label. Missing
  // ids fall through to deriveSlugTitle which is intentionally minimal.
  atomTitles: Record<string, string>
  profile: ProfilePayload | null
  onVerified: () => void
}

// Maps an atom id to a chip label. Prefers the registry title when known.
function atomLabel(id: string, atomTitles: Record<string, string>): string {
  if (atomTitles[id]) return atomTitles[id]
  const slug = id.split('/').slice(-1)[0] ?? id
  return slug
    .split('-')
    .map((w) => {
      const upper = w.toUpperCase()
      if (upper === 'VAT' || upper === 'SRU' || upper === 'SIE' || upper === 'IT') return upper
      return w.length > 0 ? w[0].toUpperCase() + w.slice(1) : w
    })
    .join(' ')
}

export default function ReviewCard({
  companyId,
  companyName,
  initialFields,
  atomTitles,
  profile,
  onVerified,
}: Props) {
  // Field-edit state. The pencil affordances let the user override anything
  // the composer inferred. Each override is sent to PATCH /api/agent/profile,
  // which stamps an overridden_at timestamp.
  const [fields, setFields] = useState<InitialFields>(initialFields)
  const [editing, setEditing] = useState<keyof InitialFields | null>(null)
  const [summary, setSummary] = useState<string>(profile?.profile_summary ?? '')
  const [editingSummary, setEditingSummary] = useState(false)
  const [horizontal, setHorizontal] = useState<string[]>(profile?.horizontal_atoms ?? [])
  const [vertical, setVertical] = useState<string[]>(profile?.vertical_atoms ?? [])
  const [modifier, setModifier] = useState<string[]>(profile?.modifier_atoms ?? [])
  // Agent identity — name shown on the FAB, avatar shown alongside.
  const [displayName, setDisplayName] = useState('')
  const [avatarId, setAvatarId] = useState<string>(AVATAR_OPTIONS[0].id)
  const [seedMemory, setSeedMemory] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [verifyError, setVerifyError] = useState<string | null>(null)

  // Two steps now:
  //   1 — meet your assistant (name + avatar)
  //   2 — agree on the facts (profile + specialties + form fields + optional
  //       seed note), then "kör" which hands off to the Phase C chat intake.
  // The verification-question interview that used to live here as a form
  // stepper is gone — the chat conducts the real interview instead.
  type Step = 1 | 2
  const [step, setStep] = useState<Step>(1)
  const totalPositions = 2
  const currentPosition = step - 1

  const agentName = displayName.trim() || 'din assistent'

  async function handleVerify() {
    setVerifying(true)
    setVerifyError(null)
    try {
      // Persist edits before verifying. Skipped if nothing changed.
      const changedFields: Record<string, unknown> = {}
      for (const key of Object.keys(initialFields) as (keyof InitialFields)[]) {
        if (fields[key] !== initialFields[key]) {
          changedFields[key] = fields[key]
        }
      }
      const atomsChanged =
        !arrEq(horizontal, profile?.horizontal_atoms ?? []) ||
        !arrEq(vertical, profile?.vertical_atoms ?? []) ||
        !arrEq(modifier, profile?.modifier_atoms ?? [])
      const summaryChanged = summary !== (profile?.profile_summary ?? '')
      const trimmedName = displayName.trim()
      // Identity is always persisted on first verify so the FAB picks it up
      // immediately. If the user typed nothing, we leave display_name null
      // (UI falls back to "min revisor").
      const identityChanged = trimmedName.length > 0 || avatarId !== AVATAR_OPTIONS[0].id

      if (Object.keys(changedFields).length > 0 || atomsChanged || summaryChanged || identityChanged) {
        const patchBody: Record<string, unknown> = { company_id: companyId }
        if (Object.keys(changedFields).length > 0) patchBody.field_overrides = changedFields
        if (atomsChanged) {
          patchBody.atoms = {
            horizontal_atoms: horizontal,
            vertical_atoms: vertical,
            modifier_atoms: modifier,
          }
        }
        if (summaryChanged) patchBody.profile_summary = summary
        if (identityChanged) {
          patchBody.display_name = trimmedName.length > 0 ? trimmedName : null
          patchBody.avatar_id = avatarId
        }
        const res = await fetch('/api/agent/profile', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patchBody),
        })
        if (!res.ok) {
          const text = await res.text()
          throw new Error(text || `HTTP ${res.status}`)
        }
      }

      if (seedMemory.trim().length > 1) {
        await fetch('/api/agent/memory', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            company_id: companyId,
            content: seedMemory.trim(),
            kind: 'fact',
            source: 'user_taught',
            source_ref: 'onboarding_seed',
            relevance_score: 1.0,
          }),
        })
      }

      const verifyRes = await fetch('/api/agent/profile/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ company_id: companyId }),
      })
      if (!verifyRes.ok) {
        const text = await verifyRes.text()
        throw new Error(text || `HTTP ${verifyRes.status}`)
      }

      onVerified()
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : 'Kunde inte verifiera.')
    } finally {
      setVerifying(false)
    }
  }

  const stepTitle = step === 1 ? 'Träffa din assistent' : 'Stäm av detaljerna'
  const stepSubtitle =
    step === 1
      ? 'Ge din assistent ett namn och välj en avatar.'
      : 'Bekräfta att uppgifterna stämmer, eller ändra det som blivit fel. Sen lär din assistent känna dig i en kort intervju.'

  return (
    <div className="w-full">
      <header className="mb-6">
        <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">
          {companyName}
        </p>
        <h1 className="font-display text-3xl md:text-4xl tracking-tight">{stepTitle}</h1>
        <p className="text-muted-foreground mt-2">{stepSubtitle}</p>
      </header>

      {/* Progress — one segment per step. Back navigation lives on the
          "Tillbaka" button below. */}
      <div className="flex items-center gap-1.5 mb-6" aria-hidden="true">
        {Array.from({ length: totalPositions }, (_, i) => i).map((pos) => (
          <div
            key={pos}
            className={cn(
              'h-1.5 flex-1 rounded-full transition-colors',
              pos <= currentPosition ? 'bg-foreground' : 'bg-border',
            )}
          />
        ))}
      </div>

      <Card className="border-border">
        <CardContent className="p-6 md:p-8 space-y-6">
          {step === 1 && (
            <section className="space-y-6">
              <div className="flex flex-col items-center text-center gap-3 py-4">
                <AgentAvatar avatarId={avatarId} size="lg" className="h-20 w-20" />
                <div>
                  <p className="font-display text-xl tracking-tight">
                    {displayName.trim() || 'Din assistent'}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Visas som <span className="font-medium">Fråga {displayName.trim() || 'min assistent'}</span> i appen.
                  </p>
                </div>
              </div>
              <div>
                <label htmlFor="agent-display-name" className="block text-sm font-medium mb-2">
                  Vad ska den heta?
                </label>
                <Input
                  id="agent-display-name"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="t.ex. Anna, Lars, Karin. Eller hoppa över."
                  maxLength={60}
                  autoFocus
                />
              </div>
              <div>
                <p className="block text-sm font-medium mb-2">Välj en avatar</p>
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
          )}

          {step === 2 && (
            <>
              {/* Value first — the prose summary the composer wrote, so the
                  user sees the assistant understood them before being asked to
                  check dry registry facts. */}
              <section>
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
                    Så här har jag förstått dig
                  </h2>
                  {!editingSummary && summary && (
                    <button
                      onClick={() => setEditingSummary(true)}
                      className="text-muted-foreground hover:text-foreground transition-colors"
                      aria-label="Redigera profil"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                  )}
                </div>
                {editingSummary ? (
                  <textarea
                    value={summary}
                    onChange={(e) => setSummary(e.target.value)}
                    onBlur={() => setEditingSummary(false)}
                    autoFocus
                    rows={5}
                    className="w-full rounded-lg border border-border bg-background px-4 py-3 text-sm leading-6 resize-none focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                ) : (
                  <p className="text-sm leading-6 italic text-muted-foreground">
                    {summary || 'Ingen sammanfattning ännu.'}
                  </p>
                )}
              </section>

              {/* What the assistant can actually do — the differentiated
                  output of the build. Plain-language heading, not the internal
                  "atoms/specialiteter" framing. */}
              {(horizontal.length > 0 || vertical.length > 0 || modifier.length > 0) && (
                <section>
                  <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground mb-1">
                    Vad jag kan hjälpa dig med
                  </h2>
                  <p className="text-xs text-muted-foreground mb-3">
                    Kunskapsområden jag läst in för din verksamhet. Ta bort det som inte passar, så slipper du förslag som inte är relevanta.
                  </p>
                  <ChipGroup
                    primaryLabel="Bransch"
                    secondaryLabel="Övrigt"
                    primary={vertical.map((id) => ({ id, label: atomLabel(id, atomTitles) }))}
                    secondary={[
                      ...modifier.map((id) => ({ id, label: atomLabel(id, atomTitles), group: 'modifier' as const })),
                      ...horizontal.map((id) => ({ id, label: atomLabel(id, atomTitles), group: 'horizontal' as const })),
                    ]}
                    onRemove={(id, group) => {
                      if (group === 'horizontal') setHorizontal((arr) => arr.filter((x) => x !== id))
                      else if (group === 'vertical') setVertical((arr) => arr.filter((x) => x !== id))
                      else setModifier((arr) => arr.filter((x) => x !== id))
                    }}
                  />
                </section>
              )}

              {/* Inferred facts to confirm */}
              <section>
                <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground mb-4">
                  Uppgifter
                </h2>
                <dl className="divide-y divide-border">
                  <FieldRow
                    label="Form"
                    value={fields.entity_type_label}
                    editing={editing === 'entity_type_label'}
                    onEdit={() => setEditing('entity_type_label')}
                    onChange={(v) => setFields((f) => ({ ...f, entity_type_label: v }))}
                    onCommit={() => setEditing(null)}
                  />
                  <SniRow sniCodes={fields.sni_codes} />
                  <FieldRow
                    label="Säte"
                    value={fields.city ?? ''}
                    placeholder="—"
                    editing={editing === 'city'}
                    onEdit={() => setEditing('city')}
                    onChange={(v) => setFields((f) => ({ ...f, city: v }))}
                    onCommit={() => setEditing(null)}
                  />
                  <FieldRow
                    label="Räkenskapsår"
                    value={fields.fiscal_period ?? ''}
                    placeholder="januari–december"
                    editing={editing === 'fiscal_period'}
                    onEdit={() => setEditing('fiscal_period')}
                    onChange={(v) => setFields((f) => ({ ...f, fiscal_period: v }))}
                    onCommit={() => setEditing(null)}
                  />
                  <FieldRow
                    label="Moms"
                    value={fields.vat_period ?? ''}
                    placeholder="Kvartal / månad / år"
                    editing={editing === 'vat_period'}
                    onEdit={() => setEditing('vat_period')}
                    onChange={(v) => setFields((f) => ({ ...f, vat_period: v }))}
                    onCommit={() => setEditing(null)}
                  />
                  <FieldRow
                    label="F-skatt"
                    value={fields.f_skatt ?? ''}
                    placeholder="Aktivt / saknas"
                    editing={editing === 'f_skatt'}
                    onEdit={() => setEditing('f_skatt')}
                    onChange={(v) => setFields((f) => ({ ...f, f_skatt: v }))}
                    onCommit={() => setEditing(null)}
                  />
                  <FieldRow
                    label="Anställda"
                    value={fields.employees ?? ''}
                    placeholder="0"
                    editing={editing === 'employees'}
                    onEdit={() => setEditing('employees')}
                    onChange={(v) => setFields((f) => ({ ...f, employees: v }))}
                    onCommit={() => setEditing(null)}
                  />
                </dl>
              </section>

              {/* Verksamhetsbeskrivning from Bolagsverket — verbatim, since
                  authoritative legal text. Hidden when TIC didn't return one. */}
              {fields.purpose && (
                <section>
                  <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground mb-3">
                    Verksamhet
                  </h2>
                  <p className="text-sm leading-6 text-muted-foreground italic">
                    {fields.purpose}
                  </p>
                </section>
              )}

              {/* Optional seed note — the fast path for users who'd rather jot
                  one thing than chat. The Phase C intake will draw the rest
                  out conversationally. */}
              <section>
                <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground mb-1">
                  Bra att veta
                </h2>
                <p className="text-xs text-muted-foreground mb-3">
                  Valfritt — du kan också berätta i chatten strax. T.ex. återkommande kunder, en hyresfaktura som kommer den 25:e, eller att kunderna mest finns i Tyskland.
                </p>
                <textarea
                  id="seed-memory"
                  value={seedMemory}
                  onChange={(e) => setSeedMemory(e.target.value)}
                  rows={3}
                  placeholder="Skriv något, eller lämna tomt"
                  className="w-full rounded-lg border border-border bg-background px-4 py-3 text-sm leading-6 resize-none focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </section>
            </>
          )}

          {verifyError && (
            <p className="text-sm text-destructive">{verifyError}</p>
          )}

          {/* Step nav. Step 1 → forward to review. Step 2 → back to meet, or
              run the verify pipeline and hand off to the chat intake. */}
          <div className="flex items-center justify-between gap-3 pt-2">
            <Button
              variant="ghost"
              onClick={() => setStep(1)}
              disabled={step === 1}
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              Tillbaka
            </Button>

            {step === 1 && (
              <Button onClick={() => setStep(2)}>
                Nästa
                <ArrowRight className="h-4 w-4 ml-2" />
              </Button>
            )}
            {step === 2 && (
              <Button size="lg" onClick={handleVerify} disabled={verifying}>
                {verifying ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    Sparar…
                  </>
                ) : (
                  <>
                    Möt {agentName}
                    <ArrowRight className="h-4 w-4 ml-2" />
                  </>
                )}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

// Renders one or more SNI codes alongside their human-readable industry
// labels. Read-only for the POC — TIC is authoritative for SNI and we don't
// surface a UI to add codes that Bolagsverket doesn't have.
//
// TIC occasionally returns the same SNI code twice (e.g. as both primary and
// secondary on the company record). Dedupe by code so the same line doesn't
// render twice in a row.
function SniRow({ sniCodes }: { sniCodes: { code: string; name: string }[] }) {
  const seen = new Set<string>()
  const uniqueCodes = sniCodes.filter((s) => {
    if (seen.has(s.code)) return false
    seen.add(s.code)
    return true
  })

  return (
    <div className="flex items-start gap-4 py-3">
      <dt className="w-32 text-sm text-muted-foreground shrink-0">SNI</dt>
      <dd className="flex-1 min-w-0">
        {uniqueCodes.length === 0 ? (
          <span className="text-sm italic text-muted-foreground/60">Saknas</span>
        ) : (
          <ul className="space-y-1">
            {uniqueCodes.map((s) => (
              <li key={s.code} className="flex gap-3 text-sm">
                <span className="tabular-nums text-muted-foreground shrink-0">{s.code}</span>
                <span className="min-w-0">{s.name}</span>
              </li>
            ))}
          </ul>
        )}
      </dd>
    </div>
  )
}

function FieldRow({
  label,
  value,
  placeholder,
  editing,
  onEdit,
  onChange,
  onCommit,
}: {
  label: string
  value: string
  placeholder?: string
  editing: boolean
  onEdit: () => void
  onChange: (v: string) => void
  onCommit: () => void
}) {
  return (
    <div className="flex items-center gap-4 py-3">
      <dt className="w-32 text-sm text-muted-foreground shrink-0">{label}</dt>
      <dd className="flex-1 min-w-0">
        {editing ? (
          <Input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onBlur={onCommit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                onCommit()
              }
            }}
            autoFocus
            className="h-9"
          />
        ) : (
          <span
            className={cn(
              'text-sm',
              !value && 'text-muted-foreground/60 italic',
            )}
          >
            {value || placeholder || '—'}
          </span>
        )}
      </dd>
      {!editing && (
        <button
          onClick={onEdit}
          className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
          aria-label={`Redigera ${label}`}
        >
          <Pencil className="h-4 w-4" />
        </button>
      )}
    </div>
  )
}

function ChipGroup({
  primaryLabel,
  secondaryLabel,
  primary,
  secondary,
  onRemove,
}: {
  primaryLabel: string
  secondaryLabel: string
  primary: { id: string; label: string }[]
  secondary: { id: string; label: string; group: 'horizontal' | 'modifier' }[]
  onRemove: (id: string, group: 'horizontal' | 'vertical' | 'modifier') => void
}) {
  return (
    <div className="space-y-3">
      {primary.length > 0 && (
        <div>
          <p className="text-xs text-muted-foreground mb-2">{primaryLabel}</p>
          <div className="flex flex-wrap gap-2">
            {primary.map((c) => (
              <Chip key={c.id} label={c.label} onRemove={() => onRemove(c.id, 'vertical')} />
            ))}
          </div>
        </div>
      )}
      {secondary.length > 0 && (
        <div>
          <p className="text-xs text-muted-foreground mb-2">{secondaryLabel}</p>
          <div className="flex flex-wrap gap-2">
            {secondary.map((c) => (
              <Chip
                key={c.id}
                label={c.label}
                onRemove={() => onRemove(c.id, c.group)}
                muted
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function Chip({
  label,
  onRemove,
  muted,
}: {
  label: string
  onRemove: () => void
  muted?: boolean
}) {
  return (
    <Badge
      variant={muted ? 'outline' : 'secondary'}
      className="pl-3 pr-1.5 py-1 text-xs gap-1 inline-flex items-center"
    >
      {label}
      <button
        onClick={onRemove}
        className="ml-1 rounded-full hover:bg-foreground/10 p-0.5 transition-colors"
        aria-label={`Ta bort ${label}`}
      >
        <X className="h-3 w-3" />
      </button>
    </Badge>
  )
}

function arrEq(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
