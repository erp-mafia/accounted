# BFL, BFNAR, and ÅRL Reference

Detailed reference for Bokföringslagen (BFL 1999:1078), Bokföringsnämndens allmänna råd (BFNAR), and Årsredovisningslagen (ÅRL 1995:1554).

## Table of Contents
1. BFL structure and key chapters
2. Bokföringsskyldighet (BFL 2 kap)
3. Löpande bokföring (BFL 5 kap)
4. Verifikationer in depth
5. Avslutning av bokföringen (BFL 6 kap)
6. Arkivering (BFL 7 kap)
7. BFNAR overview and K-regelverken
8. K1 (BFNAR 2006:1)
9. K2 (BFNAR 2016:10)
10. K3 (BFNAR 2012:1)
11. ÅRL key requirements
12. Systemdokumentation and behandlingshistorik

---

## 1. BFL structure

BFL has 9 chapters:
- 1 kap: Inledande bestämmelser (definitions)
- 2 kap: Bokföringsskyldighet
- 3 kap: Räkenskapsår
- 4 kap: Bokföringsskyldighetens innebörd
- 5 kap: Löpande bokföring och verifikationer
- 6 kap: Avslutande av bokföringen (årsbokslut/årsredovisning)
- 7 kap: Arkivering
- 8 kap: Utvecklande av god redovisningssed (BFN:s uppdrag)
- 9 kap: Överklagande

## 2. Bokföringsskyldighet (BFL 2 kap)

**Always bokföringsskyldiga:**
- Aktiebolag (from registration, even before any activity)
- Handelsbolag (including kommanditbolag)
- Ekonomiska föreningar
- Stiftelser (with some exceptions for small stiftelser)
- Ideella föreningar that meet any of: tillgångar > 1.5 MSEK, bedriver näringsverksamhet, or is modersföretag

**Fysiska personer:**
- Bokföringsskyldiga if they bedriver näringsverksamhet (enskild firma)
- Exception: very small hobby-like activities may not qualify

**When does skyldigheten begin?**
- AB: from Bolagsverket registration
- Enskild firma: from first affärshändelse in the näringsverksamhet
- Handelsbolag: from when bolaget begins verksamhet

## 3. Löpande bokföring (BFL 5 kap)

### Grundbok och huvudbok (5 kap 1§)
All affärshändelser must be recorded in both:
- **Grundbok** (journal): chronological order, each entry traceable to verifikation
- **Huvudbok** (ledger): systematic order by account (kontoplan)

These can be in the same system but must be logically separate outputs.

### Timing requirements (5 kap 2§)
- Kontanta transaktioner: bokföras senast påföljande arbetsdag
- Övriga affärshändelser: "så snart det kan ske"
- In practice (per BFNAR 2013:2): senast the month following the month of the affärshändelse
- Exception: om den bokföringsskyldige har ordnade verifikationer that are easily accessible, bokföring kan dröja up to 50 dagar from the transaction

### Kontantmetod vs faktureringsmetod
- **Kontantmetod**: bokföring vid betalningstillfället (only allowed if nettoomsättning normalt < 3 MSEK)
- **Faktureringsmetod**: bokföring vid fakturadatum (required if nettoomsättning >= 3 MSEK, and for all momspliktig verksamhet above the threshold)
- A company can choose faktureringsmetod even under 3 MSEK
- Kontantmetod still requires that fordringar/skulder are booked at bokslut

### Gemensam verifikation (5 kap 6§ st 3)
Multiple affärshändelser can share one verifikation if they are of the same slag and occurred the same dag. Example: daily kassarapport for retail.

## 4. Verifikationer in depth

