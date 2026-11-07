# Vyskisser

Grova skisser av de viktigaste vyerna. De ritas om i Fas 4. Kundflödet utgår från mobil, personalvyerna från surfplatta och dator.

## Kund: boka (tre steg)

```
┌──────────────────────────┐  ┌──────────────────────────┐  ┌──────────────────────────┐
│ Salong Exempel           │  │ ← Klippning · 60 min     │  │ ← Bekräfta               │
│                          │  │ Personal: [Valfri ▾]     │  │ Mån 30 mars 09:00–10:00  │
│ Välj tjänst              │  │                          │  │ Klippning hos Anna       │
│ ┌──────────────────────┐ │  │ ◀  v. 14  ▶              │  │ 500 kr                   │
│ │ Klippning    60 min  │ │  │ Mån Tis Ons Tor Fre      │  │                          │
│ │ 500 kr             › │ │  │ [30] 31  1   2   3       │  │ Namn    [____________]   │
│ ├──────────────────────┤ │  │                          │  │ E-post  [____________]   │
│ │ Färg         90 min  │ │  │ 09:00  09:15  09:30      │  │ Telefon [____________]   │
│ │ 900 kr             › │ │  │ 10:45  11:00  13:00      │  │ Meddelande (valfritt)    │
│ └──────────────────────┘ │  │ …                        │  │                          │
│                          │  │ Tider i svensk tid       │  │ [   Boka tiden   ]       │
└──────────────────────────┘  └──────────────────────────┘  └──────────────────────────┘
```

- Om svaret blir 409 `slot-unavailable` visas "Tiden hann bokas av någon annan". Tiderna laddas om och kunden står kvar på samma dag. Formuläret töms inte.
- Varje försök att skicka formuläret får en ny `Idempotency-Key` som återanvänds vid automatiska omförsök.
- Tider visas alltid i företagets tidszon, med en notering om webbläsaren har en annan zon.

## Kund: hantera bokning (via länk eller "Mina bokningar")

```
┌──────────────────────────┐
│ Din bokning              │
│ Mån 30 mars 09:00–10:00  │
│ Klippning hos Anna       │
│ Status: Bekräftad        │
│                          │
│ [ Avboka ]               │
│ Avbokning senast 07:00   │
└──────────────────────────┘
```

## Personal: dagkalender

```
┌────────────────────────────────────────────────────────────────┐
│ ◀ Måndag 30 mars ▶        [Dag|Vecka]   ⚠ 2 konflikter   + Ny │
├──────┬───────────────────┬───────────────────┬─────────────────┤
│      │ Anna              │ Bo                │ Cecilia         │
├──────┼───────────────────┼───────────────────┼─────────────────┤
│ 09   │ ███ Kim S.        │                   │ ░░ frånvaro ░░  │
│      │ ▒ buffert         │ ███ Lo P.         │ ░░░░░░░░░░░░░░  │
│ 10   │                   │ ███               │ ░░░░░░░░░░░░░░  │
│ 11   │ ███ Alex B.       │                   │                 │
│ 12   │ ── lunch ──       │ ── lunch ──       │                 │
└──────┴───────────────────┴───────────────────┴─────────────────┘
```

- Bufferten visas som en ljusare del av bokningsblocket. Frånvaro och tid utanför arbetstid är skuggade.
- Bannern "konflikter" listar bokningar som har hamnat utanför öppen tid efter en schemaändring (ADR-0002).
- Kalendern ska gå att använda med tangentbord: piltangenter mellan tider, Enter öppnar, och fokus ringas in tydligt.

## Admin: arbetstider

```
┌────────────────────────────────────────────┐
│ Arbetstider · Anna       Gäller från [6/4] │
│ Mån  09:00–12:00  13:00–17:00   [+]        │
│ Tis  09:00–17:00                [+]        │
│ Ons  —                          [+]        │
│ …                                          │
│ [ Spara ]  ⚠ 3 bokningar hamnar utanför    │
└────────────────────────────────────────────┘
```
