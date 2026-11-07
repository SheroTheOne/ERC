# ADR-0005: Fria intervall i SQL, tidsluckor i en ren funktion

- **Status:** Accepterad
- **Datum:** 2026-11-07

## Kontext

Lediga tider = arbetstid − frånvaro − bokningar (inklusive buffert). Resultatet måste stämma med det triggern accepterar (ADR-0002). Annars visar vi tider som sedan nekas, eller döljer tider som egentligen är lediga. Kraven är att algoritmen är deterministisk och att inget lagras eller cachas i förväg.

## Beslut

Uträkningen görs i två steg med tydligt ansvar:

**1. SQL ger fria intervall som `tstzmultirange`.** Varje funktion bygger på den föregående:

```
staff_working_periods(staff, window)                      -- väggklocka → absolut tid
staff_open_periods  = working − range_agg(time_off)       -- används också av triggern
staff_free_periods  = open    − range_agg(booking.blocked)
```

Multirange-aritmetik (`-`, `*`, `range_agg`) sköter sammanslagning, klippning och hål. Inga egna intervallalgoritmer behövs, och samma `staff_open_periods` används både av motorn och av triggern. Därför kan de inte ge olika svar.

**2. TypeScript genererar tidsluckor med en ren funktion** utan I/O:

```ts
generateSlots(freePeriods, { durationMin, bufferBeforeMin, bufferAfterMin, stepMin, timeZone, notBefore, notAfter }): Slot[]
```

En starttid `s` på rutnätet (förankrat i lokal tid, se ADR-0004) är ledig om `[s − bufferBefore, s + duration + bufferAfter) ⊆` något fritt intervall och `notBefore ≤ s ≤ notAfter`. Där kommer policyreglerna in, alltså framförhållning och hur långt fram man kan boka. Funktionen testas med enhetstester och egenskapstester (fast-check), till exempel att ingen lucka överlappar ett upptaget intervall, att resultatet är sorterat och utan dubbletter, och att samma indata alltid ger samma utdata.

- Bufferten ska rymmas inom öppen tid. Det är konservativt och stämmer med triggern.
- "Valfri personal": unionen av luckor över all personal som utför tjänsten. Personal tilldelas när bokningen görs (ADR-0003).
- Frågefönstret begränsas till högst 14 dagar per anrop för att hålla kostnaden förutsägbar.

## Konsekvenser

- Visade luckor och databasens kontroller bygger på samma underlag. Det enda som kan skilja är tid som hinner bokas mellan läsning och skrivning, och då ger databasen 409.
- Prestanda: en fråga per personal och fönster, med GiST-index på `(staff_id, period)` och `(staff_id, blocked)`. Mätning görs i Fas 2. Cache införs bara om mätningen visar att det behövs, och i så fall med invalidering vid skrivning.

## Alternativ som valdes bort

- **Allt i TypeScript:** reglerna för öppen tid skulle finnas både i TypeScript och i SQL-triggern och riskera att glida isär.
- **Även luckorna i SQL (`generate_series`):** fungerar, men rutnät och policy är enklare att testa med egenskapstester i en ren funktion.
- **Förberäknade luckor:** måste invalideras vid varje ändring och fungerar dåligt med varierande längd och buffert.
