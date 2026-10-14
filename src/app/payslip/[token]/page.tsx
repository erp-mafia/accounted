import type { Metadata } from 'next'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { resolvePayslipToken } from '@/lib/salary/payslips/links'
import { loadPayslip } from '@/lib/salary/payslips/load-payslip'
import { effectiveRow, type EffectiveFiguresInput } from '@/lib/salary/effective-figures'
import { formatCurrency } from '@/lib/utils'

// The token is the authentication — no session, no company context. Swedish
// only (employee-facing). Never indexed.
export const metadata: Metadata = {
  title: 'Lönespecifikation',
  robots: { index: false, follow: false },
}

export const dynamic = 'force-dynamic'

const MONTH_NAMES = [
  'januari', 'februari', 'mars', 'april', 'maj', 'juni',
  'juli', 'augusti', 'september', 'oktober', 'november', 'december',
]

function MessageShell({ title, body }: { title: string; body: string }) {
  return (
    <main className="min-h-dvh bg-background flex items-center justify-center px-5">
      <div className="max-w-md w-full rounded-lg border border-border p-6 space-y-2">
        <h1 className="font-display text-2xl tracking-tight">{title}</h1>
        <p className="text-sm text-muted-foreground">{body}</p>
      </div>
    </main>
  )
}

export default async function PayslipPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const serviceClient = createServiceClientNoCookies()
  const resolved = await resolvePayslipToken(serviceClient, token)

  if (!resolved.ok) {
    if (resolved.reason === 'expired') {
      return (
        <MessageShell
          title="Länken har gått ut"
          body="Lönebeskedslänken är inte längre giltig. Be din arbetsgivare skicka lönespecifikationen igen."
        />
      )
    }
    if (resolved.reason === 'revoked') {
      return (
        <MessageShell
          title="Länken har ersatts"
          body="Lönekörningen har ersatts av en korrigerad lönekörning. Be din arbetsgivare skicka den nya lönespecifikationen."
        />
      )
    }
    return (
      <MessageShell
        title="Lönespecifikationen hittades inte"
        body="Länken är ogiltig. Kontrollera att du använder den senaste länken från e-postmeddelandet."
      />
    )
  }

  const { link } = resolved

  // The one payslip load (lib/salary/payslips/load-payslip.ts), so this page
  // shows the employer name and the figures the PDF prints: the effective
  // figures the booking and the AGI use (effectiveRow).
  const loaded = await loadPayslip(serviceClient, {
    companyId: link.company_id,
    salaryRunId: link.salary_run_id,
    employeeId: link.employee_id,
  })

  if (!loaded.ok) {
    return (
      <MessageShell
        title="Lönespecifikationen hittades inte"
        body="Underlaget kunde inte hämtas. Be din arbetsgivare skicka lönespecifikationen igen."
      />
    )
  }

  const { run, sre, employee: emp, company } = loaded.payslip
  const figures = effectiveRow({
    ...(sre as unknown as EffectiveFiguresInput),
    employee: { f_skatt_status: emp.f_skatt_status ?? null },
  })
  const monthName = MONTH_NAMES[run.period_month - 1]

  return (
    <main className="min-h-dvh bg-background flex items-center justify-center px-5 py-10">
      <div className="max-w-md w-full rounded-lg border border-border p-6 space-y-6">
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">{company.name}</p>
          <h1 className="font-display text-2xl tracking-tight">
            Lönespecifikation {monthName} {run.period_year}
          </h1>
          {emp && (
            <p className="text-sm text-muted-foreground">
              {emp.first_name} {emp.last_name}
            </p>
          )}
        </div>

        <dl className="space-y-3 text-sm">
          <div className="flex items-center justify-between">
            <dt className="text-muted-foreground">Bruttolön</dt>
            <dd className="tabular-nums">{formatCurrency(figures.gross_salary)}</dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="text-muted-foreground">Skatteavdrag</dt>
            <dd className="tabular-nums">−{formatCurrency(figures.tax_withheld)}</dd>
          </div>
          {figures.extra_tax_withheld > 0 && (
            <div className="flex items-center justify-between pl-3 text-xs">
              <dt className="text-muted-foreground">varav extra skatteavdrag (begärt)</dt>
              <dd className="tabular-nums text-muted-foreground">−{formatCurrency(figures.extra_tax_withheld)}</dd>
            </div>
          )}
          <div className="flex items-center justify-between border-t border-border pt-3">
            <dt className="font-medium">Nettolön</dt>
            <dd className="font-display text-xl tabular-nums">{formatCurrency(figures.net_salary)}</dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="text-muted-foreground">Utbetalningsdag</dt>
            <dd className="tabular-nums">{run.payment_date}</dd>
          </div>
        </dl>

        <a
          href={`/api/payslip/${token}/pdf`}
          className="inline-flex h-10 w-full items-center justify-center rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors duration-150 hover:bg-primary/90"
        >
          Ladda ner PDF (lönespecifikation)
        </a>

        <p className="text-xs text-muted-foreground">
          Länken är personlig — dela den inte vidare. PDF-filen innehåller den
          fullständiga specifikationen.
        </p>
      </div>
    </main>
  )
}