### Required content (5 kap 7§)
1. Datum then affärshändelsen occurred
2. Datum when verifikationen upprättades (if different from #1)
3. Vad affärshändelsen avser
4. Belopp
5. Motpart (where applicable and known)
6. Verifikationsnummer (or equivalent identifier, systematiskt ordnade, löpande nummerordning, without gaps within a bokföringsserie)
7. Other information needed to identify the affärshändelse

### Underlag
Every verifikation must have an underlag (kvitto, faktura, bankutdrag, avtal, etc.). If no external underlag exists, the bokföringsskyldige must create an egen handling as underlag (e.g., for lönebokföring based on löneberäkning, or for avskrivningar).

### Multiple verification series
BFL allows multiple verification series (e.g., "A" for supplier invoices, "B" for customer invoices, "K" for bank). Each series must have unbroken numbering within the räkenskapsår. This is common in practice and your software should support it.

### Rättelser (5 kap 5§ and 5 kap 9§)
- The original post must remain visible (no silent overwriting), and it must be recorded when the rättelse was made and who made it
- Two permitted tracks:
  1. **Särskild rättelsepost**: a correcting verifikation with a link/reference to the original. Always allowed; the only track once the period is locked/closed or the bokföring has been relied upon (filed declarations, bokslut)
  2. **Rättelse in the same verifikat**: strike-and-replace of lines with the struck originals kept readable, or correction of the verifikation's text/date (5 kap 9 §). Allowed in open, unlocked periods with an immutable who/when trail. This is the track Fortnox/Visma expose as "ändra verifikat"
- When rättelse happens through a särskild rättelsepost, it must be easy to become aware of the rättelse when inspecting the corrected post ("utan svårighet gå att få kännedom om rättelsen")

## 5. Avslutning av bokföringen (BFL 6 kap)

### Årsbokslut
- Required for enskild firma and handelsbolag with fysiska delägare
- Consists of: resultaträkning + balansräkning
- Must be upprättat within 6 months after räkenskapsårets slut
- Förenklat årsbokslut: allowed if nettoomsättning normalt < 3 MSEK (BFNAR 2006:1 / K1)

### Årsredovisning
- Required for: aktiebolag, ekonomiska föreningar, larger handelsbolag, stiftelser above thresholds
- Consists of: förvaltningsberättelse, resultaträkning, balansräkning, noter
- Larger companies also: kassaflödesanalys
- Must be upprättat within: 6 months for AB, 7 months for ekonomisk förening
- AB must file with Bolagsverket within 7 months, or face förseningsavgift

## 6. Arkivering (BFL 7 kap)

### Bevarandetid
7 years after the end of the calendar year in which the räkenskapsår ended. Example: räkenskapsår ending 2026-06-30 -> save until at least 2033-12-31.

### Form
- Must be in varaktigt läsbart skick (durable, readable form)
- Digital storage: must ensure data integrity (immutability)
- Since 1 July 2024 (SFS 2024:494): no requirement to keep paper originals after proper digitization
- The digitized version must be a faithful reproduction
- Metadata and structure must be preserved

### Location
- Must be available in Sweden
- Can be stored in EU/EEA if Skatteverket is notified
- Must be producible to Skatteverket upon request within reasonable time

### What must be archived
- Grundbok and huvudbok
- All verifikationer with underlag
- Årsredovisning/årsbokslut
- Systemdokumentation and behandlingshistorik
- Avtal, korrespondens, and other information important for understanding the bokföring

## 7. BFNAR overview and K-regelverken

BFN issues allmänna råd (BFNAR) that specify how BFL and ÅRL should be applied in practice. The K-system categorizes companies by size:

| Regelverk | Target | Årsredovisning? | Key characteristic |
|---|---|---|---|
| K1 (BFNAR 2006:1) | Enskild firma < 3 MSEK | No (förenklat årsbokslut) | Cash-based simplifications |
| K2 (BFNAR 2016:10) | Smaller AB, HB, EF, ideella | Yes (simplified) | Schabloner, limited upprysningar |
| K3 (BFNAR 2012:1) | Default for ÅRL-companies | Yes (full) | Component depreciation, full disclosures |
| K4 (IFRS) | Listed companies | Yes (IFRS) | International standards |

**2026 change**: BRF:er must now use K3 (no longer K2). Companies where byggnader generate >= 75% of nettoomsättning must also K3.

## 8. K1 (BFNAR 2006:1 / 2010:1)

Simplified rules for enskild firma and HB with fysisk delägare, omsättning < 3 MSEK.

Key simplifications:
- Kontantmetoden allowed
- Förenklat årsbokslut (RR + BR only, no notes required beyond what law demands)
- Inventarier can use skattemässiga avskrivningar directly
- Varulager can be valued at anskaffningsvärde without individual assessment under threshold
- No requirement for accruals below 5000 kr per post

## 9. K2 (BFNAR 2016:10)

For smaller companies that prepare årsredovisning.

Key characteristics:
- Schablonmässiga avskrivningar (not component-based)
- Limited tilläggsupplysningar compared to K3
- Cannot capitalize egenupparbetade immateriella tillgångar
- Byggnader: avskrivning as one unit (not component)
- Avsättningar: only if legal obligation exists and can be reliably estimated
- Eventualförpliktelser: disclosed in notes

**Restrictions from 2026**: BRF:er excluded from K2, companies with >= 75% revenue from buildings excluded. See changes-2025-2026.md.

## 10. K3 (BFNAR 2012:1)

Default regelverk for companies preparing årsredovisning.

Key requirements:
- Component depreciation (komponentavskrivning) for materiella anläggningstillgångar
- Full tilläggsupplysningar per ÅRL
- Can capitalize egenupparbetade immateriella tillgångar (if criteria met)
- Must assess nedskrivningsbehov
- Revenue recognition per leverans/fullgjord prestation
- Leasing classification (finansiell vs operationell)
- Koncernredovisning if moderbolag (with exemptions for smaller koncerner)

## 11. ÅRL key requirements

### Grundläggande principer (2 kap)
- Fortlevnadsprincipen (going concern)
- Konsekvent tillämpning (consistency)
- Försiktighetsprincipen (prudence)
- Periodisering (accrual basis)
- Individuell värdering (each item valued separately)
- Bruttoredovisning (no netting of assets/liabilities or income/expenses)
- Kontinuitet (opening balance = previous year's closing balance)

### Årsredovisningens delar (2 kap 1§)
1. Förvaltningsberättelse
2. Resultaträkning
3. Balansräkning
4. Noter
5. Kassaflödesanalys (larger companies only)

### Larger vs smaller company (ÅRL 1 kap 3§)
A company is "större" if it exceeds at least 2 of 3 for each of the last 2 years:
- 50 anställda (average)
- 40 MSEK balansomslutning
- 80 MSEK nettoomsättning

## 12. Systemdokumentation and behandlingshistorik

### Systemdokumentation (BFNAR 2013:2 kap 9, punkt 9.1-9.15; kap 8 is arkivering)
Must describe:
- The bokföringssystem and how it works
- The kontoplan used
- How verifikationer are numbered and organized
- How the system ensures traceability from verifikation to bokslut
- Access controls and authorization
- Backup routines
- Integration with other systems

### Behandlingshistorik (BFNAR 2013:2 punkt 9.16; BFL 5 kap 11 §)
Must log (and show registreringsdatum for every bokföringspost):
- Automated processing (batch jobs, automated bokföring)
- Changes to system settings that affect bokföring
- User actions (who booked what, when)
- Data migrations, imports, conversions

For a software developer: your system must produce these as exportable documentation. Consider generating systemdokumentation automatically from your system's configuration, and maintaining an audit trail as behandlingshistorik.
