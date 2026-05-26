import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { formatDate, formatDateLong } from '@/lib/utils'

// Read-only "Bolagsuppgifter" view of the cached TIC company profile
// (companies.tic_snapshot). Lives in core — reads the snapshot as plain
// JSON rather than importing the TIC extension's types, so the
// core-build CI boundary (no core → @/extensions/) stays intact.
//
// The snapshot is written by the TIC /profile endpoint; shape mirrors
// TICCompanyProfile. We type only the fields we render and treat
// everything as optional/defensive since older snapshots predate some
// sections.

interface SnapshotShape {
  companyName?: string | null
  orgNumber?: string | null
  legalEntityType?: string | null
  address?: { street?: string | null; postalCode?: string | null; city?: string | null } | null
  registration?: { fTax?: boolean; vat?: boolean; payroll?: boolean } | null
  sniCodes?: { code: string; name: string }[] | null
  bankAccounts?: { type: string; accountNumber: string; bic?: string | null }[] | null
  purpose?: string | null
  employeeRange?: string | null
  financials?: {
    periodStart?: number
    periodEnd?: number
    netSalesK?: number | null
    operatingProfitK?: number | null
  } | null
  statuses?: {
    code?: string | null
    description?: string | null
    color?: 'red' | 'yellow' | 'green' | 'neutral' | string | null
    statusDate?: string | null
    isCeased?: boolean | null
  }[] | null
  fiscalYear?: { startMonthDay?: string | null; endMonthDay?: string | null } | null
  signatory?: { description: string }[] | null
  board?: {
    numberOfBoardMembers?: number | null
    numberOfDeputyBoardMembers?: number | null
  } | null
  representatives?: {
    name?: string | null
    positionType?: string | null
    positionStart?: string | null
  }[] | null
}

const statusVariant: Record<string, 'success' | 'warning' | 'destructive' | 'secondary'> = {
  green: 'success',
  yellow: 'warning',
  red: 'destructive',
  neutral: 'secondary',
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="text-sm font-medium uppercase tracking-wider text-muted-foreground mb-2">
        {title}
      </h3>
      {children}
    </section>
  )
}

