import type { Metadata } from 'next'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { resolvePayslipToken } from '@/lib/salary/payslips/links'
import { loadPayslip } from '@/lib/salary/payslips/load-payslip'
import { effectiveRow, type EffectiveFiguresInput } from '@/lib/salary/effective-figures'
import { formatCurrency, formatDate } from '@/lib/utils'
import { getBranding } from '@/lib/branding/service'
import { ArrowDownTrayIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import {
  StandaloneFacts,
  StandaloneFile,
  StandaloneFrom,
  StandaloneHeading,
  StandaloneMessage,
  StandalonePage,
  StandaloneSmall,
} from '@/components/standalone/StandalonePage'

// The token is the authentication: no session, no company context. Swedish
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
  return <StandaloneMessage title={title} body={body} />
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

  const pdfHref = `/api/payslip/${token}/pdf`
  const pdfName = `Lönespecifikation ${monthName} ${run.period_year}.pdf`

  return (
    <StandalonePage width="link" brand={false}>
      <StandaloneFrom name={company.name} via={`via ${getBranding().appName}`} />
      <StandaloneHeading
        className="mt-5"
        eyebrow={emp ? <span data-ph-mask="">{emp.first_name} {emp.last_name}</span> : undefined}
        title={`Lönespecifikation ${monthName} ${run.period_year}`}
      />
      <p className="mt-2 font-display text-2xl tabular-nums text-strong" data-ph-mask="">
        {formatCurrency(figures.net_salary)}
      </p>
      <StandaloneFacts
        className="mt-5"
        rows={[
          { label: 'Bruttolön', value: formatCurrency(figures.gross_salary) },
          { label: 'Skatteavdrag', value: `−${formatCurrency(figures.tax_withheld)}` },
          figures.extra_tax_withheld > 0
            ? {
                label: <span className="pl-3 text-xs text-muted-foreground">varav extra skatteavdrag (begärt)</span>,
                value: <span className="text-xs">−{formatCurrency(figures.extra_tax_withheld)}</span>,
              }
            : null,
          { label: 'Nettolön', value: <span className="font-medium text-strong">{formatCurrency(figures.net_salary)}</span> },
          { label: 'Utbetalningsdag', value: formatDate(run.payment_date) },
        ]}
      />
      <div className="mt-4">
        <StandaloneFile name={pdfName} />
      </div>
      <Button asChild size="lg" className="mt-5 w-full">
        <a href={pdfHref} download>
          <ArrowDownTrayIcon className="h-4 w-4" />
          Ladda ner PDF
        </a>
      </Button>
      <StandaloneSmall>
        Länken är personlig: dela den inte vidare. PDF-filen innehåller den fullständiga specifikationen.
      </StandaloneSmall>
    </StandalonePage>
  )
}
