import { createTranslator } from 'next-intl'
import { getTranslations } from 'next-intl/server'
import {
  StandaloneFacts,
  StandaloneFrom,
  StandaloneHeading,
  StandaloneMessage,
  StandalonePage,
  StandaloneSmall,
} from '@/components/standalone/StandalonePage'
import { getBranding } from '@/lib/branding/service'
import { firstSentence } from '@/lib/settings/first-sentence'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { resolveBrandForCompany } from '@/lib/branding/resolve'
import { formatCurrencyForCustomer } from '@/lib/email/invoice-templates'
import { createLogger } from '@/lib/logger'
import { loadReminderAnswer, REMINDER_ANSWER_NOTE_MAX } from '@/lib/reminders/answer'
import { formatDate } from '@/lib/utils'
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

type Brand = { appName: string; logoUrl: string | null }

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
    const { first, rest } = firstSentence(failed ? t('error_default') : t('error_link_invalid'))
    // A heading carries no full stop; the rest of the sentence pair is the line under it.
    return <StandaloneMessage title={first.replace(/\.$/, '')} body={rest ?? undefined} />
  }

  const { view } = answer
  const lang = view.language
  const messages = await messagesFor(lang)
  const t = createTranslator({ locale: lang, messages, namespace: 'invoice_action' })
  const tSigning = createTranslator({ locale: lang, messages, namespace: 'signing_page' })
  const resolved = await resolveBrandForCompany(answer.companyId)
  const brand: Brand | null = resolved ? { appName: resolved.appName, logoUrl: resolved.logoUrl } : null
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
  const toPayText =
    money(toPay, view.currency) +
    (view.feeDueSeparately > 0 ? ` + ${money(view.feeDueSeparately, view.reminderFeeCurrency)}` : '')
  const interestLabel =
    view.interestRate > 0 && view.interestDays != null
      ? t('interest_detail', {
          rate: (view.interestRate * 100).toLocaleString(lang === 'en' ? 'en-GB' : 'sv-SE', { maximumFractionDigits: 2 }),
          days: view.interestDays,
        })
      : t('interest')

  const via = brand?.logoUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={brand.logoUrl} alt={brand.appName} className="h-5 w-auto" />
  ) : (
    tSigning('via', { platform: brand?.appName ?? getBranding().appName })
  )

  const facts = (
    <>
      <StandaloneFacts
        className="mt-5"
        rows={[
          view.customerName ? { label: t('to').replace(/:$/, ''), value: view.customerName } : null,
          { label: t('invoice_date'), value: formatDate(view.invoiceDate) },
          { label: t('due_date'), value: formatDate(view.dueDate) },
          !settled && view.paid > 0 ? { label: t('amount'), value: money(view.amount, view.currency) } : null,
          !settled && view.paid > 0 ? { label: t('paid'), value: money(view.paid, view.currency) } : null,
          !settled && view.interestAmount > 0 ? { label: interestLabel, value: money(view.interestAmount, view.currency) } : null,
          !settled && view.reminderFee > 0 ? { label: t('fee'), value: money(view.reminderFee, view.reminderFeeCurrency) } : null,
          !settled && (view.paid > 0 || hasLegacyCharges)
            ? { label: <span className="font-medium text-strong">{t('to_pay')}</span>, value: <span className="font-medium text-strong">{toPayText}</span> }
            : null,
        ]}
      />
      {settled && <p className="mt-4 text-sm text-foreground">{settledText}</p>}
      {!settled && view.feeDueSeparately > 0 && <p className="mt-2 text-xs text-muted-foreground">{t('fee_separately')}</p>}
    </>
  )

  return (
    <StandalonePage width="link" brand={false}>
      <StandaloneFrom name={company} via={via} />
      <StandaloneHeading
        className="mt-5"
        eyebrow={t('heading_company', { company })}
        title={t('invoice', { number: view.invoiceNumber ?? '' })}
      />
      {!settled && (
        <>
          <p className="mt-2 font-display text-2xl tabular-nums text-strong" data-ph-mask="">
            {toPayText}
          </p>
          <p className="text-xs text-muted-foreground">{t('to_pay')}</p>
        </>
      )}

      {view.alreadyResponded ? (
        <AnsweredCard texts={texts} response={view.previousResponse} invoiceNumber={view.invoiceNumber} />
      ) : settled ? (
        facts
      ) : (
        <InvoiceActionForm token={token} texts={texts} invoiceNumber={view.invoiceNumber}>
          {facts}
        </InvoiceActionForm>
      )}

      {!view.closedAs && <StandaloneSmall>{t('payment_delay', { company })}</StandaloneSmall>}
    </StandalonePage>
  )
}
