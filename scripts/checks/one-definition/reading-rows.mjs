export default {
  rule: 'reading-rows',
  says: 'A read supplier invoice opens with rows from its totals, one per moms sats, never with a form row made of each read line.',
  home: 'src/lib/supplier-invoices/reading-rows.ts: rowsFromReading',
  why: 'The editor made a form row of every read line and took only the total: a reading that lost a line opened 174,75 kr off its own total with Moms empty, and 13 % of the readings with several lines did not add up.',
  match: [
    // extracted.lineItems.map((li) => ({ ... })): a form row per read line.
    /lineItems\??\.map\(/,
    // vat_rate: vatRateFromAi(li.vatRate): a read line's sats put on a form row.
    /vatRateFromAi\(/,
  ],
  // The rule is about what a form opens with; the doors that register a
  // reading themselves (the Inkorg's plan, the MCP tool) have their own.
  scan: ['components/'],
}