export function CompanyProfileView({
  snapshot,
  fetchedAt,
}: {
  snapshot: SnapshotShape | null
  fetchedAt: string | null
}) {
  if (!snapshot) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Bolagsuppgifter</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Inga företagsuppgifter hämtade ännu. Uppgifterna hämtas automatiskt
            från Bolagsverket via organisationsnumret.
          </p>
        </CardContent>
      </Card>
    )
  }

  const entityLabel =
    snapshot.legalEntityType === 'AB'
      ? 'Aktiebolag'
      : snapshot.legalEntityType === 'EF'
        ? 'Enskild firma'
        : snapshot.legalEntityType ?? null

  const reg = snapshot.registration
  const regBadges = [
    reg?.fTax ? 'F-skatt' : null,
    reg?.vat ? 'Moms' : null,
    reg?.payroll ? 'Arbetsgivare' : null,
  ].filter(Boolean) as string[]

  const fyLabel =
    snapshot.fiscalYear?.startMonthDay && snapshot.fiscalYear?.endMonthDay
      ? `${snapshot.fiscalYear.startMonthDay} – ${snapshot.fiscalYear.endMonthDay}`
      : null

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Bolagsuppgifter</CardTitle>
        {fetchedAt && (
          <p className="text-xs text-muted-foreground">
            Uppdaterad {formatDateLong(fetchedAt)}
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-8">
        {/* Identity */}
        <div>
          <p className="font-display text-xl tracking-tight">
            {snapshot.companyName ?? 'Okänt företag'}
          </p>
          <p className="text-sm text-muted-foreground tabular-nums">
            {[snapshot.orgNumber, entityLabel].filter(Boolean).join(' · ')}
          </p>
          {snapshot.address && (
            <p className="text-sm text-muted-foreground mt-2">
              {[
                snapshot.address.street,
                [snapshot.address.postalCode, snapshot.address.city].filter(Boolean).join(' '),
              ]
                .filter(Boolean)
                .join(', ')}
            </p>
          )}
        </div>

        {regBadges.length > 0 && (
          <Section title="Registrerat för">
            <div className="flex flex-wrap gap-2">
              {regBadges.map((b) => (
                <Badge key={b} variant="secondary" className="font-normal">{b}</Badge>
              ))}
            </div>
          </Section>
        )}

        {Array.isArray(snapshot.sniCodes) && snapshot.sniCodes.length > 0 && (
          <Section title="SNI-koder">
            <ul className="space-y-1">
              {snapshot.sniCodes.map((s) => (
                <li key={s.code} className="text-sm tabular-nums">
                  <span className="text-foreground">{s.code}</span>{' '}
                  <span className="text-muted-foreground">{s.name}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {Array.isArray(snapshot.bankAccounts) && snapshot.bankAccounts.length > 0 && (
          <Section title="Bankuppgifter">
            <ul className="space-y-1">
              {snapshot.bankAccounts.map((b, i) => (
                <li key={`${b.type}-${b.accountNumber}-${i}`} className="text-sm tabular-nums">
                  <span className="text-muted-foreground">{b.type}:</span>{' '}
                  <span className="text-foreground">{b.accountNumber}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {snapshot.purpose && (
          <Section title="Verksamhet">
            <p className="text-sm leading-6 text-muted-foreground">{snapshot.purpose}</p>
          </Section>
        )}

        <Section title="Anställda">
          <p className="text-sm text-muted-foreground">
            {snapshot.employeeRange ?? 'Inga anställda'}
          </p>
        </Section>

        <Section title="Senaste bokslut">
          {snapshot.financials ? (
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Nettoomsättning</dt>
              <dd className="text-right tabular-nums">
                {snapshot.financials.netSalesK != null
                  ? `${snapshot.financials.netSalesK.toLocaleString('sv-SE')} tkr`
                  : '—'}
              </dd>
              <dt className="text-muted-foreground">Rörelseresultat</dt>
              <dd className="text-right tabular-nums">
                {snapshot.financials.operatingProfitK != null
                  ? `${snapshot.financials.operatingProfitK.toLocaleString('sv-SE')} tkr`
                  : '—'}
              </dd>
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">Inga finansiella uppgifter tillgängliga.</p>
          )}
        </Section>

        {Array.isArray(snapshot.statuses) && snapshot.statuses.length > 0 && (
          <Section title="Status">
            <ul className="space-y-1.5">
              {snapshot.statuses.map((s, i) => (
                <li key={`${s.code}-${i}`} className="flex items-center justify-between gap-3 text-sm">
                  <span className="flex items-center gap-2">
                    <Badge
                      variant={statusVariant[s.color ?? 'neutral'] ?? 'secondary'}
                      className="font-normal"
                    >
                      {s.description ?? s.code ?? '—'}
                    </Badge>
                  </span>
                  {s.statusDate && (
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {formatDate(s.statusDate)}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </Section>
        )}

        {fyLabel && (
          <Section title="Räkenskapsår">
            <p className="text-sm tabular-nums text-muted-foreground">Nuvarande: {fyLabel}</p>
          </Section>
        )}

        {Array.isArray(snapshot.signatory) && snapshot.signatory.length > 0 && (
          <Section title="Firmateckning">
            <ul className="space-y-1.5">
              {snapshot.signatory.map((s, i) => (
                <li key={i} className="text-sm leading-6 text-muted-foreground">
                  {s.description}
                </li>
              ))}
            </ul>
          </Section>
        )}

        {Array.isArray(snapshot.representatives) && snapshot.representatives.length > 0 && (
          <Section title="Företrädare">
            {snapshot.board && (
              <p className="text-xs text-muted-foreground mb-2">
                {[
                  snapshot.board.numberOfBoardMembers != null
                    ? `${snapshot.board.numberOfBoardMembers} styrelseledamot/-ledamöter`
                    : null,
                  snapshot.board.numberOfDeputyBoardMembers != null
                    ? `${snapshot.board.numberOfDeputyBoardMembers} suppleant(er)`
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            )}
            <ul className="space-y-1">
              {snapshot.representatives.map((r, i) => (
                <li key={`${r.name}-${i}`} className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-foreground">{r.name ?? '—'}</span>
                  <span className="text-xs text-muted-foreground text-right">
                    {[r.positionType, r.positionStart ? formatDate(r.positionStart) : null]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        )}
      </CardContent>
    </Card>
  )
}
