# Peppol BIS Billing 3.0, Wire Format Reference

## The BIS suite and document identifiers

Peppol BIS Billing 3.0 is identified by:

```
cbc:CustomizationID = urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0
cbc:ProfileID       = urn:fdc:peppol.eu:2017:poacc:billing:01:1.0
```

UBL roots are `Invoice` (`urn:oasis:names:specification:ubl:schema:xsd:Invoice-2`) and `CreditNote` (`urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2`). The current Peppol POACC release is **Billing 3.0.20 (November 2025)**.

The wider BIS 3.0 suite (Peppol Post-Award and adjacent profiles):

| Profile | Process ID suffix | Purpose |
|---|---|---|
| Billing 3 | `billing:01:1.0` | Standard B2B/B2G invoice + credit note |
| Self-Billing 3 | `selfbilling:01:1.0` | Buyer issues invoice on supplier's behalf |
| Order Only / Ordering / Advanced Ordering / Order Agreement | `ordering:*` | Procurement order flows |
| Despatch Advice 3 | `despatchadvice:01:1.0` | Shipment notification |
| Catalogue 3 | `catalogue:01:1.0` | Product catalogue exchange |
| Invoice Response (IMR, T111) | `invoiceresponse:01:1.0` | Buyer accepts/rejects invoice |
| Message Level Response (MLR, T71) | `mlr:01:1.0` | Technical receipt confirmation |
| **Message Level Status (MLS)** | `urn:peppol:edec:mls:1.0` | New: machine-readable processing status |

**Peppol BIS 4.0 / PINT convergence** is announced for late 2025 / early 2026, track release notes at https://docs.peppol.eu/poacc/billing/3.0/bis/ before locking long-lived schemas.

InvoiceTypeCode (BT-3) restricted set: `380` commercial invoice, `381` credit note (Invoice), `384` corrected invoice, `389` self-billed. CreditNoteTypeCode: `381` credit note, `396` factored credit note, `261` self-billed credit note.

## Mandatory header

```xml
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2">
  <cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0</cbc:CustomizationID>
  <cbc:ProfileID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</cbc:ProfileID>
  <cbc:ID>INV-2026-00001</cbc:ID>                <!-- BT-1 -->
  <cbc:IssueDate>2026-04-27</cbc:IssueDate>      <!-- BT-2, ISO 8601 -->
  <cbc:DueDate>2026-05-27</cbc:DueDate>          <!-- BT-9 -->
  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode> <!-- BT-3 -->
  <cbc:DocumentCurrencyCode>SEK</cbc:DocumentCurrencyCode>  <!-- BT-5 -->
  <cbc:BuyerReference>SE-DEPT-42</cbc:BuyerReference>       <!-- BT-10, mandatory if no OrderReference -->
  ...
</Invoice>
```

## Party blocks

`AccountingSupplierParty` and `AccountingCustomerParty` carry:

- `cbc:EndpointID` (BT-34, mandatory `schemeID`), the Peppol routing address.
- `cac:PartyIdentification/cbc:ID`, additional business identifiers (GLN, etc.).
- `cac:PartyName/cbc:Name`.
- `cac:PostalAddress`, `StreetName`, `CityName`, `PostalZone`, `Country/IdentificationCode`.
- `cac:PartyTaxScheme/cbc:CompanyID`, VAT identifier.
- `cac:PartyLegalEntity/cbc:RegistrationName` and `cbc:CompanyID`.
- `cac:Contact`.

For Swedish entities see `swedish-cius-and-specifics.md` for the F-skatt rule, orgnr formats, and VAT prefix requirements.

## VAT category codes (UNCL5305)

Used in `cac:ClassifiedTaxCategory/cbc:ID` per line and `cac:TaxCategory/cbc:ID` in summary blocks.

| Code | Meaning | Rate | TaxExemptionReason |
|---|---|---|---|
| **S** | Standard rate | >0 | No |
| **Z** | Zero rated | 0 | No |
| **E** | Exempt from VAT | 0 | Yes (BT-120/BT-121) |
| **AE** | Reverse charge | 0 | Yes (`VATEX-EU-AE`) |
| **K** | Intra-EU supply of goods/services | 0 | Yes (`VATEX-EU-IC`) |
| **G** | Export outside EU | 0 | Yes (`VATEX-EU-G`) |
| **O** | Outside scope of VAT | n/a | Yes (`VATEX-EU-O`) |
| **L** | IGIC (Canary Islands) | various | Spanish use |
| **M** | IPSI (Ceuta/Melilla) | various | Spanish use |

Reverse charge example (Sweden→EU customer):

```xml
<cac:ClassifiedTaxCategory>
  <cbc:ID>AE</cbc:ID>
  <cbc:Percent>0</cbc:Percent>
  <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
</cac:ClassifiedTaxCategory>
```

