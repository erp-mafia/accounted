import { createServerClient } from '@supabase/ssr'
import { NextResponse } from 'next/server'

// Create a service client (no auth needed - public endpoint with token validation)
function createServiceClient() {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      cookies: {
        getAll() { return [] },
        setAll() { }
      }
    }
  )
}

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { token, action } = body

    if (!token) {
      return NextResponse.json({ error: 'Token saknas' }, { status: 400 })
    }

    if (!action || !['marked_paid', 'disputed'].includes(action)) {
      return NextResponse.json({ error: 'Ogiltig åtgärd' }, { status: 400 })
    }

    const supabase = createServiceClient()

    // Find the reminder by action token
    const { data: reminder, error: findError } = await supabase
      .from('invoice_reminders')
      .select(`
        *,
        invoice:invoices(
          id,
          invoice_number,
          status,
          user_id
        )
      `)
      .eq('action_token', token)
      .single()

    if (findError || !reminder) {
      return NextResponse.json(
        { error: 'Ogiltig eller utgången länk' },
        { status: 404 }
      )
    }

    // Check if token was already used
    if (reminder.action_token_used) {
      return NextResponse.json(
        { error: 'Denna länk har redan använts' },
        { status: 400 }
      )
    }

    // Update the reminder with the response
    const { error: updateError } = await supabase
      .from('invoice_reminders')
      .update({
        response_type: action,
        response_at: new Date().toISOString(),
        action_token_used: true
      })
      .eq('id', reminder.id)

    if (updateError) {
      console.error('Failed to update reminder:', updateError)
      return NextResponse.json(
        { error: 'Kunde inte spara ditt svar' },
        { status: 500 }
      )
    }

    // If customer marked as paid, we could optionally notify the business owner
    // For now, we just log it - the business owner will see it in the UI
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const invoiceData = reminder.invoice as any
    const invoice = Array.isArray(invoiceData) ? invoiceData[0] : invoiceData
    console.log(`Customer responded to invoice ${invoice?.invoice_number}: ${action}`)

    return NextResponse.json({
      success: true,
      message: action === 'marked_paid'
        ? 'Tack! Vi har noterat att du har betalat fakturan.'
        : 'Tack! Vi har noterat din invändning och kommer att kontakta dig.'
    })
  } catch (error) {
    console.error('Action handler error:', error)
    return NextResponse.json(
      { error: 'Ett fel uppstod' },
      { status: 500 }
    )
  }
}

// GET endpoint to fetch reminder/invoice info by token (for the public page)
export async function GET(request: Request) {
  const url = new URL(request.url)
  const token = url.searchParams.get('token')

  if (!token) {
    return NextResponse.json({ error: 'Token saknas' }, { status: 400 })
  }

  const supabase = createServiceClient()

  // Find the reminder by action token
  const { data: reminder, error: findError } = await supabase
    .from('invoice_reminders')
    .select(`
      id,
      reminder_level,
      sent_at,
      response_type,
      action_token_used,
      interest_amount,
      interest_rate,
      interest_from_date,
      interest_days,
      reminder_fee,
      invoice:invoices(
        id,
        invoice_number,
        invoice_date,
        due_date,
        total,
        currency,
        status,
        customer:customers(
          name
        )
      )
    `)
    .eq('action_token', token)
    .single()

  if (findError || !reminder) {
    return NextResponse.json(
      { error: 'Ogiltig eller utgången länk' },
      { status: 404 }
    )
  }

  // Don't expose sensitive data, just what's needed for the public page
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const invoiceData = reminder.invoice as any
  const invoice = Array.isArray(invoiceData) ? invoiceData[0] : invoiceData

  if (!invoice) {
    return NextResponse.json(
      { error: 'Faktura hittades inte' },
      { status: 404 }
    )
  }

  // Handle nested customer which may also be an array
  const customerData = invoice.customer
  const customer = Array.isArray(customerData) ? customerData[0] : customerData

  const interestAmount = Number(reminder.interest_amount ?? 0)
  const reminderFee = Number(reminder.reminder_fee ?? 0)
  const totalDue =
    Math.round((Number(invoice.total) + interestAmount + reminderFee) * 100) / 100

  return NextResponse.json({
    invoiceNumber: invoice.invoice_number,
    invoiceDate: invoice.invoice_date,
    dueDate: invoice.due_date,
    total: invoice.total,
    currency: invoice.currency,
    customerName: customer?.name,
    reminderLevel: reminder.reminder_level,
    alreadyResponded: reminder.action_token_used,
    previousResponse: reminder.response_type,
    // Dröjsmålsränta + lagstadgad påminnelseavgift surfaced to the
    // customer-facing action page. Numeric defaults preserve back-compat
    // for old reminders sent before the surcharge feature shipped.
    interestAmount,
    interestRate: reminder.interest_rate !== null ? Number(reminder.interest_rate) : 0,
    interestFromDate: reminder.interest_from_date,
    interestDays: reminder.interest_days,
    reminderFee,
    totalDue,
  })
}
