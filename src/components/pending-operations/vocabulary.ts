// Shared vocabulary for pending_operations rendering: labels, warnings and
// rejection categories used by every surface that shows a staged operation
// (/pending, the chat approval card, future flow-run views). Moved here from
// app/(dashboard)/pending/page.tsx so the vocabulary has exactly one owner.

import type { PendingOperationRejectionCategory, PendingOperationSystemRejectionCategory } from '@/types'
import { isHighRisk, PENDING_OPERATION_TYPES } from '@/lib/pending-operations/risk-tiers'
import {
  isRegisterBookedInvoiceParams,
  registerBookedLedgerOf,
  type RegisterBookedLedger,
} from '@/lib/invoices/register-booked-invoice-mode'

// Short human label (i18n key in the "pending" namespace) for each staged
// operation_type: pending.type_<operation_type>, derived from the risk-tier
// table (lib/pending-operations/risk-tiers.ts), so every type an agent can
// stage has a key. operation-contract.test.ts checks both languages carry
// it; without one the Granskning list would show the raw snake_case name.
export const OPERATION_LABEL_KEYS: Readonly<Record<string, string>> = Object.fromEntries(
  PENDING_OPERATION_TYPES.map((type) => [type, `type_${type}`]),
)

// Fallback for an operation_type with no entry above (e.g. a newly added op
// not yet given a label): turn "create_supplier_invoice_from_inbox" into
// "Create supplier invoice from inbox" so it never surfaces as raw snake_case.
export function humanizeOperationType(operationType: string): string {
  const spaced = operationType.replace(/_/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/** The label key of a registration of an already-booked invoice, per reskontra (crm#1094). */
const REGISTER_BOOKED_LABEL_KEYS: Record<RegisterBookedLedger, string> = {
  customer: 'type_register_booked_invoice',
  supplier: 'type_register_booked_supplier_invoice',
}

/**
 * The label of a staged operation. A create_invoice staged by
 * gnubok_register_booked_invoice, or a create_supplier_invoice_from_inbox
 * staged by gnubok_register_booked_supplier_invoice, registers an invoice that
 * is already booked instead of creating one (crm#1094), so with its params it
 * gets its own label rather than "Ny faktura" or "Leverantörsfaktura".
 */
export function operationLabel(
  operationType: string,
  t: (key: string) => string,
  params?: Record<string, unknown> | null,
): string {
  const ledger = registerBookedLedgerOf(operationType, params)
  if (ledger) return t(REGISTER_BOOKED_LABEL_KEYS[ledger])
  const labelKey = OPERATION_LABEL_KEYS[operationType]
  return labelKey ? t(labelKey) : humanizeOperationType(operationType)
}

// Consequence sentences that are message keys in the "pending" namespace
// rather than literals in singleActionWarnings below: every new one, so it
// follows the user's language (swedish-ui-literal guard). Resolved by
// singleActionWarning when the caller passes its translator.
export const SINGLE_ACTION_WARNING_KEYS: Readonly<Record<string, string>> = {
  book_counterparty_setoff: 'warning_book_counterparty_setoff',
  book_inventory_count: 'warning_book_inventory_count',
  merge_customers: 'warning_merge_customers',
  request_signature: 'warning_request_signature',
  request_arsredovisning_signatures: 'warning_request_arsredovisning_signatures',
  reminder_daily_batch: 'warning_reminder_daily_batch',
  delete_asset: 'warning_delete_asset',
  post_asset_value_adjustment: 'warning_post_asset_value_adjustment',
  replace_asset_component: 'warning_replace_asset_component',
  set_asset_transition_split: 'warning_set_asset_transition_split',
  update_accounting_policies: 'warning_update_accounting_policies',
  commit_k3_transition: 'warning_commit_k3_transition',
  delete_fiscal_period: 'warning_delete_fiscal_period',
  register_share_event: 'warning_register_share_event',
  update_share_class: 'warning_update_share_class',
  confirm_beneficial_owners: 'warning_confirm_beneficial_owners',
  create_dividend: 'warning_create_dividend',
  book_dividend: 'warning_book_dividend',
  pay_dividend: 'warning_pay_dividend',
  create_shareholder_contribution: 'warning_create_shareholder_contribution',
  create_capital_change: 'warning_create_capital_change',
  book_capital_change: 'warning_book_capital_change',
  set_k10_owner_inputs: 'warning_set_k10_owner_inputs',
  create_owner_loan: 'warning_create_owner_loan',
  update_owner_loan: 'warning_update_owner_loan',
  set_owner_loan_interest: 'warning_set_owner_loan_interest',
  hold_corporate_meeting: 'warning_hold_corporate_meeting',
  save_tax_loss_carryforward: 'warning_save_tax_loss_carryforward',
  book_webshop_day: 'warning_book_webshop_day',
  // High-tier types that had no sentence, so their approval showed none (accounted#22).
  settle_rot_rut_payout: 'warning_settle_rot_rut_payout',
  post_kontantmetod_cutoff: 'warning_post_kontantmetod_cutoff',
  bulk_book_inbox_items: 'warning_bulk_book_inbox_items',
  book_salary_run: 'warning_book_salary_run',
  generate_agi: 'warning_generate_agi',
  vacation_year_close: 'warning_vacation_year_close',
  submit_vat_declaration: 'warning_submit_vat_declaration',
  submit_agi: 'warning_submit_agi',
}

/** The schedule types whose tier rises to 'high' with auto_send (risk-tiers.ts). */
const RECURRING_SCHEDULE_TYPES: ReadonlySet<string> = new Set(['create_recurring_schedule', 'update_recurring_schedule'])

// Full-sentence warning for the single-op confirmation dialog AND the inline
// list-view warning when risk is medium/high. The list-view truncates beyond
// one line; the dialog shows it in full. Order roughly low → high risk so
// reviewers scanning the source see the destructive paths grouped together.
export const singleActionWarnings: Record<string, string> = {
  // Low/medium risk: light verifikation work
  create_transaction: 'Genom att klicka godkänn så skapar du en transaktion.',
  create_customer: 'Genom att klicka godkänn så skapar du en kund.',
  update_supplier: 'Genom att klicka godkänn så ändras leverantörens uppgifter. Ändrade bankuppgifter gäller för nästa betalning till leverantören.',
  update_cash_account: 'Genom att klicka godkänn så ändras bankkontot. Ändrade betaluppgifter skrivs ut på nya fakturor.',
  set_primary_cash_account: 'Genom att klicka godkänn så blir kontot företagets primära bankkonto. Endast bokningar efter ändringen följer det nya kontot.',
  set_invoice_payee_default: 'Genom att klicka godkänn så betalar kunder nya fakturor i valutan till det valda bankkontot.',
  create_fiscal_period: 'Genom att klicka godkänn så skapas räkenskapsåret och kopplas in i kedjan av räkenskapsår. Det kan inte tas bort, och datumen kan bara ändras så länge inget bokfört hamnar utanför dem.',
  update_fiscal_period: 'Genom att klicka godkänn så ändras räkenskapsårets namn eller datum. Datumen går bara att ändra så länge alla verifikationer ligger kvar inom de nya datumen och inget lås, bokslut eller inlämnad deklaration gäller året.',
  close_fiscal_period_external: 'Genom att klicka godkänn så stängs och låses räkenskapsåret som avslutat i tidigare program, utan bokslutsverifikat i Accounted. Använd bara för importerade år vars bokslut gjordes i det gamla programmet.',
  reopen_fiscal_period_external: 'Genom att klicka godkänn så öppnas och låses räkenskapsåret upp igen, så att dess innehåll kan ändras. Klarmarkera eller lås det igen när rättelsen är klar.',
  delete_account: 'Genom att klicka godkänn så tas kontot bort ur kontoplanen. Det går bara för ett konto utan bokförda rader; ett standardkonto kan läggas till igen från BAS.',
  update_company_settings: 'Genom att klicka godkänn så ändras företagsinställningarna. Betalningsuppgifterna styr vart kunderna betalar kommande fakturor.',
  update_company_tax_profile: 'Genom att klicka godkänn så ändras företagets skatte- och momsuppgifter och skattedeadlines skapas om. Ändra bara det som redan gäller hos Skatteverket.',
  update_bookkeeping_lock: 'Genom att klicka godkänn så ändras låsdatumet för bokföringen. Flyttas det bakåt kan redan låsta datum ändras igen.',
  enable_package: 'Genom att klicka godkänn så slås paketet på: det syns i menyn och agentens verktyg för det blir tillgängliga. Bara en ägare eller administratör kan godkänna, och det går att dölja igen.',
  disable_package: 'Genom att klicka godkänn så stängs paketet av: inget nytt kan startas där. Det som fortfarande är öppet syns kvar och fungerar tills det är klart, sedan döljs paketet i menyn och agentens verktyg. Inget raderas, och det går att slå på igen.',
  create_grant: 'Genom att klicka godkänn så får agenter bokföra den här motpartens banktransaktioner själva, på exakt det sätt som visas och upp till beloppet, utan att fråga först. Allt som avviker väntar på godkännande som i dag. Du ser varje sådan bokföring under Bokfört enligt regel i Att göra och kan ångra den eller återkalla regeln. Bara en ägare eller administratör kan godkänna, och bara här i Accounted: en agent kan aldrig godkänna en regel.',
  revoke_grant: 'Genom att klicka godkänn så återkallas regeln: agenter bokför inte längre den här motparten själva, och allt väntar på godkännande igen. Det som redan bokförts enligt regeln finns kvar och listas, så att du kan granska det.',
  revoke_service_account: 'Genom att klicka godkänn så återkallas tjänstekontot och alla dess nycklar: nästa anrop med någon av dem nekas. Det går inte att ångra, och bara en ägare eller administratör kan godkänna. Det som kontot redan har gjort finns kvar och visar fortfarande kontots namn.',
  send_payslips: 'Genom att klicka godkänn så får varje anställd i lönekörningen ett e-postmeddelande med en säker länk till sitt lönebesked, och länkar som skickats tidigare slutar fungera.',
  unapprove_salary_run: 'Genom att klicka godkänn så återkallas godkännandet och lönekörningen går tillbaka till granskning. En genererad men inte inskickad AGI tas bort och en redan skapad betalfil räknas inte längre som aktuell.',
  attach_salary_expense_claims: 'Genom att klicka godkänn så läggs den anställdas öppna utlägg på lönebeskedet som skattefria rader och betalas ut med lönen.',
  add_salary_run_employee: 'Genom att klicka godkänn så läggs den anställda till i lönekörningen och får lön i den när lönekörningen räknas om.',
  remove_salary_run_employee: 'Genom att klicka godkänn så tas den anställda bort ur lönekörningen tillsammans med sina lönerader och får ingen lön i den.',
  add_payslip_line: 'Genom att klicka godkänn så läggs raden till på lönebeskedet i utkastet. Skatt, avgifter och nettolön ändras när lönekörningen räknas om.',
  delete_payslip_line: 'Genom att klicka godkänn så tas raden bort från lönebeskedet i utkastet. Skatt, avgifter och nettolön ändras när lönekörningen räknas om.',
  mark_salary_run_paid: 'Genom att klicka godkänn så markeras lönekörningen som utbetald med dagens datum. Godkänn bara när lönerna faktiskt har betalats ut.',
  correct_salary_run: 'Genom att klicka godkänn så stornas lönekörningens verifikationer och den markeras som rättad, lönebesked som redan skickats visas som ersatta, och ett nytt utkast för samma period skapas med samma anställda och rader. Arbetsgivardeklarationen för perioden behöver lämnas in på nytt när rättelsen är bokförd.',
  set_worked_days: 'Genom att klicka godkänn så registreras de arbetade timmarna. De styr timlönen i lönekörningar för perioden när de räknas om.',
  delete_worked_days: 'Genom att klicka godkänn så tas de arbetade timmarna bort, och timlönen för perioden ändras när lönekörningen räknas om.',
  add_employee_benefit: 'Genom att klicka godkänn så läggs förmånen till hos den anställda och räknas med i kommande lönekörningar.',
  update_employee_benefit: 'Genom att klicka godkänn så ändras förmånen, och det nya värdet räknas med i kommande lönekörningar.',
  delete_employee_benefit: 'Genom att klicka godkänn så tas förmånen bort från den anställda. Har en lönekörning redan räknat fram en lönerad från den behålls förmånen i stället som inaktiv, så att kopplingen till verifikationen finns kvar.',
  add_employee_recurring_line: 'Genom att klicka godkänn så läggs raden till på den anställdas lönebesked i kommande lönekörningar.',
  update_employee_recurring_line: 'Genom att klicka godkänn så ändras den återkommande raden i kommande lönekörningar.',
  delete_employee_recurring_line: 'Genom att klicka godkänn så tas den återkommande raden bort från kommande lönekörningar.',
  delete_employee: 'Genom att klicka godkänn så inaktiveras den anställda och tas inte med i nya lönekörningar. Lönehistoriken finns kvar, och den anställda kan återaktiveras från sidan Anställda (Visa inaktiva).',
  create_supplier_payment_batch: 'Genom att klicka godkänn så skapas en betalfil (pain.001) för de valda leverantörsfakturorna. Inget bokförs, men när filen laddas upp och signeras i banken betalas beloppen ut till leverantörernas konton.',
  cancel_supplier_payment_batch: 'Genom att klicka godkänn så makuleras betalfilen och den kan inte laddas ner igen. En fil som redan laddats upp i banken återkallas inte: stoppa betalningen i banken.',
  prepare_payment_orders: 'Genom att klicka godkänn så förbereds bankbetalningar som utkast för de valda leverantörsfakturorna. Inget skickas till banken: betalningarna godkänns och signeras med BankID av en person på sidan Betalningar.',
  cancel_payment_order: 'Genom att klicka godkänn så makuleras bankbetalningen. Har banken redan tagit emot den frågas banken först, och betalningen makuleras bara om banken bekräftar det.',
  confirm_supplier_payee: 'Genom att klicka godkänn så intygar du att leverantörens nya bankuppgifter är riktiga, och fakturor till det kontot kan betalas. Kontrollera uppgifterna med leverantören på ett känt nummer, aldrig via fakturan eller dess e-post: ändrade bankuppgifter är det vanligaste fakturabedrägeriet.',
  bank_feed_invite: 'Genom att klicka godkänn så skapas en länk som gäller i sju dagar och där företagets firmatecknare kopplar banken med BankID utan att logga in i Accounted. Finns en mottagare skickas länken med e-post. Länken är själva behörigheten: lämna den bara till firmatecknaren.',
  request_payment_signature: 'Genom att klicka godkänn så skapas en länk som gäller i 72 timmar och där företagets firmatecknare granskar och signerar de godkända bankbetalningarna med BankID utan att logga in i Accounted. Finns en mottagare skickas länken med e-post. Inget betalas förrän firmatecknaren har signerat. Länken är själva behörigheten: lämna den bara till den som ska signera.',
  book_invoice: 'Genom att klicka godkänn så bokförs kundfakturan med ett verifikat på fakturadatumet. Verifikatet kan inte ändras i efterhand, bara rättas med storno.',
  bulk_book_invoices: 'Genom att klicka godkänn så bokförs de valda kundfakturorna var för sig, och utkast utfärdas med fakturanummer och markeras som skickade (utan e-post) innan de bokförs. Fakturor som inte kan bokföras hoppas över och redovisas i resultatet.',
  book_supplier_invoice: 'Genom att klicka godkänn så bokförs leverantörsfakturan med ett verifikat på fakturadatumet. Verifikatet kan inte ändras i efterhand, bara rättas med storno.',
  create_expense_claim: 'Genom att klicka godkänn så registreras utlägget och en verifikation bokförs mot personens skuldkonto.',
  delete_expense_claim: 'Genom att klicka godkänn så tas utlägget bort och dess verifikation vänds med en storno-verifikation.',
  record_expense_payout: 'Genom att klicka godkänn så bokförs utbetalningen av utläggen och de markeras som betalda.',
  match_expense_payout: 'Genom att klicka godkänn så bokförs transaktionen som återbetalning av utläggen och kopplas till verifikationen.',
  link_transaction_journal_entry: 'Genom att klicka godkänn så kopplas banktransaktionen till ett verifikat som redan är bokfört. Inget nytt bokförs; med en kundfaktura markeras fakturan som betald mot samma verifikat.',
  match_batch_allocate: 'Genom att klicka godkänn så bokförs en samlingsverifikation som fördelar betalningen på fakturorna, och varje faktura markeras som betald eller delbetald. Verifikatet kan inte ändras i efterhand, bara rättas med storno.',
  bulk_book_transactions: 'Genom att klicka godkänn så bokförs de valda banktransaktionerna som en samlingsverifikation, eller kopplas till det verifikat som redan bokför dem. Verifikatet kan inte ändras i efterhand, bara rättas med storno.',
  delete_document: 'Genom att klicka godkänn så raderas underlaget och filen permanent. Det går inte att ångra.',
  delete_inbox_item: 'Genom att klicka godkänn så tas posten bort ur inkorgen permanent; själva dokumentet finns kvar i arkivet.',
  undo_bank_import: 'Genom att klicka godkänn så raderas alla obokförda transaktioner som bankfilsimporten skapade, även ignorerade, och importen markeras som ångrad. Bokförda transaktioner och deras verifikationer lämnas orörda.',
  correct_entry_metadata: 'Genom att klicka godkänn så rättas verifikationens text och/eller datum i samma verifikat. Gamla och nya värden loggas med vem och när (BFL 5 kap 5 §).',
  correct_entry_lines_inline: 'Genom att klicka godkänn så stryks de valda raderna och ersätts med de nya i samma verifikat. De strukna raderna sparas i rättelseloggen med vem och när (BFL 5 kap 5 §).',
  redate_entry: 'Genom att klicka godkänn så stornas verifikationen på sitt ursprungliga datum och en likadan verifikation bokförs på det nya datumet. Båda får nya verifikationsnummer.',
  mark_no_document_required: 'Genom att klicka godkänn så markeras verifikaten som att inget underlag krävs och försvinner från listan över saknade underlag. Verifikaten ändras inte.',
  book_vat_settlement: 'Genom att klicka godkänn så bokförs momsredovisningen för perioden: momskontona nollställs mot 2650 (eller 1650) med exakt de rader förslaget visade. Verifikatet kan inte ändras i efterhand, bara rättas med storno.',
  send_invoice_peppol: 'Genom att klicka godkänn så skickas fakturan som e-faktura via Peppol till kunden och kan inte återkallas. Ett utkast får fakturanummer, markeras som skickat och bokförs.',
  register_peppol_participant: 'Genom att klicka godkänn så publiceras bolagets Peppol-id (organisationsnumret) i den öppna Peppol-katalogen och bolaget kan ta emot e-fakturor.',
  request_peppol_access: 'Genom att klicka godkänn så skickas en begäran om Peppol-åtkomst till supporten.',
  update_arsredovisning_narrative: 'Genom att klicka godkänn så sparas de nya texterna i årsredovisningens förvaltningsberättelse och noter, och bekräftelsen av texterna tas bort tills du bekräftar dem igen.',
  update_arsredovisning_compliance: 'Genom att klicka godkänn så sparas svaren och bekräftelserna i årsredovisningens kontrollfrågor, vilket styr vilka regler och upplysningar som gäller för årsredovisningen.',
  create_arsredovisning_version: 'Genom att klicka godkänn så låses årsredovisningen i en oföränderlig version med exakt det innehåll som förhandsgranskningen visar, och vid färdigställande blir den versionen den som skrivs under och lämnas in.',
  add_arsredovisning_signature: 'Genom att klicka godkänn så läggs personen till som undertecknare av årsredovisningen och bekräftelsen av undertecknarlistan tas bort tills du bekräftar den igen.',
  set_opening_balances_manual: 'Genom att klicka godkänn så bokförs en verifikation med ingående balanser på räkenskapsårets första dag och kopplas till året. Den kan därefter bara rättas med storno.',
  correct_opening_balances: 'Genom att klicka godkänn så makuleras den nuvarande ingående balansen med en storno och en ny verifikation med de rättade ingående balanserna bokförs och kopplas till räkenskapsåret.',
  disconnect_pos_connection: 'Genom att klicka godkänn så kopplas kassasystemet från: inga fler affärsdagar hämtas. Dagar som redan hämtats och bokförts ligger kvar.',
  update_pos_sales_settings: 'Genom att klicka godkänn så bokförs kommande dagskassor på de nya kontona, och obokförda dagar granskas om mot dem. Bokförda dagar ändras inte.',
  book_webshop_order: 'Genom att klicka godkänn så bokförs ordern som ett verifikat med exakt de rader förslaget visade, kopplat till ordern, och orderunderlaget arkiveras som underlag. Verifikatet kan inte ändras i efterhand, bara rättas med storno.',
  book_pos_sales_day: 'Genom att klicka godkänn så bokförs dagskassan som ett verifikat med exakt de rader förslaget visade, och dagsrapporten arkiveras som underlag. Verifikatet kan inte ändras i efterhand, bara rättas med storno.',
  split_opening_balances_per_project: 'Genom att klicka godkänn så delas ingående balanserna upp per projekt i samma verifikat, exakt som förhandsgranskningen visar. Kontonas saldon ändras inte, och de strukna raderna sparas i rättelseloggen med vem och när (BFL 5 kap 5 §).',
  open_collection_case: 'Genom att klicka godkänn så kontrolleras fakturan mot banken igen och skickas till inkassobolaget, som börjar driva den mot kunden. Det kan inte göras ogjort; en återkallelse kan kosta en avgift.',
  collection_case_action: 'Genom att klicka godkänn så skickas åtgärden till inkassobolaget och verkställs i ärendet. Godkänner du nästa steg kontrolleras fakturan mot banken först.',
  book_collected_payment: 'Genom att klicka godkänn så bokförs inbetalningen som betalning av fakturan den dag kunden betalade, mot kontot för pengar som inkassobolaget tagit emot. Den kan sedan bara bokföras om under Avräkningar.',
  book_collection_settlement: 'Genom att klicka godkänn så bokförs utbetalningen som en verifikation med avräkningen som underlag, med de rader och konton som förhandsgranskningen visar, och inkassobolaget får veta att den är bokförd. Har avräkningen ändrats sedan dess bokförs ingenting.',
  collections_daily_batch: 'Genom att klicka godkänn så kontrolleras varje faktura i omgången mot bokföringen och banken igen och skickas sedan en i taget till inkassobolaget, som börjar driva dem mot kunderna. En faktura som har ändrats sedan i morse hoppas över. Det kan inte göras ogjort; en återkallelse kan kosta en avgift.',
  record_customer_loss: 'Genom att klicka godkänn så bokförs kundförlusten på fakturan. En konstaterad kundförlust skriver av fordran och minskar den utgående momsen; den kan bara ångras genom att verifikationen återförs (storno).',
  delete_supplier_invoice: 'Genom att klicka godkänn så tas den obokförda leverantörsfakturan och dess rader bort permanent. Fakturan har ingen verifikation, så bokföringen påverkas inte.',
  uncredit_supplier_invoice: 'Genom att klicka godkänn så bokförs en rättelsepost (storno) som makulerar kreditfakturans verifikation, kreditfakturan markeras som återförd och originalfakturan återställs.',
  update_supplier_invoice_item_account: 'Genom att klicka godkänn så flyttas fakturaraden till det nya kontot och registreringsverifikationen rättas i samma verifikation, med loggning av vem och när.',
  delete_dimension: 'Genom att klicka godkänn så tas dimensionen och dess värden bort. Det går bara om inget har bokförts på den.',
  create_invoice: 'Genom att klicka godkänn så skapas ett fakturautkast (det skickas inte).',
  categorize_transaction: 'Genom att klicka godkänn så kategoriseras transaktionen och en verifikation skapas.',
  match_transaction_invoice: 'Genom att klicka godkänn så matchas transaktionen mot fakturan.',
  attach_document_to_transaction: 'Genom att klicka godkänn så bifogas dokumentet till transaktionen.',
  uncategorize_transaction: 'Genom att klicka godkänn så tas kategoriseringen bort.',
  send_invoice: 'Genom att klicka godkänn så skickas fakturan till kunden.',
  mark_invoice_paid: 'Genom att klicka godkänn så bokförs en betalning på fakturan.',
  mark_invoice_sent: 'Genom att klicka godkänn så märks fakturan som skickad och en verifikation skapas.',
  // High risk: period/year-end/voucher edits. These are the ones the reviewer
  // really needs the warning for, so we keep them concrete: name the
  // irreversibility or compliance consequence, not the generic risk-level.
  lock_period: 'Genom att klicka godkänn så låses perioden: inga nya verifikationer kan bokföras tills den låses upp.',
  unlock_period: 'Genom att klicka godkänn så låses perioden upp. Använd endast för rättelser; lås igen efter.',
  undo_sie_import: 'Genom att klicka godkänn så ångras importen: varje importerat verifikat får en storno, inget raderas.',
  close_period: 'Genom att klicka godkänn så stängs perioden permanent (BFL). Stängningen kan inte ångras.',
  run_year_end: 'Genom att klicka godkänn så körs bokslut: resultatkonton nollställs, perioden låses, nästa period skapas.',
  set_opening_balances: 'Genom att klicka godkänn så bokförs ingående balans i nästa period.',
  run_currency_revaluation: 'Genom att klicka godkänn så bokförs valutaomvärdering (3960/7960).',
  create_voucher: 'Genom att klicka godkänn så bokförs verifikationen med ett nytt löpnummer.',
  correct_entry: 'Genom att klicka godkänn så stornas originalverifikationen och en rättelse bokförs (BFL 5 kap 5§).',
  reverse_entry: 'Genom att klicka godkänn så stornas verifikationen: originalet behålls synligt (BFL 5 kap).',
  credit_invoice: 'Genom att klicka godkänn så skapas en kreditfaktura och originalverifikationen stornas.',
  delete_draft_invoice: 'Genom att klicka godkänn så tas utkastet bort: onumrerade utkast raderas permanent, numrerade makuleras med bevarat fakturanummer.',
  credit_supplier_invoice: 'Genom att klicka godkänn så krediteras leverantörsfakturan och registreringsverifikationen stornas.',
  approve_supplier_invoice: 'Genom att klicka godkänn så attesteras leverantörsfakturan och blir betalningsbar.',
  convert_invoice: 'Genom att klicka godkänn så konverteras proforman eller offerten till en riktig faktura med F-nummer.',
  import_sie: 'Genom att klicka godkänn så importeras SIE-filen: räkenskapsperiod, ingående balans och verifikationer skapas.',
  explain_voucher_gap: 'Genom att klicka godkänn så dokumenteras förklaringen för verifikationsluckan (BFNAR 2013:2).',
  post_annual_depreciation: 'Genom att klicka godkänn så bokförs planenlig avskrivning: en verifikation per tillgång.',
  create_asset: 'Genom att klicka godkänn så läggs tillgången till i anläggningsregistret. Ingen verifikation bokförs.',
  update_asset: 'Genom att klicka godkänn så uppdateras tillgången i anläggningsregistret. Ingen verifikation bokförs.',
  dispose_asset: 'Genom att klicka godkänn så bokförs avyttringen: tillgången lämnar registret och en verifikation med vinst eller förlust skapas.',
}

/** What approving a registration of an already-booked invoice does, per reskontra (crm#1094). */
const REGISTER_BOOKED_SENTENCES: Record<RegisterBookedLedger, string> = {
  customer:
    'Genom att klicka godkänn så registreras fakturan i kundreskontran med sitt eget fakturanummer och kopplas till verifikationen där den redan är bokförd. Ingen verifikation bokförs och inget skickas till kunden. Registreringen kan inte ångras.',
  supplier:
    'Genom att klicka godkänn så registreras leverantörsfakturan i leverantörsreskontran och kopplas till verifikationen där den redan är bokförd; fakturans rader hämtas från verifikationen. Ingen verifikation bokförs. Registreringen kan inte ångras.',
}

/**
 * The consequence sentence the approver consents to. Keyed on the operation
 * type; the types whose outcome depends on their params read them, so the
 * dialog never promises what the approval will not do: convert_invoice with
 * target 'order' creates a draft kundorder (no F-number, nothing booked), and
 * a create_invoice or create_supplier_invoice_from_inbox staged as the
 * registration of an already-booked invoice posts nothing (crm#1094).
 */
export function singleActionWarning(
  operationType: string,
  params?: Record<string, unknown> | null,
  t?: (key: string) => string,
): string {
  if (operationType === 'convert_invoice' && params?.target === 'order') {
    return 'Genom att klicka godkänn så skapas en kundorder (utkast, OR-nummer) från proforman eller offerten. Ingen faktura skapas och inget bokförs; fakturan skapas senare från kundordern.'
  }
  if (operationType === 'convert_invoice' && (params?.percent !== undefined || params?.amount !== undefined)) {
    return 'Genom att klicka godkänn så skapas en faktura med F-nummer för den angivna delen av offerten (delfakturering). Offerten finns kvar och visar vad som är fakturerat och vad som återstår.'
  }
  const ledger = registerBookedLedgerOf(operationType, params)
  if (ledger) return REGISTER_BOOKED_SENTENCES[ledger]
  // A kontantfaktura (crm#1281): issued already paid, not merely sent.
  if (operationType === 'mark_invoice_sent' && params?.paid_at_issue) {
    return PAID_AT_ISSUE_SENTENCE
  }
  // A rule for a supplier's invoices from the inbox (grants slice 2), not a bank line's.
  if (operationType === 'create_grant' && params?.operation_type === 'create_supplier_invoice_from_inbox') {
    return SUPPLIER_INVOICE_GRANT_SENTENCE
  }
  // A schedule that emails every run is high risk only by its params; the
  // sentence follows the tier, so it shows exactly when the row is 'high'.
  if (RECURRING_SCHEDULE_TYPES.has(operationType) && isHighRisk(operationType, params ?? undefined)) {
    return t ? t('warning_recurring_schedule_auto_send') : ''
  }
  const key = SINGLE_ACTION_WARNING_KEYS[operationType]
  if (key && t) return t(key)
  return singleActionWarnings[operationType] ?? ''
}

/** What approving a mark_invoice_sent staged with paid_at_issue_account does (crm#1281). */
const PAID_AT_ISSUE_SENTENCE =
  'Genom att klicka godkänn så får fakturan sitt nummer och utfärdas som redan betald (kontantfaktura): en verifikation bokförs på fakturadatumet med betalningen på det valda kontot mot försäljning och moms, utan kundfordran, och fakturan markeras som betald.'

/** The consent sentence of a rule for a known supplier's invoices from the inbox. */
const SUPPLIER_INVOICE_GRANT_SENTENCE =
  'Genom att klicka godkänn så får agenter registrera och bokföra den här leverantörens fakturor från inkorgen själva, med exakt de konton och den moms som visas och upp till beloppet inklusive moms, utan att fråga först. Allt som avviker väntar på godkännande som i dag: en ny leverantör, andra konton, utländsk valuta, en kreditfaktura, nya bankuppgifter eller ett saknat underlag. Du ser varje sådan bokföring under Bokfört enligt regel i Att göra och kan rätta eller kreditera fakturan eller återkalla regeln. Bara en ägare eller administratör kan godkänna, och bara här i Accounted: en agent kan aldrig godkänna en regel.'

/**
 * The consent sentence a pending Granskning row shows before any click. High
 * risk shows it (its approval opens a dialog with it as well). So does a
 * registration of an already-booked invoice (crm#1094): it cannot be undone,
 * but it keeps its pending type's 'medium' tier so a whole reskontra can be
 * approved at once (risk-tiers.ts), and such an approval opens no dialog.
 */
export function rowConsentSentence(
  op: {
    operation_type: string
    status: string
    risk_level?: string | null
    params?: Record<string, unknown> | null
  },
  t?: (key: string) => string,
): string {
  if (op.status !== 'pending') return ''
  const registration = registerBookedLedgerOf(op.operation_type, op.params) !== null
  return op.risk_level === 'high' || registration ? singleActionWarning(op.operation_type, op.params, t) : ''
}

/**
 * The bulk confirmation's line for registrations of already-booked invoices
 * (crm#1094): with the row's sentence, what tells a bulk approver that the
 * registrations cannot be undone.
 */
export function registerBookedInvoiceBulkLine(count: number): string {
  return count === 1
    ? 'En redan bokförd faktura registreras i kundreskontran (inget bokförs, kan inte ångras).'
    : `${count} redan bokförda fakturor registreras i kundreskontran (inget bokförs, kan inte ångras).`
}

/** registerBookedInvoiceBulkLine for the leverantörsreskontra. */
export function registerBookedSupplierInvoiceBulkLine(count: number): string {
  return count === 1
    ? 'En redan bokförd leverantörsfaktura registreras i leverantörsreskontran (inget bokförs, kan inte ångras).'
    : `${count} redan bokförda leverantörsfakturor registreras i leverantörsreskontran (inget bokförs, kan inte ångras).`
}

// Structured rejection categories. One canonical list: /pending's reject
// dialog and the chat approval card's reject form render the same options
// and store the same values (surfaced back to the agent via
// gnubok_get_recent_rejections).
export const REJECTION_CATEGORY_LABELS: Record<PendingOperationRejectionCategory, string> = {
  wrong_category: 'Fel kategori / konto',
  wrong_amount: 'Fel belopp',
  duplicate: 'Dubblett',
  wrong_period: 'Fel period',
  other: 'Annat',
}

// Rejections nobody made: shown on a resolved operation, never offered in a picker.
const SYSTEM_REJECTION_LABELS: Record<PendingOperationSystemRejectionCategory, string> = {
  expired: 'Utgick automatiskt',
  superseded: 'Ersatt',
  failed: 'Misslyckades vid godkännandet',
}

export function rejectionCategoryLabel(
  category: PendingOperationRejectionCategory | PendingOperationSystemRejectionCategory,
): string {
  return category in REJECTION_CATEGORY_LABELS
    ? REJECTION_CATEGORY_LABELS[category as PendingOperationRejectionCategory]
    : SYSTEM_REJECTION_LABELS[category as PendingOperationSystemRejectionCategory]
}

/**
 * The advisory warning a staging tool attached to an operation, read once for
 * every surface that shows it: the Granskning row, the bulk confirmation and
 * the preview. It used to be read per preview component, so a type whose
 * preview forgot the field (attach_document_to_transaction) never showed it,
 * and the row never did: "Godkänn alla" approved warned operations unseen
 * (crm#1003).
 *
 * - missing_underlag: create_voucher's note is agent guidance in English
 *   (it names tools), so the UI says it in its own words. Gated on the staged
 *   note, not on document_attached: the server decides when the warning
 *   applies (IB entries are exempt there), so the UI mirrors it instead of
 *   running a second, looser policy. The UI sentence stays conditional
 *   ("om ... avser en mottagen handling"): accruals and FX entries
 *   legitimately lack a kvitto.
 * - vat: create_invoice and update_invoice stage the VAT-treatment
 *   explanation twice, English prose in compliance_warning for the agent and
 *   Swedish in vat_warnings; only the Swedish one is for the approver.
 * - note: every other compliance_warning, rendered as the server wrote it.
 */
export type ComplianceWarning =
  | { kind: 'missing_underlag' }
  | { kind: 'vat'; text: string }
  | { kind: 'note'; text: string }

const VAT_WARNING_OPERATION_TYPES = new Set(['create_invoice', 'update_invoice'])

export function complianceWarningOf(op: {
  operation_type: string
  preview_data?: Record<string, unknown> | null
}): ComplianceWarning | null {
  const data = op.preview_data ?? {}
  // A registration of an already-booked invoice (crm#1094) carries no VAT
  // explanation: its warnings are Swedish notes about the verifikat and the
  // reminders, read like any other compliance_warning.
  if (VAT_WARNING_OPERATION_TYPES.has(op.operation_type) && !isRegisterBookedInvoiceParams(data)) {
    const texts = Array.isArray(data.vat_warnings)
      ? data.vat_warnings.flatMap((warning: unknown) => {
          const text =
            warning != null && typeof warning === 'object'
              ? (warning as { message_sv?: unknown }).message_sv
              : null
          return typeof text === 'string' && text.trim() ? [text.trim()] : []
        })
      : []
    return texts.length > 0 ? { kind: 'vat', text: texts.join(' ') } : null
  }
  const note = typeof data.compliance_warning === 'string' ? data.compliance_warning.trim() : ''
  if (!note) return null
  if (op.operation_type === 'create_voucher') return { kind: 'missing_underlag' }
  return { kind: 'note', text: note }
}
