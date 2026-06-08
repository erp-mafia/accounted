# Bookkeeping Prompt

## Perspective

You are scanning for Swedish accounting compliance issues, bookkeeping logic gaps, and financial data handling problems. Accounted implements double-entry bookkeeping compliant with Bokforingslagen (BFL) and BFN standards. Focus on correctness of journal entries, VAT handling, account mappings, and legal guardrails.

## Checklist

### Journal Entry Integrity
- [ ] All journal entries route through `createJournalEntry()` in `lib/bookkeeping/engine.ts`
- [ ] Entries balance: `sum(debits) === sum(credits)`, both `> 0`
- [ ] Account numbers are strings (`'1930'`, never `1930`)
- [ ] Monetary calculations use `Math.round(x * 100) / 100` (never `toFixed()`)
- [ ] Voucher numbers assigned via DB RPC (never set manually)
- [ ] Posted entries are never edited (storno pattern for corrections)
- [ ] `reverseEntry()` used for cancellation, `correctEntry()` for corrections

### VAT Handling
- [ ] Correct VAT treatment applied per transaction type (`standard_25`, `reduced_12`, `reduced_6`, `reverse_charge`, `export`, `exempt`)
- [ ] Mixed-rate invoices handled via `generatePerRateLines()` in `invoice-entries.ts`
- [ ] `getAvailableVatRates()` used to determine valid rates based on customer type
- [ ] Output VAT mapped to correct accounts (2611/2621/2631 for 25%/12%/6%)
- [ ] Input VAT on 2641, calculated input VAT (EU reverse charge) on 2645
- [ ] EU services on 3308, export on 3305
- [ ] VAT declaration rutor (SKV 4700) correctly calculated

### BAS Account Mappings
- [ ] Revenue accounts correct: 3001 (25%), 3002 (12%), 3003 (6%)
- [ ] 1510 for accounts receivable, 2440 for accounts payable
- [ ] 1930 for business bank account
- [ ] 2013 for private withdrawals (enskild firma), 2893 for shareholder loan (aktiebolag)
- [ ] Account used matches the entity type (EF vs AB)

### Entity Type Handling
- [ ] Enskild firma vs aktiebolag differences respected
- [ ] Private withdrawals (2013) only for EF
- [ ] Shareholder loan (2893) only for AB
- [ ] Tax reporting differences handled (INK1 vs INK2)

### Period & Fiscal Year
- [ ] Period lock enforcement respected (cannot post to closed/locked periods)
- [ ] Fiscal year boundaries correct
- [ ] Year-end closing entries follow Swedish standards
- [ ] Opening balances carried forward correctly

### Reports & Declarations
- [ ] Trial balance sums match journal entries
- [ ] VAT declaration rutor map correctly to BAS accounts
- [ ] Income statement categories correct
- [ ] NE-bilaga / INK2 / SRU export in correct format
- [ ] Reports filter by fiscal year and user

### Document Retention
- [ ] 7-year retention enforced on documents linked to posted entries
- [ ] Receipts and attachments cannot be deleted after entry is posted
- [ ] Archive export includes all legally required documents

## Classification

- **Bug**: Wrong account mapping, VAT calculated incorrectly, balance check missing, posted entry can be modified, period lock bypassed, retention trigger missing.
- **Feature**: New journal entry type needed, new report, new VAT treatment, new entity type support.
- **Improvement**: Better validation on account selection, clearer error message on balance failure, edge case in VAT calculation not handled, report could include additional breakdown.
