# Software capitalization: K3, K2, IFRS

## K3 (BFNAR 2012:1) kap 18: internt upparbetade immateriella tillgångar

**18.7 Principval.** Företaget **väljer** mellan:
- **Aktiveringsmodellen**: utgifter aktiveras när alla kriterier i 18.12 uppfylls
- **Kostnadsföringsmodellen**: alla utgifter kostnadsförs löpande

Valet är en redovisningsprincip; tillämpas konsekvent över alla projekt och alla år, ändring kräver byte av redovisningsprincip (K3 10.6).

### Sex aktiveringskriterier (18.12)

Samtliga måste uppfyllas, dokumenteras och kunna styrkas:

1. **Teknisk genomförbarhet** att färdigställa tillgången
2. **Avsikt** att färdigställa och använda/sälja
3. **Förmåga** att använda eller sälja
4. **Sannolika ekonomiska fördelar** (marknad finns eller intern användning ger nytta)
5. **Tillräckliga resurser** för att färdigställa (teknik, finansiering, personal)
6. **Tillförlitlig mätning** av utgifterna under utvecklingsfasen

### Forskningsfas vs utvecklingsfas (18.11)

Forskningsfas: ingen säker plan, experimenterande → **kostnadsförs alltid**. Typiska exempel för IT: research-spike, proof-of-concept, alternativbedömningar.

Utvecklingsfas: efter PoC bekräftat genomförbarhet → kan aktiveras om 18.12 uppfylls. Praktisk vattendelare: när teknisk genomförbarhet är bevisad och produktbeslut fattat.

### Förbud (18.5)

Får **inte** aktiveras:
- Internt upparbetade varumärken
- Internt upparbetade utgivningsrättigheter
- Kundregister och liknande
- "Säljande" del av webbplats (marknadsföringsmaterial)

### Avskrivning

Avskrivningstid = **nyttjandeperiod**. Om nyttjandeperiod inte kan tillförlitligt fastställas → **5 år** (ÅRL 4 kap 4§ 2 st). Linjär metod är norm för programvara.

## K2 (BFNAR 2016:10) punkt 10.4: aktiveringsförbud

> "Ett företag får inte aktivera utgifter för egenupparbetade immateriella anläggningstillgångar."

**Konsekvens.** K2-bolag kostnadsför all egen utvecklingstid direkt. **Förvärvade** immateriella tillgångar (köpt mjukvara, köpta licenser) får aktiveras enligt 10.6-10.18.

**Tvingar K3-val** för SaaS-bolag som vill kapitalisera. K3-val utlöser i sin tur:
- Revisionsplikt över gränsvärdena (omsättning ≥ 3 MSEK, balansomslutning ≥ 1,5 MSEK, anställda ≥ 3, två av tre i två år)
- Fond för utvecklingsutgifter (ÅRL 4 kap 2§)
- Uppskjuten skatt (K3 29)
- Större notapparat

## IAS 38 / RFR 2: noterade bolag

IAS 38.57 gör aktivering **tvingande** när kriterierna uppfylls (skillnad mot K3 där aktivering är frivilligt principval). Sex kriterier i IAS 38.57 är i sak identiska med K3 18.12.

**IFRS 15**: intäktsredovisning. Tillåter inte färdigställandemetoden: intäkter ska redovisas över tid när art. 35-kriterier uppfylls, eller vid en tidpunkt (kontrollövergång).

## Fond för utvecklingsutgifter: ÅRL 4 kap 2§

Aktivering enligt K3 18 **tvingar** överföring från fritt EK till bunden fond **2089 Fond för utvecklingsutgifter** med belopp motsvarande aktiveringen. Fonden upplöses i takt med avskrivning/nedskrivning eller försäljning av tillgången.

**3:12-implikation.** Aktiverade 5 MSEK utvecklingsutgifter → 5 MSEK låst i 2089 → utdelningsbara medel minskar omedelbart. För fåmansbolag med ägare som vill maximera utdelning enligt 3:12 är detta en direkt kostnad.

