---
name: swedish-accounting-compliance
description: Swedish accounting law and compliance reference for developers building accounting software. Use this skill whenever working on features that touch Swedish bookkeeping rules, tax compliance, chart of accounts, financial reporting, or regulatory requirements. Triggers include any mention of BFL, BFNAR, BAS kontoplan, SIE4, K2/K3, momsdeklaration, Skatteverket integration, verifikationer, löpande bokföring, årsbokslut, årsredovisning, bokföringsskyldighet, or Swedish accounting compliance in general. Also trigger when the user is checking whether a feature, data model, or workflow complies with Swedish accounting law, or when implementing tax calculations, invoice requirements, or financial reporting for Swedish entities. Use this skill even if the user just asks "is this compliant?" or "what does the law say about X?" in a Swedish accounting context. This skill is a compliance oracle, not an end-user guide.
---

# Swedish Accounting Compliance

Developer-facing compliance reference for building Swedish accounting software. This skill answers questions about what the law requires so you can verify your implementation is correct.

## How to use this skill

This skill has a router structure. The SKILL.md contains the most critical rules you need constantly. Detailed reference material lives in `references/`. Read the relevant reference file when you need depth on a specific area.

### Reference files

| File | When to read |
|---|---|
| `references/bfl-bfnar.md` | Questions about bokföringslagen (BFL), BFNAR, K1/K2/K3, ÅRL, bokföringsskyldighet, verifikationer, arkivering, räkenskapsår, systemdokumentation |
| `references/skatteverket.md` | Questions about moms/VAT, arbetsgivaravgifter, skattedeklaration, F-skatt, skattekonto, Skatteverket API integration, AGI |
| `references/bas-kontoplan.md` | Questions about BAS chart of accounts, account numbering, account classification, mapping transactions to accounts |
| `references/sie4.md` | Questions about SIE file format, import/export, data exchange between systems |
| `references/changes-2025-2026.md` | Questions about recent or upcoming regulatory changes, new rules, updated amounts/thresholds |

Read multiple reference files when a question spans domains (common).

## Core principles (always in context)

### Bokföringsskyldighet (BFL 2 kap)
Every aktiebolag, handelsbolag, and ekonomisk förening is bokföringsskyldigt. Enskild firma with fysisk person is bokföringsskyldig. The obligation cannot be delegated: even if someone else does the bokföring, the företagare is legally responsible.

### Löpande bokföring (BFL 5 kap)
- Affärshändelser shall be bokförda in both grundbok (journal) and huvudbok (ledger)
- Kontanta in/utbetalningar: senast nästa arbetsdag
- Övriga affärshändelser: so snart det kan ske, which in practice means within the calendar month following the month the event occurred
- Every affärshändelse requires a verifikation

### Verifikationer (BFL 5 kap 6-7§)
A verifikation must contain:
1. Datum för affärshändelsen
2. Datum för verifikationen (if different)
3. Vad affärshändelsen avser (description)
4. Belopp
5. Motpart (when applicable)
6. References to underlag (kvitto, faktura etc.)
7. Verifikationsnummer (unique, in unbroken series per räkenskapsår)

Verifikationer must be numbered in a systematisk serie without gaps. If a verifikation is corrected, the original must be preserved and the correction linked.

### Rättelse (BFL 5 kap 5§)
A rättelse of a bokföringspost must be documented so that both the original and the corrected post are visible, and it must be recorded when the rättelse was made and who made it. You can never silently overwrite. BFL permits two tracks:
1. **Särskild rättelsepost** (storno + correcting verifikation referencing the original): always allowed, and the only track once the period is locked/closed or the bokföring has been relied upon (filed declarations, bokslut).
2. **Rättelse in the same verifikat** (strike-and-replace of lines, or correcting the verifikation's text/date per BFL 5 kap 9 §): allowed while the period is open and unlocked, provided the original remains readable (struck lines stay visible) and who/when is recorded immutably. Fortnox and Visma implement this track; in Accounted it is the `correct_entry_metadata` / `correct_entry_lines_inline` RPC envelope logging to `journal_entry_rattelse_log`.

A correction path that erases the original without a trace violates the law under both tracks.

### Arkivering (BFL 7 kap)
- Räkenskapsinformation must be preserved for 7 years after the end of the calendar year the räkenskapsår ended
- Since 1 July 2024: no requirement to keep paper originals after digitization (BFL 7 kap 6§ updated)
- Digital storage must ensure the information cannot be altered (immutability requirement)
- Must be accessible in Sweden (or within EU/EEA with Skatteverket notification)

### Momssatser (current as of 2026)
- 25% - standard rate (most goods and services)
- 12% - food/restaurants, hotels, some cultural events
- 6% - books, newspapers, public transport, cultural/sports events, livsmedel (temporarily from 1 April 2026 to 31 Dec 2027)
- 0% - certain financial services, healthcare, education, insurance

**IMPORTANT**: From 1 April 2026, livsmedel drops from 12% to 6% (tillfälligt, Prop. 2025/26:55). Restaurang/servering stays at 12%. Software must handle the transition date and the eventual reversion.

### Fakturakrav (ML 17 kap)
A momsregistrerad seller's faktura must contain:
1. Utfärdandedatum
2. Löpnummer (unique, unbroken series)
3. Säljarens momsregistreringsnummer
4. Köparens momsregistreringsnummer (if reverse charge or EU)
5. Säljarens och köparens namn och adress
6. Varans/tjänstens art, omfattning, mängd
7. Datum för leverans/tillhandahållande
8. Beskattningsunderlag per skattesats
9. Tillämpad skattesats
10. Momsbelopp
11. Eventuell hänvisning till undantag

Förenklad faktura (max 4000 SEK inkl moms) has reduced requirements.

### Key thresholds (2026)
- Prisbasbelopp: 59 200 kr
- Inkomstbasbelopp: 83 400 kr
- Inventarier av mindre värde: halvt prisbasbelopp = 29 600 kr (exkl moms)
- Förenklat årsbokslut: omsättning normalt < 3 MSEK
- Kontantmetod: omsättning normalt < 3 MSEK
- Revisionspliktig (AB): minst 2 av 3: >3 anställda, >1.5 MSEK balansomslutning, >3 MSEK nettoomsättning (two consecutive years)

### System documentation (BFL 5 kap 11 §, BFNAR 2013:2 kap 9)
Bokföringssystem must have (kapitel 8 is arkivering; this is kapitel 9, verified against BFN's consolidated text 2026-08-21):
1. Systemdokumentation (p. 9.2-9.15): kontoplan, samlingsplan, arkivplan, verifikationsnummerserier, verifieringskedjor, behandlingsregler, informationsflöden
2. Behandlingshistorik (p. 9.16): every bokföringspost with registreringsdatum, and changes to the system that affect processing (kontoplan, behandlingsregler such as automatkonteringar and percentages, program versions) with dates; p. 9.15 asks the systemdokumentation to say where and how it is produced

Your software must produce or support both. This is not optional.
