# ADR-0008: Egna sessioner i PostgreSQL, tre roller

- **Status:** Accepterad
- **Datum:** 2026-11-07

## Kontext

Personal och administratörer loggar in med lösenord. Kunder ska kunna boka utan att skapa konto, men ändå kunna se och avboka sina tider. Sessioner måste gå att återkalla direkt, till exempel när personal slutar eller vid misstänkt intrång.

## Beslut

**Sessioner på servern, inte JWT.** En token på 256 slumpade bitar skickas i cookien. I tabellen `session` lagras bara SHA-256 av token, så en databasdump innehåller inga användbara sessioner. Implementationen är ett litet eget lager enligt [The Copenhagen Book](https://thecopenhagenbook.com/), ungefär 150 rader med full testtäckning.

- **Cookie:** `__Host-erc_session`; `HttpOnly; Secure; SameSite=Lax; Path=/`. Prefixet `__Host-` tvingar fram `Secure`, ingen `Domain` och `Path=/`.
- **Livslängd:** glidande 30 dagar för kunder och 12 timmar för personal. Förnyas högst en gång per timme för att hålla nere antalet skrivningar. Ny session vid inloggning (skyddar mot session fixation), och alla sessioner återkallas vid lösenordsbyte.
- **CSRF:** `SameSite=Lax` och en kontroll av `Origin`-headern på alla anrop som ändrar data (allt utom GET, HEAD och OPTIONS). Det räcker när API och webb ligger på samma origin.
- **Lösenord:** argon2id via `@node-rs/argon2` med OWASP:s parametrar (m=19 MiB, t=2, p=1). Inloggning tar lika lång tid oavsett om e-postadressen finns, och har rate limiting per IP och per konto.

**Kunder:**

1. **Bokning utan konto:** bokningen görs med namn, e-post och telefon. Kunden kopplas till en befintlig `customer` via e-post (`citext`), men **befintliga kontaktuppgifter skrivs aldrig över** av en anonym bokning. Kontaktuppgifterna sparas på bokningen (`contact_name`, `contact_phone`). Annars skulle vem som helst kunna ändra en annan kunds telefonnummer genom att boka med dennes e-post.
2. **Hanteringslänk:** bekräftelsemejlet innehåller en token (sparad som hash i `booking_access_token`) som ger tillgång till just den bokningen: visa och avboka.
3. **Inloggning med e-postlänk** (Fas 3): en engångstoken som gäller i 15 minuter skapar en session med rollen `customer` och kopplar `customer.user_id`. Ger "mina bokningar". Kunder har inga lösenord.

**Roller och behörighet:**

| Resurs | Kund | Personal | Admin |
| --- | --- | --- | --- |
| Tjänster, lediga tider | läsa | läsa | läsa och skriva |
| Egna bokningar | läsa, skapa, avboka inom gränsen | – | – |
| Alla bokningar | – | läsa, skapa, ändra | läsa, skapa, ändra |
| Eget schema och egen frånvaro | – | läsa och skriva | läsa och skriva |
| Andras schema, personal, inställningar | – | läsa | läsa och skriva |
| Kunder | eget konto, export | läsa | läsa, skriva, anonymisera |

Behörighet kontrolleras i varje route med en deklarativ `preHandler` (`requireRole('staff', 'admin')`) och dessutom med kontroll av ägarskap i servicelagret (`booking.customer_id = actor.customerId`). En kund som ber om någon annans bokning får **404, inte 403**, så att det inte går att ta reda på vilka id:n som finns. Testerna i Fas 3 går igenom tabellen ovan systematiskt.

## Konsekvenser

- Varje autentiserat anrop gör en uppslagning på primärnyckeln. Det är försumbart i den här skalan.
- Lucia, som README:n tänkte sig, utvecklas inte längre (sedan 2025). Därför skrivs lagret självt i stället för att använda ett bibliotek. README:ns preliminära val ändras alltså här.

## Alternativ som valdes bort

- **JWT:** kan inte återkallas utan en spärrlista, och då är det en session ändå.
- **`@fastify/secure-session`** (krypterad cookie utan tillstånd på servern): kan inte återkallas.
- **Lösenord för kunder:** ger mer friktion och mer att skydda, utan att tillföra något jämfört med e-postlänk.
