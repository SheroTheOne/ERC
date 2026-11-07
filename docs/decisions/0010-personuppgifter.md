# ADR-0010: Minimal insamling, export och anonymisering

- **Status:** Accepterad
- **Datum:** 2026-11-07

## Kontext

Kunduppgifter är personuppgifter enligt GDPR. Kunden har rätt till tillgång (artikel 15), radering (artikel 17) och dataportabilitet (artikel 20). Samtidigt behöver företaget bokningshistorik för bokföring och statistik.

## Beslut

- **Minimal insamling:** namn och e-post krävs. Telefon och meddelande är valfria. Inga födelsedatum och inga fria anteckningsfält i MVP.
- **Export:** `GET /me/export` (inloggad kund) och `GET /customers/{id}/export` (admin) ger JSON med kunden och alla dess bokningar.
- **Radering betyder anonymisering:** personuppgifterna i `customer` och kontaktuppgifterna på bokningarna ersätts (`name = 'Raderad kund'`, `email = 'deleted+<id>@invalid'`, telefon och meddelande sätts till `NULL`) och `anonymized_at` sätts. Bokningsraderna finns kvar utan personuppgifter, så statistik och beläggning stämmer fortfarande.
- **Lagringstid:** utgångna sessioner, inloggningslänkar, hanteringslänkar och idempotensnycklar rensas av ett schemalagt jobb (dagligen). Hur länge personuppgifter på gamla bokningar sparas ställs in av admin. Standardvärdet är 24 månader, därefter anonymiseras de automatiskt.
- **Loggar** innehåller id:n men aldrig e-post, telefon eller tokens. Pinos `redact` används för det.
- **Demon** innehåller bara påhittade uppgifter.

## Konsekvenser

- Anonymisering är en `UPDATE` och påverkar inga främmande nycklar.
- Ett personuppgiftsbiträdesavtal med e-postleverantören behövs vid riktig drift. Det dokumenteras i Fas 5.

## Alternativ som valdes bort

- **Fysisk radering med kaskad:** förstör historik och statistik.
- **Mjuk radering med `deleted_at` och personuppgifterna kvar:** uppfyller inte rätten till radering.