In the summary `TaxSubtotal`:

```xml
<cac:TaxSubtotal>
  <cbc:TaxableAmount currencyID="SEK">10000.00</cbc:TaxableAmount>
  <cbc:TaxAmount currencyID="SEK">0.00</cbc:TaxAmount>
  <cac:TaxCategory>
    <cbc:ID>AE</cbc:ID>
    <cbc:Percent>0</cbc:Percent>
    <cbc:TaxExemptionReasonCode>VATEX-EU-AE</cbc:TaxExemptionReasonCode>
    <cbc:TaxExemptionReason>Reverse charge</cbc:TaxExemptionReason>
    <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
  </cac:TaxCategory>
</cac:TaxSubtotal>
```

## Multi-currency handling

`DocumentCurrencyCode` (BT-5) drives all amounts. If it differs from the seller's VAT accounting currency:
- Add `cbc:TaxCurrencyCode` (BT-6).
- Add a second `cac:TaxTotal` carrying only the SEK-equivalent total tax (BT-111).

```xml
<cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
<cbc:TaxCurrencyCode>SEK</cbc:TaxCurrencyCode>
...
<cac:TaxTotal>
  <cbc:TaxAmount currencyID="EUR">2500.00</cbc:TaxAmount>
  <cac:TaxSubtotal>...</cac:TaxSubtotal>
</cac:TaxTotal>
<cac:TaxTotal>
  <cbc:TaxAmount currencyID="SEK">28750.00</cbc:TaxAmount>
</cac:TaxTotal>
```

## Calculation rules, the failure surface

These are the rules that cause the majority of production rejections.

| Rule | Constraint |
|---|---|
| **BR-CO-15** | `BT-112 = BT-109 + BT-110` (TaxInclusiveAmount = TaxExclusive + Tax). Canonical rounding bug. |
| **BR-CO-13** | `BT-109 = BT-106 − BT-107 + BT-108` (TaxExclusive = LineTotal − Allowances + Charges) |
| **BR-CO-17** | `BT-117 = round2(BT-116 × BT-119 / 100)` (per category tax = taxable × rate) |
| **BR-S-08, BR-Z-08, BR-E-08, BR-AE-08, BR-IC-08, BR-G-08, BR-O-08** | Per-category taxable amount must reconcile to corresponding line totals + charges − allowances |
| **BR-CO-9** | VAT identifier must start with country code prefix |
| **BR-S-01 / BR-Z-01 / etc.** | At least one line, allowance or charge per used VAT category |
| **PEPPOL-EN16931-R053** | Only one tax total without currency suffix |

**Always do arithmetic in BigDecimal/Decimal with explicit scale.** Round at the boundary, never in intermediate steps. Force `Locale.ROOT` / `InvariantCulture` for serialisation. Document totals must be exactly 2 decimals; price amounts (BT-146/BT-148) are unbounded.

Belgium's 2026 mandate disallows line-by-line VAT rounding; Sweden currently allows it but may not for long.

## Allowances and charges

Document level via `cac:AllowanceCharge`:

```xml
<cac:AllowanceCharge>
  <cbc:ChargeIndicator>false</cbc:ChargeIndicator>     <!-- false = allowance, true = charge -->
  <cbc:AllowanceChargeReasonCode>95</cbc:AllowanceChargeReasonCode>  <!-- UNCL5189 / UNCL7161 -->
  <cbc:AllowanceChargeReason>Volume rebate</cbc:AllowanceChargeReason>
  <cbc:Amount currencyID="SEK">100.00</cbc:Amount>
  <cac:TaxCategory>
    <cbc:ID>S</cbc:ID>
    <cbc:Percent>25</cbc:Percent>
    <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
  </cac:TaxCategory>
</cac:AllowanceCharge>
```

UNCL5189 reason codes (allowance) include: 41 Bonus for works ahead of schedule, 60 Manufacturer's consumer discount, 95 Discount, 100 Special rebate, 102 Fixed long term, 103 Temporary, 104 Standard. UNCL7161 reason codes (charge) include: AA Advertising, AAA Telecommunication, ABK Miscellaneous, FC Freight charge, IN Insurance, SH Shipping and handling.

## Line items

```xml
<cac:InvoiceLine>
  <cbc:ID>1</cbc:ID>
  <cbc:InvoicedQuantity unitCode="EA">10</cbc:InvoicedQuantity>
  <cbc:LineExtensionAmount currencyID="SEK">5000.00</cbc:LineExtensionAmount>
  <cac:Item>
    <cbc:Name>Consulting hours</cbc:Name>
    <cac:ClassifiedTaxCategory>
      <cbc:ID>S</cbc:ID>
      <cbc:Percent>25</cbc:Percent>
      <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
    </cac:ClassifiedTaxCategory>
  </cac:Item>
  <cac:Price>
    <cbc:PriceAmount currencyID="SEK">500.00</cbc:PriceAmount>
  </cac:Price>
</cac:InvoiceLine>
```

