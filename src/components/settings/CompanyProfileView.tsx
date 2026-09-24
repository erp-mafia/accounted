import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { formatDate } from '@/lib/utils'
import { SettingsRow, SettingsRowNote } from '@/components/settings/SettingsRows'

// Read-only "Bolagsuppgifter" view of the cached TIC company profile
// (companies.tic_snapshot), rendered as flat settings rows inside the
// section's SettingsGroup. Lives in core: reads the snapshot as plain
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

// Clean Bolagsverket signatory text: the source carries ">" list markers
// and collapses several rules onto one line. Strip the markers, normalise
// whitespace, and split run-on "Firman tecknas …" clauses onto their own
// lines so each rule reads as a sentence.
function cleanSignatory(raw: string | null | undefined): string[] {
  // The snapshot is unvalidated registry JSON: `description` is declared
  // required inside an interface whose every other field is optional, so a
  // signatory row without one would throw here and blank the settings panel.
  if (!raw) return []
  const normalised = raw
    .replace(/>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  // Each firmateckningsregel starts with "Firman tecknas". Split on the
  // boundary before subsequent occurrences so they stack vertically.
  return normalised
    .split(/(?=Firman tecknas)/g)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

export function CompanyProfileView({ snapshot }: { snapshot: SnapshotShape | null }) {
  const t = useTranslations('company_profile_view')
  if (!snapshot) {
    // Dynamic status (nothing fetched yet): stays visible as a quiet line.
    return (
      <p className="border-b border-border px-1 py-3 text-sm text-muted-foreground">
        {t('no_snapshot')}
      </p>
    )
  }

  const entityLabel =
    snapshot.legalEntityType === 'AB'
      ? t('entity_ab')
      : snapshot.legalEntityType === 'EF'
        ? t('entity_ef')
        : snapshot.legalEntityType ?? null

  const reg = snapshot.registration
  const regBadges = [
    reg?.fTax ? t('reg_f_tax') : null,
    reg?.vat ? t('reg_vat') : null,
    reg?.payroll ? t('reg_employer') : null,
  ].filter(Boolean) as string[]

  const fyLabel =
    snapshot.fiscalYear?.startMonthDay && snapshot.fiscalYear?.endMonthDay
      ? t('fiscal_year_range', { start: snapshot.fiscalYear.startMonthDay, end: snapshot.fiscalYear.endMonthDay })
      : null

  // Only show dated status entries: Bolagsverket emits informational
  // flags like "Har aldrig varit verksam" with no date that read as
  // noise next to the real ones. Plain text, no colour: per the
  // design system, semantic colour is data-only and never chrome.
  const datedStatuses = (snapshot.statuses ?? []).filter((s) => s.statusDate)

  // Flatten every signatory row, clean ">" markers, split run-on
  // clauses, and dedupe: the source repeats "Firman tecknas av
  // styrelsen" across rows.
  const signatoryRules = Array.from(
    new Set(
      (snapshot.signatory ?? []).flatMap((s) => cleanSignatory(s.description)),
    ),
  )

  return (
    <>
      <SettingsRow label={t('label_company')}>
        <span className="text-foreground">{snapshot.companyName ?? t('unknown_company')}</span>
        {(snapshot.orgNumber || entityLabel) && (
          <SettingsRowNote className="tabular-nums">
            {[snapshot.orgNumber, entityLabel].filter(Boolean).join(' · ')}
          </SettingsRowNote>
        )}
      </SettingsRow>

      {snapshot.address && (
        <SettingsRow label={t('label_address')}>
          <span className="text-muted-foreground">
            {[
              snapshot.address.street,
              [snapshot.address.postalCode, snapshot.address.city].filter(Boolean).join(' '),
            ]
              .filter(Boolean)
              .join(', ')}
          </span>
        </SettingsRow>
      )}

      {regBadges.length > 0 && (
        <SettingsRow label={t('label_registered_for')}>
          {regBadges.map((b) => (
            <Badge key={b} variant="secondary" className="font-normal">{b}</Badge>
          ))}
        </SettingsRow>
      )}

      {Array.isArray(snapshot.sniCodes) && snapshot.sniCodes.length > 0 && (
        <SettingsRow label={t('label_sni')} align="baseline">
          <ul className="w-full space-y-1">
            {snapshot.sniCodes.map((s) => (
              <li key={s.code} className="text-sm tabular-nums">
                <span className="text-foreground">{s.code}</span>{' '}
                <span className="text-muted-foreground">{s.name}</span>
              </li>
            ))}
          </ul>
        </SettingsRow>
      )}

      {Array.isArray(snapshot.bankAccounts) && snapshot.bankAccounts.length > 0 && (
        <SettingsRow label={t('label_bank')} align="baseline">
          {/* Registry read-out, not a setting: without the note this row makes
              the bankgiro look configured while payment files and invoices
              read the editable fields under Fakturering. */}
          <div className="w-full space-y-1">
            <ul className="space-y-1">
              {snapshot.bankAccounts.map((b, i) => (
                <li key={`${b.type}-${b.accountNumber}-${i}`} className="text-sm tabular-nums">
                  <span className="text-muted-foreground">{b.type}:</span>{' '}
                  <span className="text-foreground">{b.accountNumber}</span>
                </li>
              ))}
            </ul>
            <SettingsRowNote className="block">
              {t('bank_note')}
            </SettingsRowNote>
          </div>
        </SettingsRow>
      )}

      {snapshot.purpose && (
        <SettingsRow label={t('label_purpose')} align="baseline">
          <p className="text-sm leading-6 text-muted-foreground">{snapshot.purpose}</p>
        </SettingsRow>
      )}

      <SettingsRow label={t('label_employees')}>
        <span className="text-muted-foreground">
          {snapshot.employeeRange ?? t('no_employees')}
        </span>
      </SettingsRow>

      <SettingsRow label={t('label_latest_accounts')}>
        {snapshot.financials ? (
          <>
            <span>
              <span className="text-muted-foreground">{t('net_sales')} </span>
              <span className="tabular-nums">
                {snapshot.financials.netSalesK != null
                  ? t('amount_tkr', { amount: snapshot.financials.netSalesK.toLocaleString('sv-SE') })
                  : '-'}
              </span>
            </span>
            <span>
              <span className="text-muted-foreground">{t('operating_profit')} </span>
              <span className="tabular-nums">
                {snapshot.financials.operatingProfitK != null
                  ? t('amount_tkr', { amount: snapshot.financials.operatingProfitK.toLocaleString('sv-SE') })
                  : '-'}
              </span>
            </span>
          </>
        ) : (
          <span className="text-muted-foreground">{t('no_financials')}</span>
        )}
      </SettingsRow>

      {datedStatuses.length > 0 && (
        <SettingsRow label={t('label_status')} align="baseline">
          <dl className="w-full space-y-1">
            {datedStatuses.map((s, i) => (
              <div key={`${s.code}-${i}`} className="flex items-center justify-between gap-3 text-sm">
                <dt className={s.isCeased ? 'text-destructive' : 'text-foreground'}>
                  {s.description ?? s.code ?? '-'}
                </dt>
                <dd className="text-xs text-muted-foreground tabular-nums">
                  {formatDate(s.statusDate!)}
                </dd>
              </div>
            ))}
          </dl>
        </SettingsRow>
      )}

      {fyLabel && (
        <SettingsRow label={t('label_fiscal_year')}>
          <span className="tabular-nums text-muted-foreground">{t('fiscal_year_current', { range: fyLabel })}</span>
        </SettingsRow>
      )}

      {signatoryRules.length > 0 && (
        <SettingsRow label={t('label_signatory')} align="baseline">
          <ul className="w-full space-y-1">
            {signatoryRules.map((rule, i) => (
              <li key={i} className="text-sm leading-6 text-muted-foreground">
                {rule}
              </li>
            ))}
          </ul>
        </SettingsRow>
      )}

      {Array.isArray(snapshot.representatives) && snapshot.representatives.length > 0 && (
        <SettingsRow label={t('label_representatives')} align="baseline">
          <div className="w-full">
            {snapshot.board && (
              <p className="mb-2 text-xs text-muted-foreground">
                {[
                  snapshot.board.numberOfBoardMembers != null
                    ? t('board_members', { count: snapshot.board.numberOfBoardMembers })
                    : null,
                  snapshot.board.numberOfDeputyBoardMembers != null
                    ? t('deputy_members', { count: snapshot.board.numberOfDeputyBoardMembers })
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            )}
            <ul className="space-y-1">
              {snapshot.representatives.map((r, i) => (
                <li key={`${r.name}-${i}`} className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-foreground">{r.name ?? '-'}</span>
                  <span className="text-right text-xs text-muted-foreground">
                    {[r.positionType, r.positionStart ? formatDate(r.positionStart) : null]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </SettingsRow>
      )}
    </>
  )
}
