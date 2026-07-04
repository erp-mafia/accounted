# Reporting Obligations, Filing, and SIE4

## Årsredovisning for AB

Must contain, in order:
1. **Förvaltningsberättelse**
2. **Resultaträkning**
3. **Balansräkning**
4. **Noter (tilläggsupplysningar)**
5. **Kassaflödesanalys** (större företag only)

Every page: company name, organisationsnummer, registered office.

### Förvaltningsberättelse (K2 minimum)
- Description of business activities and säte
- Important events during the year
- Whether kontrollbalansräkning has been prepared
- **Flerårsöversikt**: nettoomsättning, resultat efter finansiella poster, soliditet for current year + 3 preceding years
- Specification of changes in eget kapital
- Board's proposed **resultatdisposition**

### Resultaträkning
- K2: **kostnadsslagsindelad** format ONLY
- K3: both kostnadsslagsindelad and funktionsindelad allowed
- Key lines: nettoomsättning, lagerförändring, övriga rörelseintäkter, personalkostnader, avskrivningar, finansiella poster, bokslutsdispositioner, skatt på årets resultat, årets resultat

### Balansräkning
- Tillgångar: anläggningstillgångar (immateriella/materiella/finansiella), omsättningstillgångar (varulager/fordringar/kassa)
- Eget kapital och skulder: bundet/fritt eget kapital, obeskattade reserver, avsättningar, långfristiga/kortfristiga skulder
- K2: rigid template, cannot add/merge line items beyond template

### Minimum notes (K2)
- Applied redovisningsprinciper ("upprättad i enlighet med ÅRL och BFNAR 2016:10")
- Avskrivningstider per asset category
- Medelantal anställda
- Ställda säkerheter
- Eventualförpliktelser

K3 requires significantly more: deferred tax analysis, critical judgments, estimation uncertainty.

### Signing
All board members + VD (if appointed) must sign. Revisionsberättelse appended if company has revisor.

---

## NE-bilaga for Enskild firma

Form: blankett 2161, filed as part of Inkomstdeklaration 1.

### Page 1: Räkenskapsschema
- R1-R4: Intäkter (momspliktiga, momsfria, egna uttag, övriga)
- R5-R13: Kostnader (varuinköp, externa kostnader, löner, arbetsgivaravgifter, avskrivningar)
- R14: Bokfört resultat
- B1-B22: Condensed balansräkning

### Page 2: Skattemässiga justeringar
- R15-R46: räntefördelning, periodiseringsfond, expansionsfond, egenavgifter schablonavdrag
- NE surplus/deficit flows into INK1 under "Inkomst av näringsverksamhet"

---

## Audit thresholds

Private AB may opt out of revisor if NOT exceeding 2 of 3 thresholds for 2 consecutive years:
- **>3 average employees**
- **>1.5 MSEK total assets**
- **>3 MSEK net revenue**

Exceeding → must have registered revisor, revisionsberättelse becomes part of årsredovisning.

---

## Filing deadlines

### AB with calendar year (Jan-Dec)

| Milestone | Deadline | Penalty |
|-----------|----------|---------|
| Årsredovisning prepared | June 30 (6 months) | Bokföringsbrott risk |
| Bolagsstämma (AGM) | June 30 (6 months) | Must adopt årsredovisning |
| Årsredovisning to Bolagsverket | July 31 (7 months) | Förseningsavgift 5,000 SEK |
| Inkomstdeklaration 2 to Skatteverket | August 1 | Förseningsavgift 6,250 SEK |

For brutet räkenskapsår: same intervals relative to fiscal year-end.

### Late filing penalties (Bolagsverket)
- After 7 months: **5,000 SEK**
- After 9 months: additional **5,000 SEK**
- After 11 months: additional **10,000 SEK**
- Total maximum: **20,000 SEK** (private AB)
- After 11 months: Bolagsverket initiates **tvångslikvidation**
- Penalties are NOT tax-deductible

### Filing formats
- Bolagsverket: **iXBRL** via API, or paper/PDF + fastställelseintyg (signed with BankID)
- Skatteverket INK2: main form (INK2), räkenskapsschema (INK2R), skattemässiga justeringar (INK2S). INK2R/INK2S uploadable as **SRU-filer** via filöverföring.

### Enskild firma
- **Inkomstdeklaration 1 + NE-bilaga** by **May 2** (or nearest weekday)
- 2026: May 4 for fiscal year 2025
- No filing with Bolagsverket

---

## SIE4 Export

SIE (Standard Import Export) is the Swedish open standard. SIE 4 provides full transaction-level data.

### File format
- Plain text, **CP437 encoding**
- Hash-prefixed tags

### Critical tags for year-end closing

| Tag | Description |
|-----|-------------|
| `#SIETYP` | Always "4" |
| `#FNAMN` | Company name |
| `#ORGNR` | Organisationsnummer |
| `#RAR` | Fiscal year definition (0 = current, -1 = previous) |
| `#KPTYP` | Chart of accounts (e.g. "BAS2025") |
| `#KONTO` | Account number and name |
| `#SRU` | Maps account to Skatteverket field codes |
| `#IB` / `#UB` | Opening/closing balances (balance sheet accounts) |
| `#VER` | Verification header (series, number, date, description) |
| `#TRANS` | Transaction lines within verification |

### Bokslutstransaktioner conventions
- Use dedicated **verifikationsserie** (e.g. "I" or "B")
- Dated on balance sheet date
- Many systems treat as **period 13** (boksluts period)
- `#SRU` tag enables automated INK2R/INK2S generation

### File extensions
- `.se`: complete export with balances
- `.si`: transaction-only import

### Example SIE4 snippet
```
#FLAGGA 0
#FORMAT PC8
#SIETYP 4
#PROGRAM "AccountingSoft" 2.0
#GEN 20260401
#FNAMN "Exempel AB"
#ORGNR 556123-4567
#RAR 0 20250101 20251231
#KPTYP BAS2025
#KONTO 8910 "Skatt på årets resultat"
#SRU 8910 7650
#IB 0 2091 -500000.00
#UB 0 2091 -897000.00
#VER "I" 1 20251231 "Bokslut - skatteberäkning"
{
  #TRANS 8910 {} 103000.00
  #TRANS 2512 {} -103000.00
}
```