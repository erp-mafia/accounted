import { createTranslator } from 'next-intl'
import { getTranslations } from 'next-intl/server'
import { DocumentTextIcon, ExclamationCircleIcon } from '@/components/icons'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { resolveBrandForCompany } from '@/lib/branding/resolve'
import { formatCurrencyForCustomer } from '@/lib/email/invoice-templates'
import { createLogger } from '@/lib/logger'
import { loadReminderAnswer, REMINDER_ANSWER_NOTE_MAX } from '@/lib/reminders/answer'
import { cn, formatDate } from '@/lib/utils'
import { AnsweredCard, InvoiceActionForm, type InvoiceActionTexts } from './InvoiceActionForm'

/**
 * The customer's answer to a reminder: the link in every reminder mail. It
 * shows what is left to pay today and lets the customer say "Jag har
 * betalat" or "Något stämmer inte", with a short note if they like. Either
 * answer stops further reminders of the invoice, and the company sees it on
 * the invoice.
 *
 * Worded in the customer's language (customers.language), like the mail,
 * not in the visitor's app locale: the texts come from messages/<lang>.json,
 * namespace invoice_action, through a translator for that language. A link
 * that leads nowhere is answered in the visitor's own locale.
 */

export const dynamic = 'force-dynamic'

const log = createLogger('invoice-action/page')

type Brand = { appName: string; logoUrl: string | null; brandColor: string }

// Discreet brand mark shown when the invoice's company has a white-label
// brand (WL-13): logo when one exists, else the brand name in the brand color.
function BrandMark({ brand }: { brand: Brand }) {
  return (
    <div className="flex justify-center mb-6">
      {brand.logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={brand.logoUrl} alt={brand.appName} className="h-8 w-auto" />
      ) : (
        <span className="text-sm font-semibold tracking-wide" style={{ color: brand.brandColor }}>
          {brand.appName}
        </span>
      )}
    </div>
  )
}

function AmountRow({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex justify-between gap-4">
      <span className={strong ? 'font-medium' : 'text-muted-foreground'}>{label}</span>
      <span className={cn('tabular-nums', strong && 'text-lg font-semibold')}>{value}</span>
    </div>
  )
}

async function messagesFor(lang: 'sv' | 'en') {
  return lang === 'en' ? (await import('@/messages/en.json')).default : (await import('@/messages/sv.json')).default
}

