# NE-bilaga: Field Reference and Booked vs Declaration-Only

Where each EF disposition lives: in räkenskaperna, on the NE-bilaga, or both. Read together with [[periodiseringsfond-expansionsfond-ef]] (bokföringsförbudet under K1) and `swedish-year-end-closing/references/k1-forenklat-arsbokslut.md` (förenklat årsbokslut mechanics).

## Critical distinction: booked vs declaration-only

EF differs sharply from AB on which items are booked vs only entered on NE-bilagan:

| Item | Booked in räkenskaperna? | Where it lives |
|---|---|---|
| Räntefördelning | NEVER | NE sid 2 R30/R31 |
| Periodiseringsfond EF | NEVER (per BFNAR 2006:1 / K1) | NE sid 2 R32/R34 |
| Expansionsfond | NEVER (per K1) | NE sid 2 R36/R37 |
| Ersättningsfond | YES (avsättning bokförs); resterande hanteras i deklaration | Bokfört + NE |
| Egenavgifter schablonavdrag | NEVER | NE sid 2 R43, avstämning R40/R41 |
| Skatt på årets resultat | NEVER (personal tax) | Inte i bokföringen |
| Inventarieavskrivning | YES (8851/1229 etc) | Bokfört |
| Förenklat årsbokslut U1-U4 | Upplysning, ej bokfört | NE-bilaga upplysning |

This is the largest source of conceptual errors when implementing EF bookkeeping software: developers familiar with AB-flows often try to book P-fond/expansionsfond, which is *forbidden* for EF under K1 (BFNAR 2006:1).

## NE-bilaga key field reference (cross-link with swedish-year-end-closing)

| Ruta | Innehåll |
|---|---|
| R11 | Bokfört resultat (samma som förenklat årsbokslut; förs till R12 sid 2) |
| R12-R28 | Skattemässiga justeringar (R13-R16 ej avdragsgilla kostnader/ej skattepliktiga intäkter m.m., R17-R21 gemensam verksamhet/medhjälpande make, R22-R23 övriga justeringar, R24 outnyttjat underskott föregående år, R25-R28 skogsavdrag, återföring värdeminskningsavdrag, skogskonto/upphovsmannakonto) |
| R29 | Överskott/underskott före räntefördelning |
| R30 | Positiv räntefördelning (till INK1 p.11.1, inkomst av kapital) |
| R31 | Negativ räntefördelning (till INK1 p.11.2, avdrag i kapital) |
| R32 | Återföring av periodiseringsfond (oldest year first) |
| R33 | Överskott före avsättning till periodiseringsfond |
| R34 | Avsättning till periodiseringsfond (max 30% av R33) |
| R35 | Överskott före ökning av expansionsfond |
| R36 | Ökning av expansionsfond, högst R35 (till INK1 p.12.1) |
| R37 | Minskning av expansionsfond (till INK1 p.12.2) |
| R38 | Egna pensionspremier / inbetalning på pensionssparkonto som dras av i NV (endast aktiv) |
| R39 | Särskild löneskatt på pensionssparavdraget i R38 |
| R40 | Förra årets medgivna avdrag för egenavgifter/SLP (= fjolårets R43, tas upp som intäkt) |
| R41 | Påförda egenavgifter/SLP enligt slutskattebeskedet (avdrag) |
| R42 | Överskott/underskott före avdrag för egenavgifter/SLP |
| R43 | Årets beräknade (schablon)avdrag för egenavgifter/SLP |
| R44 | Sjukpenning som hör till näringsverksamheten |
| R45 | Allmänt avdrag: utnyttjat underskott i nystartad (aktiv) eller konstnärlig NV: till INK1 p.14.1 |
| R46 | Underskott som utnyttjas i kapital (avyttring näringsfastighet/näringsbostadsrätt) |
| R47 | Överskott → INK1 p.10.1 (aktiv) eller p.10.3 (passiv) |
| R48 | Underskott → INK1 p.10.2 (aktiv) eller p.10.4 (passiv); förs nästa år till R24 |

Rutorna R49/R50 finns inte. Field positions verified mot Skatteverkets fältnamnstabell `NE_SKV2161-13-02-25-02` (SRU-paket 2025P4) och hjälptexten till NE för inkomstår 2025. Verify mot innevarande års blankett.
