/**
 * Seed script: populate data for export extensions
 *
 * Creates EU customers, foreign-currency invoices, and journal entries
 * so that all 4 export extensions (EU Sales List, VAT Monitor, Intrastat,
 * Currency Receivables) have data to display.
 *
 * Usage:  node scripts/seed-export-data.mjs
 */

import { createClient } from '@supabase/supabase-js'
import 'dotenv/config'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !serviceRoleKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, serviceRoleKey)

// ── Helpers ─────────────────────────────────────────────────

function round2(n) {
  return Math.round(n * 100) / 100
}

function randomId() {
  return crypto.randomUUID()
}

function today() {
  return new Date().toISOString().split('T')[0]
}

function daysAgo(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().split('T')[0]
}

function daysFromNow(n) {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return d.toISOString().split('T')[0]
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  // 1. Find the user
  const { data: { users }, error: usersError } = await supabase.auth.admin.listUsers()
  if (usersError) {
    console.error('Failed to list users:', usersError.message)
    process.exit(1)
  }

  if (users.length === 0) {
    console.error('No users found. Please sign up first.')
    process.exit(1)
  }

  const user = users[0]
  const userId = user.id
  console.log(`Using user: ${user.email} (${userId})`)

  // 2. Ensure company settings exist
  const { data: company, error: companyError } = await supabase
    .from('company_settings')
    .select('*')
    .eq('user_id', userId)
    .single()

  if (companyError || !company) {
    console.error('No company_settings found. Complete onboarding first.')
    process.exit(1)
  }

  console.log(`Company: ${company.company_name || '(unnamed)'}`)

  // 3. Ensure fiscal period exists for current year
  const year = new Date().getFullYear()
  const periodStart = `${year}-01-01`
  const periodEnd = `${year}-12-31`

  let { data: fiscalPeriod } = await supabase
    .from('fiscal_periods')
    .select('*')
    .eq('user_id', userId)
    .lte('period_start', today())
    .gte('period_end', today())
    .limit(1)
    .single()

  if (!fiscalPeriod) {
    console.log(`Creating fiscal period for ${year}...`)
    const { data: newPeriod, error: periodError } = await supabase
      .from('fiscal_periods')
      .insert({
        id: randomId(),
        user_id: userId,
        name: `Räkenskapsår ${year}`,
        period_start: periodStart,
        period_end: periodEnd,
        is_closed: false,
      })
      .select()
      .single()

    if (periodError) {
      console.error('Failed to create fiscal period:', periodError.message)
      process.exit(1)
    }
    fiscalPeriod = newPeriod
  }

  console.log(`Fiscal period: ${fiscalPeriod.name} (${fiscalPeriod.period_start} to ${fiscalPeriod.period_end})`)

  // 4. Create EU customers
  const customers = [
    {
      id: randomId(),
      user_id: userId,
      name: 'TechHaus GmbH',
      customer_type: 'eu_business',
      email: 'billing@techhaus.de',
      country: 'Germany',
      org_number: 'HRB 12345',
      vat_number: 'DE123456789',
      vat_number_validated: true,
      default_payment_terms: 30,
      address_line1: 'Friedrichstraße 42',
      postal_code: '10117',
      city: 'Berlin',
    },
    {
      id: randomId(),
      user_id: userId,
      name: 'Suomen Softworks Oy',
      customer_type: 'eu_business',
      email: 'invoices@suomensoftworks.fi',
      country: 'Finland',
      org_number: '1234567-8',
      vat_number: 'FI12345678',
      vat_number_validated: true,
      default_payment_terms: 30,
      address_line1: 'Mannerheimintie 10',
      postal_code: '00100',
      city: 'Helsinki',
    },
    {
      id: randomId(),
      user_id: userId,
      name: 'Oranje Logistics B.V.',
      customer_type: 'eu_business',
      email: 'finance@oranjelogistics.nl',
      country: 'Netherlands',
      org_number: 'KvK 87654321',
      vat_number: 'NL123456789B01',
      vat_number_validated: true,
      default_payment_terms: 14,
      address_line1: 'Keizersgracht 120',
      postal_code: '1015 AA',
      city: 'Amsterdam',
    },
  ]

  console.log('\nCreating 3 EU customers...')
  const { error: custError } = await supabase.from('customers').insert(customers)
  if (custError) {
    console.error('Failed to create customers:', custError.message)
    process.exit(1)
  }
  for (const c of customers) {
    console.log(`  ✓ ${c.name} (${c.vat_number})`)
  }

  // 5. Create invoices
  // Mix of: SEK reverse_charge, EUR reverse_charge, USD
  const nextNum = company.next_invoice_number || 1

  const invoices = [
    // Invoice 1: SEK reverse_charge to German customer (for EU Sales List: goods)
    {
      id: randomId(),
      user_id: userId,
      customer_id: customers[0].id,
      invoice_number: `${company.invoice_prefix || 'F'}${String(nextNum).padStart(4, '0')}`,
      invoice_date: daysAgo(20),
      due_date: daysFromNow(10),
      status: 'sent',
      currency: 'SEK',
      document_type: 'invoice',
      vat_treatment: 'reverse_charge',
      vat_rate: 0,
      subtotal: 85000,
      subtotal_sek: 85000,
      vat_amount: 0,
      vat_amount_sek: 0,
      total: 85000,
      total_sek: 85000,
      exchange_rate: null,
      moms_ruta: '35',
      reverse_charge_text: 'Reverse charge: VAT to be accounted for by the recipient according to article 196 Council Directive 2006/112/EC',
    },
    // Invoice 2: EUR reverse_charge to Finnish customer (for EU Sales List: services + Currency Receivables)
    {
      id: randomId(),
      user_id: userId,
      customer_id: customers[1].id,
      invoice_number: `${company.invoice_prefix || 'F'}${String(nextNum + 1).padStart(4, '0')}`,
      invoice_date: daysAgo(15),
      due_date: daysFromNow(15),
      status: 'sent',
      currency: 'EUR',
      document_type: 'invoice',
      vat_treatment: 'reverse_charge',
      vat_rate: 0,
      subtotal: 5000,
      subtotal_sek: 57500,
      vat_amount: 0,
      vat_amount_sek: 0,
      total: 5000,
      total_sek: 57500,
      exchange_rate: 11.50,
      exchange_rate_date: daysAgo(15),
      moms_ruta: '39',
      reverse_charge_text: 'Reverse charge: VAT to be accounted for by the recipient according to article 196 Council Directive 2006/112/EC',
    },
    // Invoice 3: EUR reverse_charge to Dutch customer: goods (for EU Sales List + Currency Receivables)
    {
      id: randomId(),
      user_id: userId,
      customer_id: customers[2].id,
      invoice_number: `${company.invoice_prefix || 'F'}${String(nextNum + 2).padStart(4, '0')}`,
      invoice_date: daysAgo(10),
      due_date: daysFromNow(20),
      status: 'sent',
      currency: 'EUR',
      document_type: 'invoice',
      vat_treatment: 'reverse_charge',
      vat_rate: 0,
      subtotal: 12000,
      subtotal_sek: 138000,
      vat_amount: 0,
      vat_amount_sek: 0,
      total: 12000,
      total_sek: 138000,
      exchange_rate: 11.50,
      exchange_rate_date: daysAgo(10),
      moms_ruta: '35',
      reverse_charge_text: 'Reverse charge: VAT to be accounted for by the recipient according to article 196 Council Directive 2006/112/EC',
    },
    // Invoice 4: USD to Dutch customer: overdue (for Currency Receivables)
    {
      id: randomId(),
      user_id: userId,
      customer_id: customers[2].id,
      invoice_number: `${company.invoice_prefix || 'F'}${String(nextNum + 3).padStart(4, '0')}`,
      invoice_date: daysAgo(45),
      due_date: daysAgo(15),
      status: 'overdue',
      currency: 'USD',
      document_type: 'invoice',
      vat_treatment: 'reverse_charge',
      vat_rate: 0,
      subtotal: 8500,
      subtotal_sek: 91800,
      vat_amount: 0,
      vat_amount_sek: 0,
      total: 8500,
      total_sek: 91800,
      exchange_rate: 10.80,
      exchange_rate_date: daysAgo(45),
      moms_ruta: '35',
      reverse_charge_text: 'Reverse charge: VAT to be accounted for by the recipient according to article 196 Council Directive 2006/112/EC',
    },
    // Invoice 5: Paid SEK reverse_charge to Finnish customer (for EU Sales List history)
    {
      id: randomId(),
      user_id: userId,
      customer_id: customers[1].id,
      invoice_number: `${company.invoice_prefix || 'F'}${String(nextNum + 4).padStart(4, '0')}`,
      invoice_date: daysAgo(60),
      due_date: daysAgo(30),
      status: 'paid',
      currency: 'SEK',
      document_type: 'invoice',
      vat_treatment: 'reverse_charge',
      vat_rate: 0,
      subtotal: 42000,
      subtotal_sek: 42000,
      vat_amount: 0,
      vat_amount_sek: 0,
      total: 42000,
      total_sek: 42000,
      exchange_rate: null,
      moms_ruta: '39',
      reverse_charge_text: 'Reverse charge: VAT to be accounted for by the recipient according to article 196 Council Directive 2006/112/EC',
    },
  ]

  console.log('\nCreating 5 invoices...')
  const { error: invError } = await supabase.from('invoices').insert(invoices)
  if (invError) {
    console.error('Failed to create invoices:', invError.message)
    process.exit(1)
  }

  for (const inv of invoices) {
    const cust = customers.find(c => c.id === inv.customer_id)
    console.log(`  ✓ ${inv.invoice_number}, ${cust.name}, ${inv.currency} ${inv.total} (${inv.status})`)
  }

  // 6. Create invoice items
  const invoiceItems = [
    // Invoice 1 items (SEK goods to Germany)
    { id: randomId(), invoice_id: invoices[0].id, description: 'Industrial sensors batch', quantity: 50, unit: 'st', unit_price: 1200, line_total: 60000, sort_order: 1 },
    { id: randomId(), invoice_id: invoices[0].id, description: 'Installation & calibration', quantity: 10, unit: 'tim', unit_price: 2500, line_total: 25000, sort_order: 2 },
    // Invoice 2 items (EUR services to Finland)
    { id: randomId(), invoice_id: invoices[1].id, description: 'Software consulting', quantity: 40, unit: 'tim', unit_price: 125, line_total: 5000, sort_order: 1 },
    // Invoice 3 items (EUR goods to Netherlands)
    { id: randomId(), invoice_id: invoices[2].id, description: 'Steel components CN:72163100', quantity: 200, unit: 'st', unit_price: 45, line_total: 9000, sort_order: 1 },
    { id: randomId(), invoice_id: invoices[2].id, description: 'Aluminium fittings CN:76169990', quantity: 100, unit: 'st', unit_price: 30, line_total: 3000, sort_order: 2 },
    // Invoice 4 items (USD goods to Netherlands)
    { id: randomId(), invoice_id: invoices[3].id, description: 'Custom machine parts', quantity: 25, unit: 'st', unit_price: 340, line_total: 8500, sort_order: 1 },
    // Invoice 5 items (SEK services to Finland)
    { id: randomId(), invoice_id: invoices[4].id, description: 'IT architecture review', quantity: 24, unit: 'tim', unit_price: 1750, line_total: 42000, sort_order: 1 },
  ]

  const { error: itemsError } = await supabase.from('invoice_items').insert(invoiceItems)
  if (itemsError) {
    console.error('Failed to create invoice items:', itemsError.message)
    process.exit(1)
  }
  console.log(`  ✓ ${invoiceItems.length} invoice items created`)

  // Update next_invoice_number
  await supabase
    .from('company_settings')
    .update({ next_invoice_number: nextNum + 5 })
    .eq('user_id', userId)

  // 7. Create journal entries for the invoices (reverse charge: debit 1510, credit 3305/3308)
  // These are needed for VAT Monitor and EU Sales List cross-check
  const journalEntries = []
  const journalLines = []

  // Get current max voucher number
  const { data: maxVoucher } = await supabase
    .from('journal_entries')
    .select('voucher_number')
    .eq('user_id', userId)
    .order('voucher_number', { ascending: false })
    .limit(1)
    .single()

  let voucherNum = (maxVoucher?.voucher_number || 0) + 1

  for (const inv of invoices) {
    const entryId = randomId()
    const totalSEK = inv.total_sek

    // Determine revenue account: goods = 3305, services = 3308
    // moms_ruta 35 = goods, 39 = services
    const revenueAccount = inv.moms_ruta === '35' ? '3305' : '3308'

    journalEntries.push({
      id: entryId,
      user_id: userId,
      fiscal_period_id: fiscalPeriod.id,
      voucher_number: voucherNum++,
      voucher_series: 'A',
      entry_date: inv.invoice_date,
      description: `Faktura ${inv.invoice_number}: ${customers.find(c => c.id === inv.customer_id).name}`,
      source_type: 'invoice_created',
      source_id: inv.id,
      status: 'posted',
      committed_at: new Date().toISOString(),
    })

    // Debit 1510 (accounts receivable)
    journalLines.push({
      id: randomId(),
      journal_entry_id: entryId,
      account_number: '1510',
      debit_amount: round2(totalSEK),
      credit_amount: 0,
      currency: inv.currency,
      amount_in_currency: inv.currency !== 'SEK' ? inv.total : null,
      exchange_rate: inv.exchange_rate,
      line_description: `Kundfordran ${inv.invoice_number}`,
      sort_order: 1,
    })

    // Credit revenue account (3305 export goods or 3308 EU services)
    journalLines.push({
      id: randomId(),
      journal_entry_id: entryId,
      account_number: revenueAccount,
      debit_amount: 0,
      credit_amount: round2(totalSEK),
      currency: 'SEK',
      line_description: `Intäkt ${inv.invoice_number}`,
      sort_order: 2,
    })
  }

  // Add a payment entry for invoice 5 (paid): debit 1930, credit 1510
  const paymentEntryId = randomId()
  journalEntries.push({
    id: paymentEntryId,
    user_id: userId,
    fiscal_period_id: fiscalPeriod.id,
    voucher_number: voucherNum++,
    voucher_series: 'A',
    entry_date: daysAgo(25),
    description: `Betalning ${invoices[4].invoice_number}: Suomen Softworks Oy`,
    source_type: 'invoice_paid',
    source_id: invoices[4].id,
    status: 'posted',
    committed_at: new Date().toISOString(),
  })

  journalLines.push({
    id: randomId(),
    journal_entry_id: paymentEntryId,
    account_number: '1930',
    debit_amount: 42000,
    credit_amount: 0,
    currency: 'SEK',
    line_description: `Inbetalning ${invoices[4].invoice_number}`,
    sort_order: 1,
  })

  journalLines.push({
    id: randomId(),
    journal_entry_id: paymentEntryId,
    account_number: '1510',
    debit_amount: 0,
    credit_amount: 42000,
    currency: 'SEK',
    line_description: `Reglering ${invoices[4].invoice_number}`,
    sort_order: 2,
  })

  // Add a small FX gain entry (for Currency Receivables realized FX)
  const fxEntryId = randomId()
  journalEntries.push({
    id: fxEntryId,
    user_id: userId,
    fiscal_period_id: fiscalPeriod.id,
    voucher_number: voucherNum++,
    voucher_series: 'A',
    entry_date: daysAgo(25),
    description: 'Kursdifferens vid betalning',
    source_type: 'invoice_paid',
    status: 'posted',
    committed_at: new Date().toISOString(),
  })

  journalLines.push({
    id: randomId(),
    journal_entry_id: fxEntryId,
    account_number: '1930',
    debit_amount: 450,
    credit_amount: 0,
    currency: 'SEK',
    line_description: 'Valutavinst',
    sort_order: 1,
  })

  journalLines.push({
    id: randomId(),
    journal_entry_id: fxEntryId,
    account_number: '3960',
    debit_amount: 0,
    credit_amount: 450,
    currency: 'SEK',
    line_description: 'Valutakursvinst',
    sort_order: 2,
  })

  console.log(`\nCreating ${journalEntries.length} journal entries...`)
  const { error: jeError } = await supabase.from('journal_entries').insert(journalEntries)
  if (jeError) {
    console.error('Failed to create journal entries:', jeError.message)
    process.exit(1)
  }

  const { error: jlError } = await supabase.from('journal_entry_lines').insert(journalLines)
  if (jlError) {
    console.error('Failed to create journal entry lines:', jlError.message)
    console.error('Cleaning up journal entries...')
    await supabase.from('journal_entries').delete().in('id', journalEntries.map(e => e.id))
    process.exit(1)
  }

  for (const je of journalEntries) {
    console.log(`  ✓ A${je.voucher_number}: ${je.description}`)
  }

  // 8. Add Intrastat product metadata via extension_data
  console.log('\nCreating Intrastat product registry...')
  const extensionId = 'export/intrastat'
  const extensionData = [
    {
      user_id: userId,
      extension_id: extensionId,
      key: 'product:STEEL-COMP',
      value: { description: 'Steel components', cn_code: '72163100', net_weight_kg: 2.4, country_of_origin: 'SE' },
    },
    {
      user_id: userId,
      extension_id: extensionId,
      key: 'product:ALU-FIT',
      value: { description: 'Aluminium fittings', cn_code: '76169990', net_weight_kg: 0.8, country_of_origin: 'SE' },
    },
    {
      user_id: userId,
      extension_id: extensionId,
      key: 'product:IND-SENSOR',
      value: { description: 'Industrial sensors', cn_code: '90318080', net_weight_kg: 0.35, country_of_origin: 'SE' },
    },
  ]

  const { error: extError } = await supabase.from('extension_data').insert(extensionData)
  if (extError) {
    console.error('Warning: Failed to create extension_data (Intrastat products):', extError.message)
    console.log('  (Export extensions will still work, just Intrastat product registry will be empty)')
  } else {
    for (const ed of extensionData) {
      console.log(`  ✓ ${ed.key}: ${ed.value.description} (CN: ${ed.value.cn_code})`)
    }
  }

  // Done
  console.log('\n════════════════════════════════════════════════════')
  console.log('  Seed data created successfully!')
  console.log('════════════════════════════════════════════════════')
  console.log('\nYou should now see data in:')
  console.log('  • Periodisk sammanställning (EU Sales List): 3 EU customers, 5 invoices')
  console.log('  • Exportmoms-monitor (VAT Monitor): journal entries on 3305/3308')
  console.log('  • Intrastat: goods invoices + product registry')
  console.log('  • Valutafordringar (Currency Receivables): 3 open EUR/USD invoices')
  console.log('\nSelect the current month/quarter to see the data.')
}

main().catch(err => {
  console.error('Unexpected error:', err)
  process.exit(1)
})