`unitCode` follows UN/ECE Recommendation 20 (`EA` each, `HUR` hour, `KGM` kilogram, `MTR` metre, `LTR` litre, `DAY` day, `MON` month, `C62` "one", used for dimensionless services).

## Document totals

```xml
<cac:LegalMonetaryTotal>
  <cbc:LineExtensionAmount currencyID="SEK">10000.00</cbc:LineExtensionAmount>  <!-- BT-106 -->
  <cbc:TaxExclusiveAmount currencyID="SEK">9900.00</cbc:TaxExclusiveAmount>     <!-- BT-109 -->
  <cbc:TaxInclusiveAmount currencyID="SEK">12375.00</cbc:TaxInclusiveAmount>    <!-- BT-112 -->
  <cbc:AllowanceTotalAmount currencyID="SEK">100.00</cbc:AllowanceTotalAmount>  <!-- BT-107 -->
  <cbc:ChargeTotalAmount currencyID="SEK">0.00</cbc:ChargeTotalAmount>          <!-- BT-108 -->
  <cbc:PrepaidAmount currencyID="SEK">0.00</cbc:PrepaidAmount>                  <!-- BT-113 -->
  <cbc:PayableRoundingAmount currencyID="SEK">0.00</cbc:PayableRoundingAmount>  <!-- BT-114 -->
  <cbc:PayableAmount currencyID="SEK">12375.00</cbc:PayableAmount>              <!-- BT-115 -->
</cac:LegalMonetaryTotal>
```

## Attachments

Via `cac:AdditionalDocumentReference` with `cac:Attachment/cbc:EmbeddedDocumentBinaryObject` (base64) or `cac:ExternalReference/cbc:URI`. Inline attachments should stay under 10 MB despite the formal 100 MB AS4 ceiling, many access points reject larger payloads in practice.

```xml
<cac:AdditionalDocumentReference>
  <cbc:ID>timesheet-april-2026.pdf</cbc:ID>
  <cbc:DocumentDescription>Detailed timesheet</cbc:DocumentDescription>
  <cac:Attachment>
    <cbc:EmbeddedDocumentBinaryObject mimeCode="application/pdf"
                                       filename="timesheet-april-2026.pdf">JVBERi0xLjQK...</cbc:EmbeddedDocumentBinaryObject>
  </cac:Attachment>
</cac:AdditionalDocumentReference>
```

## Validation stack

Three layers in this order:

1. **XSD**, UBL 2.1 schemas. Catches structural errors. Source: https://docs.oasis-open.org/ubl/os-UBL-2.1/UBL-2.1.html
2. **EN 16931 Schematron**, CEN/TC 434 official artefacts (`EN16931-UBL-validation.sch`). Catches BR-* business rules and BR-CO-* calculation rules.
3. **`PEPPOL-EN16931-UBL.sch`**, Peppol overlay with country-specific rules. SE-R-* (Sweden), NO-R-* (Norway), IT-R-* (Italy), DE-R-* (Germany), NL-R-* (Netherlands), DK-R-* (Denmark).

Authoritative GitHub repo: **https://github.com/OpenPEPPOL/peppol-bis-invoice-3** with releases on a May/November cadence.

Validators to integrate:
- **Helger Peppol Practical**, https://peppol.helger.com, REST + UI, runs phive-rules.
- **Storecove peppolvalidator.com**, https://peppolvalidator.com, error code lookup.
- **EC DG GROW eInvoicing validator**, https://itb.ec.europa.eu/invoice, official EC validator.
- **Norwegian validator**, https://anskaffelser.no/verktoy/validator (also useful for Sweden).
- **SFTI Validex**, https://sfti.validex.net/ (DIGG's Peppol testbädd was discontinued in the 2026 handover)

Validate at **three points** in your pipeline: (1) immediately after UBL generation locally; (2) before handoff to the Access Point; (3) on receive in your inbound flow before bookkeeping. Many AP rejections happen post-send when the receiver's MLR comes back hours later.

## Authoritative source list

- Peppol BIS Billing 3.0 specification: https://docs.peppol.eu/poacc/billing/3.0/bis/
- UBL 2.1 syntax tree: https://docs.peppol.eu/poacc/billing/3.0/syntax/ubl-invoice/
- Self-billing: https://docs.peppol.eu/poacc/self-billing/3.0/bis-sb/
- Peppol document types index: https://www.peppol.nu/knowledge-base/peppol-document-types-standards/
- OpenPEPPOL repo: https://github.com/OpenPEPPOL/peppol-bis-invoice-3
- Validator with error code lookup: https://peppolvalidator.com/peppol-validation-errors