**Strategiskt val:** vissa SaaS-bolag väljer K2 eller K3 + kostnadsföringsmodellen specifikt för att hålla fritt EK ofångat. Inverkar negativt på balansomslutningen och kan påverka bolagets attraktivitet vid extern finansiering: investerare vill se aktivering för att se "tillgångsbasen" i mjukvaran.

## Successiv vinstavräkning

### K3 kap 23

**23.17-23.18 huvudregel.** När utfallet kan mätas tillförlitligt: intäkter och utgifter periodiseras efter färdigställandegrad (input-method med kostnader eller output-method med milstolpar).

**23.31 alternativregeln** (färdigställandemetoden): tillåten i juridisk person för:
- Bygg
- Anläggning
- Hantverk
- **Konsultverksamhet** (uttryckligen, IT-konsult kvalificerar)

I koncernredovisning enligt K3 är endast successiv vinstavräkning tillåten.

**23.32 befarad förlust.** Kostnadsförs direkt och i sin helhet när bedömningen görs.

### K2 kap 6

**Löpande räkning (6.16-6.18):** successiv vinstavräkning är **obligatorisk**. Intäktsredovisas i takt med fakturering, kostnader matchas.

**Fastpris (6.19-6.20):** **val** mellan:
- Huvudregel: successiv vinstavräkning
- Alternativregel: färdigställandemetoden (intäkt vid leverans)

### Skattemässig synk (IL 17 kap 23-32§§)

Pågående arbeten skattemässigt:
- Tjänsteuppdrag till fast pris → kan tas upp enligt **färdigställandemetoden** (IL 17 kap 26§)
- Tjänsteuppdrag på löpande räkning → faktureringsmetoden eller successivt

Många små IT-konsult-AB väljer **K2 + färdigställandemetoden** för fastprisuppdrag → senare skattedebitering + enklare bokföring. Trade-off: större volatilitet i resultat över bokslutsår.

## Bokföringsmönster

### Aktivering av egen utvecklartid (K3)

```
1010 Utvecklingsutgifter            debet  Aktiverat belopp
  3800 Aktiverat arbete för egen räkning  kredit  Aktiverat belopp

2099 Årets resultat                 debet  Aktiverat belopp
  2089 Fond för utvecklingsutgifter  kredit  Aktiverat belopp
```

### Aktivering av köpt programvarukomponent

```
1012 Balanserade utgifter för programvaror  debet  Anskaffningsvärde exkl. moms
2641 Ingående moms                          debet  25 %
  2440 Leverantörsskulder                   kredit  Bruttobelopp
```

### Linjär avskrivning (5 år)

```
7811 Avskrivningar på balanserade utgifter  debet  Anskaffning / 5
  1019 Ackumulerade avskrivningar           kredit  Anskaffning / 5
```

Upplösning av fonden i takt med avskrivning:

```
2089 Fond för utvecklingsutgifter           debet  Anskaffning / 5
  2091 Balanserad vinst                     kredit  Anskaffning / 5
```

### Nedskrivning vid produktnedläggning

```
7820 Nedskrivningar av immateriella anläggningstillgångar  debet  Återstående bokfört värde
  1018 Ackumulerade nedskrivningar                          kredit
```

Upplös motsvarande del av 2089.

## Lagreferenser

- BFNAR 2012:1 (K3) kap 18: immateriella anläggningstillgångar
- BFNAR 2016:10 (K2) kap 10: immateriella tillgångar (aktiveringsförbud i 10.4)
- ÅRL (1995:1554) 4 kap 2§: fond för utvecklingsutgifter
- ÅRL 4 kap 4§: avskrivning av immateriell anläggningstillgång
- IAS 38: internt upparbetade immateriella tillgångar (RFR 2)
- IFRS 15: intäktsredovisning från kundkontrakt
- IL (1999:1229) 17 kap 23-32§§: pågående arbeten
