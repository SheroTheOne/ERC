# API-specifikation, första versionen

Det här är designutkastet. Från Fas 2 genereras `openapi.json` från route-schemana (ADR-0007) och blir det kontrakt som gäller.

## Konventioner

- Bas-URL: `/api/v1`. JSON i UTF-8. Fältnamn i camelCase.
- **Tid:** ISO 8601. Klienten får skicka valfri offset, servern svarar alltid i UTC (`2026-03-30T07:00:00Z`). Datumparametrar (`YYYY-MM-DD`) är lokala dagar i företagets tidszon (ADR-0004).
- **Pengar:** heltal i öre (`priceOre`).
- **Id:** UUID (v7).
- **Listor:** cursor-paginering, `?limit=50&cursor=…` → `{ items, nextCursor }`.
- **Auth:** cookie `__Host-erc_session`. Anrop som ändrar data kräver att `Origin` är lika med `PUBLIC_ORIGIN`.
- **Fel:** `application/problem+json` enligt RFC 9457, se [Fel](#fel).

Kolumnen "Roll" anger vem som får anropa: `publik`, `kund`, `token` (hanteringslänk), `personal` och `admin`. Admin får alltid det personal får.

## Publikt: tjänster och tillgänglighet

| Metod | Sökväg | Roll | Beskrivning |
| --- | --- | --- | --- |
| GET | `/business` | publik | Namn, tidszon, bokningspolicy |
| GET | `/services` | publik | Aktiva tjänster |
| GET | `/services/{id}/staff` | publik | Personal som utför tjänsten (`id`, `displayName`) |
| GET | `/availability` | publik | Lediga tider, se nedan |

### `GET /availability`

| Parameter | Krävs | |
| --- | --- | --- |
| `serviceId` | ja | |
| `from` | ja | Lokalt datum `YYYY-MM-DD` |
| `to` | ja | Lokalt datum, inklusive, högst 14 dagar efter `from` |
| `staffId` | nej | Utelämnas för "valfri personal" |

```json
{
  "timezone": "Europe/Stockholm",
  "serviceId": "0193…",
  "days": [
    {
      "date": "2026-03-30",
      "slots": [
        { "startsAt": "2026-03-30T07:00:00Z", "endsAt": "2026-03-30T08:00:00Z", "staffIds": ["0193…a1", "0193…a2"] }
      ]
    }
  ]
}
```

Tider räknas ut vid varje anrop och cachas inte (ADR-0005). Svaret har `Cache-Control: no-store`.

## Bokningar

| Metod | Sökväg | Roll | Beskrivning |
| --- | --- | --- | --- |
| POST | `/bookings` | publik, kund, personal | Skapa bokning. Kräver headern `Idempotency-Key` |
| GET | `/bookings/{id}` | kund (egen), token, personal | Visa bokning |
| POST | `/bookings/{id}/cancel` | kund (egen, före gränsen), token, personal | Avboka |
| PATCH | `/bookings/{id}` | personal | Flytta (tid, personal) eller ändra status (`completed`, `no_show`) |
| GET | `/bookings` | personal | Lista med filter `from`, `to`, `staffId`, `status` |
| GET | `/bookings/conflicts` | personal | Aktiva bokningar som ligger utanför nuvarande öppen tid (ADR-0002) |
| GET | `/me/bookings` | kund | Egna bokningar |

### `POST /bookings`

```http
POST /api/v1/bookings
Idempotency-Key: 6f1c2a1e-1d7b-4b8e-9a63-6a2b7f0f9c11
Content-Type: application/json

{
  "serviceId": "0193…",
  "staffId": "0193…a1",
  "startsAt": "2026-03-30T09:00:00+02:00",
  "contact": { "name": "Kim Svensson", "email": "kim@example.com", "phone": "+46701234567" },
  "note": "Allergisk mot parfym"
}
```

- `staffId` är valfritt. Utan det tilldelar servern personal (ADR-0003).
- `endsAt` räknas ut av servern från tjänstens längd. Klienten kan inte välja längd.
- Policy för kunder och anonyma anrop: `startsAt ≥ nu + minNotice` och `≤ nu + horizon`. Personal får gå förbi policyn men aldrig invarianterna.
- **201** + `Location` + bokningen. Den som bokar utan konto får hanteringslänken via e-post, aldrig i svaret.
- **409** `slot-unavailable` | `outside-open-hours`. **422** `validation-failed` | `idempotency-key-reused`.

### `POST /bookings/{id}/cancel`

Tokenbaserad åtkomst: `Authorization: Bearer <token från hanteringslänken>`. Om gränsen för avbokning har passerats svarar servern `409 cancellation-window-closed` (gäller inte personal). Att avboka en bokning som redan är avbokad ger 200 med samma innehåll, alltså idempotent.

## Personal och schema

| Metod | Sökväg | Roll | Beskrivning |
| --- | --- | --- | --- |
| GET | `/staff` | personal | Lista personal |
| POST, PATCH | `/staff`, `/staff/{id}` | admin | Skapa, ändra eller inaktivera |
| PUT | `/staff/{id}/services` | admin | Ange vilka tjänster personen utför |
| GET | `/staff/{id}/working-hours?at=YYYY-MM-DD` | personal | Regler som gäller ett visst datum |
| PUT | `/staff/{id}/working-hours` | personal (egen), admin | Ersätt veckoschemat från `validFrom`. Föregående regler avslutas där. |
| GET, POST | `/staff/{id}/time-off` | personal (egen), admin | `{ from, to }` som tidpunkter, eller `{ fromDate, toDate }` som lokala heldagar |
| DELETE | `/staff/{id}/time-off/{timeOffId}` | personal (egen), admin | |

Svaret på `POST /time-off` innehåller `conflicts[]`: aktiva bokningar som nu ligger utanför öppen tid.

## Tjänster, kunder och inställningar

| Metod | Sökväg | Roll |
| --- | --- | --- |
| POST, PATCH | `/services`, `/services/{id}` | admin |
| GET | `/customers`, `/customers/{id}` | personal |
| GET | `/customers/{id}/export` | admin |
| POST | `/customers/{id}/anonymize` | admin |
| PATCH | `/business` | admin |

## Autentisering

| Metod | Sökväg | Roll | Beskrivning |
| --- | --- | --- | --- |
| POST | `/auth/login` | publik | `{ email, password }` för personal och admin. Svarar 204 och sätter cookie. |
| POST | `/auth/magic-link` | publik | `{ email }`. Svarar alltid 202, oavsett om adressen finns. |
| POST | `/auth/magic-link/verify` | publik | `{ token }` → 204 och cookie |
| POST | `/auth/logout` | inloggad | 204 och rensad cookie |
| GET | `/me` | inloggad | `{ id, email, role, staffId?, customerId? }` |
| GET | `/me/export` | kund | Dataexport (ADR-0010) |

## Fel

Alla fel har `type`, `title`, `status`, `detail`, `instance` och `requestId`. `type` är stabil och klienter kan styra beteende på den.

| `type` (suffix) | Status | När |
| --- | --- | --- |
| `validation-failed` | 400 | Schemavalidering. Innehåller `errors: [{ path, message }]` |
| `unauthenticated` | 401 | Ingen eller ogiltig session |
| `forbidden` | 403 | Inloggad, men fel roll för endpointen |
| `not-found` | 404 | Finns inte, eller tillhör någon annan (kund) |
| `slot-unavailable` | 409 | `booking_no_overlap` |
| `outside-open-hours` | 409 | `booking_within_open_hours`, eller policyn för framförhållning eller bokningshorisont |
| `staff-inactive` | 409 | `booking_staff_active` |
| `cancellation-window-closed` | 409 | Kunden försöker avboka för sent |
| `schedule-overlap` | 409 | `working_hours_no_overlap` |
| `staff-does-not-perform-service` | 422 | `booking_staff_performs_service` |
| `idempotency-key-reused` | 422 | Samma nyckel med annat innehåll |
| `idempotency-key-required` | 428 | Headern saknas på `POST /bookings` |
| `payload-too-large` | 413 | Förfrågan överskrider storleksgränsen |
| `unsupported-media-type` | 415 | Annan `Content-Type` än `application/json` |
| `rate-limited` | 429 | Innehåller `Retry-After` |
| `internal` | 500 | Aldrig intern information i `detail` |
| `service-unavailable` | 503 | Databasen går inte att nå |
