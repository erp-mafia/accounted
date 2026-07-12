# Sweden CIUS Rules and Accounting Integration

This reference covers everything that is **specifically Swedish** in a Peppol BIS Billing 3 invoice: identifier formats, the SE-R-* validation rules, VAT rate handling, payment encoding for Bankgiro/Plusgiro/OCR, ROT/RUT and grön teknik handling, BAS-kontoplan postings, faktureringsmetoden vs kontantmetoden, and per-buyer BT-10 BuyerReference formats.

## Swedish identifier formats

### EndpointID (BT-34)

```xml
<cbc:EndpointID schemeID="0007">5567321000</cbc:EndpointID>
```

- **Swedish orgnr** → `schemeID="0007"`, **10 digits, no dash**. Example: `5567321000` (not `556732-1000`).
- **GLN** → `schemeID="0088"`, 13 digits. Used by larger organisations and DIGG-recommended for sole proprietors to avoid exposing personnummer.
- **Sole proprietor with personnummer** → `schemeID="0007"` with the personnummer as a 10-digit orgnr (since personnummer IS the firma's orgnr). **GDPR concern**: routing metadata is visible across the Peppol network. DIGG recommends switching to GLN.

### VAT identifier

`cac:PartyTaxScheme/cbc:CompanyID` for a Swedish entity:

```xml
<cac:PartyTaxScheme>
  <cbc:CompanyID>SE556732100001</cbc:CompanyID>
  <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
</cac:PartyTaxScheme>
```

Format: **`SE` + 10 digits (orgnr) + `01`** (the trailing `01` is the legal sequence number, almost always `01`). The country prefix is mandatory under **BR-CO-9**.

### Legal entity registration

```xml
<cac:PartyLegalEntity>
  <cbc:RegistrationName>Arcim Technology AB</cbc:RegistrationName>
  <cbc:CompanyID schemeID="0007">5567321000</cbc:CompanyID>
  <cbc:CompanyLegalForm>Godkänd för F-skatt</cbc:CompanyLegalForm>
</cac:PartyLegalEntity>
```

## SE-R-*, the Sweden CIUS rules

### SE-R-005 (FATAL), F-skatt declaration

If a Swedish supplier issues an invoice with VAT category `S`, **the literal string "Godkänd för F-skatt" must appear somewhere in the invoice**. Standard placements:

- `cac:PartyLegalEntity/cbc:CompanyLegalForm` (preferred)
- A document-level `cbc:Note`
- An invoice-line `cbc:Note`

This is the **single most common reason public sector authorities reject Swedish invoices**. Hard-code the string into the UBL template; do not derive it from a database flag (the F-skatt status of an active Swedish AB is universal).

### SE-R-006, Swedish VAT rate restriction

If supplier VAT country is `SE` and category is `S`, the rate must be **6, 12, or 25**. Any other rate must use category `E` (exempt) with an exemption reason, typically used for the rare zero-rate cases that are technically exempt rather than zero-rated.

### SE-R-008 / SE-R-009, Bankgiro

Bankgiro account numbers must be **7-8 numeric digits**.

### SE-R-010, Plusgiro

Plusgiro account numbers must be **2-8 characters**.

### SE-R-011, Swedish payment methods

PaymentMeansCode `30` (Credit transfer) is mandatory for both Bankgiro and Plusgiro. **Legacy codes 56 and 50 are explicitly forbidden.** The discriminator between Bankgiro and Plusgiro is `cac:FinancialInstitutionBranch/cbc:ID`:

- `SE:BANKGIRO` for Bankgiro
- `SE:PLUSGIRO` for Plusgiro

### SE-R-013, Luhn validity on orgnr

Swedish organisationsnummer must pass the modulus-10 (Luhn) check. Implementation note: the check digit is computed over the first 9 digits.

## Swedish payment encoding (full example)

Bankgiro payment with OCR reference:

```xml
<cac:PaymentMeans>
  <cbc:PaymentMeansCode>30</cbc:PaymentMeansCode>
  <cbc:PaymentID>1234567890123</cbc:PaymentID>     <!-- BT-83 OCR reference -->
  <cac:PayeeFinancialAccount>
    <cbc:ID>5555-1234</cbc:ID>
    <cbc:Name>Arcim Technology AB</cbc:Name>
    <cac:FinancialInstitutionBranch>
      <cbc:ID>SE:BANKGIRO</cbc:ID>
    </cac:FinancialInstitutionBranch>
  </cac:PayeeFinancialAccount>
</cac:PaymentMeans>
```

Plusgiro:

```xml
<cac:PaymentMeans>
  <cbc:PaymentMeansCode>30</cbc:PaymentMeansCode>
  <cbc:PaymentID>1234567890123</cbc:PaymentID>
  <cac:PayeeFinancialAccount>
    <cbc:ID>123456-7</cbc:ID>
    <cac:FinancialInstitutionBranch>
      <cbc:ID>SE:PLUSGIRO</cbc:ID>
    </cac:FinancialInstitutionBranch>
  </cac:PayeeFinancialAccount>
</cac:PaymentMeans>
```

For non-Swedish EU payments use code `58` (SEPA credit transfer) with country-checked IBAN in `cbc:ID`.

## OCR references

Swedish OCR is numeric, **2-25 digits, last digit modulus-10 (Luhn) check**. Optional length digit at position n−1 encodes total length.

Four control levels at Bankgirot:
- **OCR1**, soft (mjuk), Luhn only.
- **OCR2**, hard (hård), Luhn + reference exists in BG receiver's reference register.
- **OCR3**, fixed length via length digit.
- **OCR4**, fixed length, up to 3 lengths allowed.

Hård kontroll causes internet-banks to reject mismatched OCR, test thoroughly before going live. Encode in `cbc:PaymentID` (BT-83).

## Bankgirot integration mechanics

### Inbound payment file (kundreskontra)

Bankgirot's daily inbound file uses fixed-format records with TK (transaction code):

| TK | Meaning |
|---|---|
| 05 | Inbetalning |
| 15 | Avdrag/return |
| 25 | Inbetalning utan referens |
| 27 / 28 / 29 | Bg/Pg variations |
| 70 | Justering |

The OCR (BT-83 / `cbc:PaymentID`) is the match key driving automatic invoice closure in 1510 Kundfordringar.

### Outbound LB-rutin (leverantörsbetalningar)

Outbound payment file uses TK 11/14/16/17/25/26/27/29/49 records, supports Girering, Kontoinsättning (clearing+kontonr), Kontantutbetalning and Avräkning av kreditfaktura. Signed and submitted via the company's bank (BgCom / BankgiroLink). The återredovisningsfil drives AP closure in 2440 Leverantörsskulder.

**P27 was abandoned in 2023.** Banks have introduced bank-specific ISO 20022 PAIN.001/.002 flows. **Plan for LB-rutin and ISO 20022 to coexist for the foreseeable future.**

## VAT (moms) rates and category encoding

Swedish rates: **25% standard, 12% (food, hotel, restaurant), 6% (books, transport, culture, sport), 0%**.

Standard 25% line example:

```xml
<cac:ClassifiedTaxCategory>
  <cbc:ID>S</cbc:ID>
  <cbc:Percent>25</cbc:Percent>
  <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
</cac:ClassifiedTaxCategory>
```

Reverse charge for byggtjänster (omvänd skattskyldighet bygg, ML 2 kap. 1 § p. 4) within Sweden, uses `AE`:

```xml
<cac:ClassifiedTaxCategory>
  <cbc:ID>AE</cbc:ID>
  <cbc:Percent>0</cbc:Percent>
  <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
</cac:ClassifiedTaxCategory>
```

Buyer's bookkeeping must post 2647 Ingående moms omvänd skattskyldighet (DR) and 2614 Utgående moms omvänd skattskyldighet (CR) when receiving such an invoice.

Intra-EU service to a B2B EU customer, uses `K` (sometimes `AE` depending on supply rule):

```xml
<cac:ClassifiedTaxCategory>
  <cbc:ID>K</cbc:ID>
  <cbc:Percent>0</cbc:Percent>
  <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
</cac:ClassifiedTaxCategory>
```

With `VATEX-EU-IC` exemption reason in the summary `TaxCategory`.

## BAS-kontoplan postings

The de-facto chart is **BAS-kontoplanen** (https://www.bas.se), updated yearly. Key accounts for e-invoice flows:

### Customer-side (kundfakturor)

- **1510** Kundfordringar (AR control, primary)
- **1513** Kundfordringar i delbetalning (used for ROT/RUT split)
- **1515** Osäkra kundfordringar
- **1518** Ej reskontraförda kundfordringar
- **1519** Värdereglering kundfordringar
- **3001/3002/3003/3004** Försäljning by VAT rate (25/12/6/0%)
- **3308** Försäljning tjänst utanför EU
- **3573** Försäljning tjänst EU (för uppgift i periodisk sammanställning)

### Supplier-side (leverantörsfakturor)

- **2440** Leverantörsskulder (AP control, primary)
- **2445** Tvistiga leverantörsskulder
- **2448** Ej reskontraförda leverantörsskulder
- **4010** Inköp varor
- **4515** Inköp tjänster
- **4xxx** General cost-of-goods accounts

### VAT control

- **2611** Utgående moms 25%
- **2621** Utgående moms 12%
- **2631** Utgående moms 6%
- **2614** Utgående moms omvänd skattskyldighet
- **2615** Utgående moms 25% EU varuinköp
- **2641** Ingående moms (inland)
- **2645** Ingående moms utländska leverantörer
- **2647** Ingående moms omvänd skattskyldighet (e.g. byggmoms)
- **2650** Redovisningskonto för moms (clearing to Skatteverket)

### Cash and bank

- **1910** Kassa
- **1920** Plusgiro
- **1930** Företagskonto / Bank

## Standard postings

**Outbound invoice 1,000 SEK net + 25% VAT to Swedish customer (faktureringsmetoden):**

```
DR 1510 Kundfordringar             1 250
   CR 3001 Försäljning 25%               1 000
   CR 2611 Utgående moms 25%               250
```

**Inbound supplier invoice 1,000 SEK net + 25% VAT (faktureringsmetoden):**

```
DR 4010 Inköp                      1 000
DR 2641 Ingående moms 25%            250
   CR 2440 Leverantörsskulder            1 250
```

**Inbound construction reverse-charge supplier invoice 1,000 SEK:**

```
DR 4xxx Inköp byggtjänst           1 000
DR 2647 Ingående moms omvänd          250  (reclaimable)
   CR 2440 Leverantörsskulder            1 000
   CR 2614 Utgående moms omvänd            250  (collected)
```

Net effect on moms is zero, but both legs must be reported in momsdeklarationen.

## Faktureringsmetoden vs kontantmetoden

- **Faktureringsmetoden**, mandatory if turnover > **SEK 3 million**, default for AB. Books invoices on issuance against 1510/2440. Moms recognised on invoice date.
- **Kontantmetoden**, books only on payment, against 1930/1910. Year-end conversion mandatory: any outstanding kund-/leverantörsfaktura must be booked over to 1510/2440 and the underlying intäkt/kostnad recognised, then reversed on 1 Jan.

The bookkeeping engine must carry a `bookkeeping_method` flag driving posting timing and a year-end converter routine.

## ROT/RUT and grön teknik

**Peppol BIS Billing 3 has no standardised ROT/RUT extension.** Production practice in Swedish ERPs:

1. **On the invoice**: show a reduced "Att betala" amount (after Skatteverket's portion).
2. **Surface the deduction** as an `cac:AllowanceCharge` with informative reason (no standardised reason code, use `cbc:AllowanceChargeReason` text).
3. **Persist housework metadata** locally against Skatteverket's typkoder:
   - **ROT-bygg**: Bygg, El, Glas/Plåt, Mark/Dränering, Murning, Målning/Tapetsering, VVS.
   - **RUT**: Städning, Trädgård, Barnpassning, Övriga (incl. flytt, IT-arbete, snöskottning).
   - **Grön teknik**: värmepump-schablon, solceller, lagring, laddpunkt.
4. **After payment**, generate Skatteverket's separate "Begäran om utbetalning" XML (`HUSXML`) and upload via Skatteverket's e-tjänst.

Bookkeeping splits the customer receivable into customer-paid and Skatteverket-receivable portions:

```
DR 1510 Kundfordringar (kund)         500   (kund's net to pay)
DR 1684 Skatteverket ROT-fordran      500   (or 1513 / 1689)
   CR 3001 Försäljning 25%               1 000
   CR 2611 Utgående moms 25%                ...
```

The 1684/1513/1689 receivable is closed when Skatteverket disburses to the company's bank.

## BT-10 BuyerReference per-buyer formats

Each Swedish public sector buyer specifies its own BT-10 / BuyerReference format. Examples:

| Buyer | Format |
|---|---|
| Skatteverket | 4-letter code |
| Svenska Kraftnät | 3 digits + 3 letters |
| Försäkringskassan | 5-10 digits starting with `4` |
| Many universities | cost-centre + name |

**Maintain a per-buyer-Peppol-ID regex map** and validate at invoice compose time. This prevents 30-day public-sector payment delays. Scrape SFTI / docplayer reference and update quarterly.

## Multi-currency (Swedish supplier invoicing in EUR)

Swedish supplier issuing in EUR to an EU customer; book the SEK equivalent for VAT.

```xml
<cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
<cbc:TaxCurrencyCode>SEK</cbc:TaxCurrencyCode>
```

Bookkeeping uses the **monthly average ECB rate** for the previous month (Skatteverket-accepted), or the day's spot rate if the contract specifies. Both rate sources are valid; document the policy.

## Authoritative source list

- BAS-kontoplan: https://www.bas.se
- SFTI Peppol BIS Billing 3: https://sfti.se/sfti/standarder/peppolbisehandel/peppolbisbilling3.49021.html
- Swedish payment methods in BIS 3: https://support.inexchange.com/hc/en-us/articles/360001888178-Swedish-Payment-Methods-in-PEPPOL-BIS-3
- DIGG Peppol-ID instructions: https://www.digg.se/digitala-tjanster/peppol/instruktion-for-val-av-peppol-id-
- SE-R-005: https://docs.peppol.eu/poacc/billing/3.0/rules/ubl-peppol/SE-R-005/
- SE-R-011: https://docs.peppol.eu/poacc/billing/3.0/rules/ubl-peppol/SE-R-011/
- Skatteverket ROT/RUT XML: https://www.skatteverket.se/foretag/rotochrutarbete (HUSXML schema)