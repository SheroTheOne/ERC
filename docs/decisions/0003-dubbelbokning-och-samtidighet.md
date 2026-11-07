# ADR-0003: Dubbelbokning stoppas av EXCLUDE på blockerad tid

- **Status:** Accepterad
- **Datum:** 2026-11-07

## Kontext

Två kunder kan försöka boka samma tid inom samma millisekund. Mönstret "kontrollera att tiden är ledig, sedan INSERT" är en klassisk race condition, eftersom båda transaktionerna ser en ledig tid. Dessutom kräver många tjänster förberedelse eller städning (buffert), och den tiden måste också vara skyddad.

## Beslut

1. **Constraint på blockerad tid, inte på kundens tid.** `booking.blocked = [starts_at - buffer_before, ends_at + buffer_after)` sätts av en trigger och kan inte skrivas av klienten. `booking_no_overlap` är `EXCLUDE USING gist (staff_id WITH =, blocked WITH &&) WHERE (status <> 'cancelled')`.
   - Buffertarna sparas på bokningen som en ögonblicksbild, så att en ändrad tjänst inte påverkar redan bokade tider.
   - `blocked` kan inte vara en genererad kolumn, eftersom `timestamptz ± interval` är `STABLE` och inte `IMMUTABLE`. Därför används en trigger.
   - Alla intervall är halvöppna `[)`. En bokning som slutar 10:00 krockar inte med en som börjar 10:00.
2. **Isoleringsnivå `READ COMMITTED`.** `EXCLUDE` fungerar oberoende av isoleringsnivå: en andra skrivning som krockar med en ännu inte committad rad väntar och misslyckas med `23P01` när den första committas.
3. **Felmappning:** `23P01` på `booking_no_overlap` ger `409 Conflict` med typen `…/problems/slot-unavailable`. Klienten hämtar då nya lediga tider.
4. **"Valfri personal":** servern hämtar lediga personer för tiden i en bestämd ordning (minst bokad tid den dagen, sedan id) och försöker med var och en i en egen `SAVEPOINT`. Första lyckade skrivning vinner. Om alla misslyckas blir svaret 409.
5. **Idempotens:** `POST /bookings` kräver headern `Idempotency-Key` (UUID). Nyckel, hash av request och svar sparas i samma transaktion som bokningen. Om samma nyckel skickas igen med samma innehåll returneras det sparade svaret. Om innehållet skiljer sig blir svaret 422. Utan den här mekanismen skulle en klient som gör om ett anrop efter timeout få 409 mot sin egen bokning.
6. **Avbokning** sätter `status = 'cancelled'`, vilket frigör tiden direkt eftersom constraintet är partiellt. Raden finns kvar för historik.

## Konsekvenser

- Det krävs inga applikationslås och inget `SELECT … FOR UPDATE` för bokningar. Databasen serialiserar bara de skrivningar som faktiskt krockar.
- GiST-index är långsammare att skriva till än B-tree, men obetydligt i den här skalan.
- Testet för Fas 2: 20 samtidiga `POST /bookings` mot samma tid via en pool med minst 20 anslutningar ska ge exakt en 201 och 19 svar med 409. Testet ska också köras direkt i SQL, utan HTTP-lagret, så att det verkligen är constraintet som verifieras (ADR-0009).

## Alternativ som valdes bort

- **Rådgivande lås per personal (`pg_advisory_xact_lock`):** fungerar, men skyddar bara kod som kommer ihåg att ta låset.
- **Förgenererade tidsluckor med `UNIQUE (staff_id, slot)`:** klarar inte varierande längd och buffert utan att boka flera luckor per bokning, och strider mot beslutet att inte lagra luckor (ADR-0005).
- **Tillfälliga reservationer (hold) under kassaflödet:** behövs först när betalning införs. Det går att lägga till som `status = 'held'` med `expires_at` inom samma constraint.