export default async function InvoiceActionPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params

  let answer: Awaited<ReturnType<typeof loadReminderAnswer>> = null
  let failed = false
  try {
    answer = await loadReminderAnswer(createServiceClientNoCookies(), token)
  } catch (error) {
    log.error('reminder answer page failed', error as Error)
    failed = true
  }

  if (!answer) {
    const t = await getTranslations('invoice_action')
    return (
      <div className="min-h-dvh bg-frame flex items-center justify-center p-4">
        <Card className="max-w-md w-full">
          <CardContent className="pt-6 text-center">
            <ExclamationCircleIcon className="h-12 w-12 text-destructive mx-auto mb-4" />
            <p className="text-muted-foreground">{failed ? t('error_default') : t('error_link_invalid')}</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  const { view } = answer
  const lang = view.language
  const t = createTranslator({ locale: lang, messages: await messagesFor(lang), namespace: 'invoice_action' })
  const resolved = await resolveBrandForCompany(answer.companyId)
  const brand: Brand | null = resolved ? { appName: resolved.appName, logoUrl: resolved.logoUrl, brandColor: resolved.brandColor } : null
  const company = view.companyName || t('sender_fallback')
  const money = (amount: number, currency: string) => formatCurrencyForCustomer(amount, currency, lang)

  const texts: InvoiceActionTexts = {
    question: t('question'),
    questionHelp: t('question_help', { company }),
    paidOption: t('paid_option'),
    paidHelp: t('paid_help'),
    disputedOption: t('disputed_option'),
    disputedHelp: t('disputed_help'),
    notePaid: t('note_paid'),
    noteDisputed: t('note_disputed'),
    send: t('send'),
    thanks: t('thanks'),
    thanksBody: t('thanks_body', { company }),
    answeredPaid: t('answered_paid'),
    answeredDisputed: t('answered_disputed'),
    invoiceLabel: t('invoice_label'),
    errors: {
      LINK_INVALID: t('error_link_invalid'),
      NOTE_TOO_LONG: t('error_note_too_long', { max: REMINDER_ANSWER_NOTE_MAX }),
      default: t('error_default'),
    },
  }

  const hasLegacyCharges = view.interestAmount > 0 || view.reminderFee > 0
  // A credited, cancelled or written-off invoice is settled without being
  // paid: no amounts, no answer form, and a sentence that does not say paid.
  const settled = view.closedAs !== null || (view.remaining <= 0 && !hasLegacyCharges)
  const settledText =
    view.closedAs === 'credited'
      ? t('settled_credited', { company })
      : view.closedAs
        ? t('settled_closed', { company })
        : t('settled', { company })
  const toPay = hasLegacyCharges ? view.totalDue : view.remaining
  const interestLabel =
    view.interestRate > 0 && view.interestDays != null
      ? t('interest_detail', {
          rate: (view.interestRate * 100).toLocaleString(lang === 'en' ? 'en-GB' : 'sv-SE', { maximumFractionDigits: 2 }),
          days: view.interestDays,
        })
      : t('interest')

  const invoiceCard = (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <DocumentTextIcon className="h-5 w-5" />
          {t('details')}
        </CardTitle>
        {view.customerName && (
          <CardDescription>
            {/* data-ph-mask: the customer name is user data */}
            {t('to')} <span data-ph-mask="">{view.customerName}</span>
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-sm text-muted-foreground">{t('invoice_date')}</p>
            <p className="font-medium">{formatDate(view.invoiceDate)}</p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">{t('due_date')}</p>
            <p className="font-medium">{formatDate(view.dueDate)}</p>
          </div>
        </div>

        {settled ? (
          <p className="rounded-lg bg-muted p-4 text-sm">{settledText}</p>
        ) : (
          <div className="rounded-lg border border-border p-4 space-y-1 text-sm">
            {view.paid > 0 && (
              <>
                <AmountRow label={t('amount')} value={money(view.amount, view.currency)} />
                <AmountRow label={t('paid')} value={money(view.paid, view.currency)} />
              </>
            )}
            {view.interestAmount > 0 && <AmountRow label={interestLabel} value={money(view.interestAmount, view.currency)} />}
            {view.reminderFee > 0 && <AmountRow label={t('fee')} value={money(view.reminderFee, view.reminderFeeCurrency)} />}
            <div className={cn((view.paid > 0 || hasLegacyCharges) && 'border-t border-border pt-2 mt-2')}>
              <AmountRow
                strong
                label={t('to_pay')}
                value={
                  money(toPay, view.currency) +
                  (view.feeDueSeparately > 0 ? ` + ${money(view.feeDueSeparately, view.reminderFeeCurrency)}` : '')
                }
              />
            </div>
            {view.feeDueSeparately > 0 && <p className="pt-2 text-xs text-muted-foreground">{t('fee_separately')}</p>}
          </div>
        )}
      </CardContent>
    </Card>
  )

  return (
    <div className="min-h-dvh bg-frame py-12 px-4">
      <div className="max-w-lg mx-auto">
        {brand && <BrandMark brand={brand} />}
        <div className="text-center mb-8">
          <h1 className="text-2xl text-foreground mb-2">{t('heading_company', { company })}</h1>
          <p className="text-muted-foreground">{t('invoice', { number: view.invoiceNumber ?? '' })}</p>
        </div>

        {view.alreadyResponded ? (
          <AnsweredCard texts={texts} response={view.previousResponse} invoiceNumber={view.invoiceNumber} />
        ) : settled ? (
          invoiceCard
        ) : (
          <InvoiceActionForm token={token} texts={texts} invoiceNumber={view.invoiceNumber}>
            {invoiceCard}
          </InvoiceActionForm>
        )}

        {!view.closedAs && <p className="text-center text-sm text-muted-foreground mt-6">{t('payment_delay', { company })}</p>}
      </div>
    </div>
  )
}
