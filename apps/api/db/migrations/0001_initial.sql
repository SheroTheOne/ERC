-- 0001: grundschema för ERC.
--
-- Motiveringar finns i docs/decisions/, se ADR-referenserna i kommentarerna.
-- Mål: PostgreSQL 18 (uuidv7(), multiranges, btree_gist).
-- Körs i en transaktion av migreringsverktyget (ADR-0006), därför SET LOCAL.

CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE SCHEMA erc;
SET LOCAL search_path = erc, public;

-- Range-typ för väggklocktider, används för att hindra överlappande arbetspass.
CREATE TYPE timerange AS RANGE (subtype = time);

-- STABLE och inte IMMUTABLE: tidszonsdatabasen kan uppdateras. Används bara i
-- CHECK på en tabell med en rad, där det inte spelar någon roll (ADR-0004).
CREATE FUNCTION is_valid_timezone(tz text) RETURNS boolean
LANGUAGE sql STABLE
SET search_path = erc, public, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = tz)
$$;

-- ---------------------------------------------------------------------------
-- Företaget (en installation = ett företag, ADR-0002)
-- ---------------------------------------------------------------------------

CREATE TABLE business (
  id                    boolean PRIMARY KEY DEFAULT true CHECK (id),
  name                  text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  timezone              text NOT NULL CHECK (is_valid_timezone(timezone)),
  slot_step_minutes     integer NOT NULL DEFAULT 15 CHECK (slot_step_minutes IN (5, 10, 15, 20, 30, 60)),
  min_notice_minutes    integer NOT NULL DEFAULT 60 CHECK (min_notice_minutes BETWEEN 0 AND 10080),
  booking_horizon_days  integer NOT NULL DEFAULT 60 CHECK (booking_horizon_days BETWEEN 1 AND 365),
  cancel_cutoff_minutes integer NOT NULL DEFAULT 120 CHECK (cancel_cutoff_minutes BETWEEN 0 AND 10080)
);

-- ---------------------------------------------------------------------------
-- Identitet och sessioner (ADR-0008)
-- ---------------------------------------------------------------------------

CREATE TABLE app_user (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  email         citext NOT NULL UNIQUE CHECK (char_length(email) <= 254),
  role          text NOT NULL CHECK (role IN ('customer', 'staff', 'admin')),
  -- argon2id i PHC-format. NULL för kunder, som loggar in med e-postlänk.
  password_hash text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  disabled_at   timestamptz,
  CHECK (role <> 'customer' OR password_hash IS NULL)
);

CREATE TABLE session (
  -- SHA-256 av den slumpade token som ligger i cookien. Själva token lagras aldrig.
  id_hash      bytea PRIMARY KEY CHECK (octet_length(id_hash) = 32),
  user_id      uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);
CREATE INDEX session_user_id_idx ON session (user_id);
CREATE INDEX session_expires_at_idx ON session (expires_at);

-- Engångslänk för inloggning via e-post (kunder).
CREATE TABLE login_token (
  token_hash  bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
  email       citext NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX login_token_email_idx ON login_token (email, created_at);

-- ---------------------------------------------------------------------------
-- Kunder, personal och tjänster
-- ---------------------------------------------------------------------------

CREATE TABLE customer (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  email         citext NOT NULL UNIQUE CHECK (char_length(email) <= 254),
  name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  phone         text CHECK (phone ~ '^\+[1-9][0-9]{6,14}$'), -- E.164
  -- Kopplas när kunden loggar in första gången med en e-postlänk.
  user_id       uuid UNIQUE REFERENCES app_user (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- GDPR-radering ersätter personuppgifter men behåller raden (ADR-0010).
  anonymized_at timestamptz
);

CREATE TABLE staff (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id      uuid NOT NULL UNIQUE REFERENCES app_user (id) ON DELETE RESTRICT,
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 100),
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE service (
  id                    uuid PRIMARY KEY DEFAULT uuidv7(),
  name                  text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  description           text CHECK (char_length(description) <= 2000),
  duration_minutes      integer NOT NULL CHECK (duration_minutes BETWEEN 5 AND 480),
  buffer_before_minutes integer NOT NULL DEFAULT 0 CHECK (buffer_before_minutes BETWEEN 0 AND 120),
  buffer_after_minutes  integer NOT NULL DEFAULT 0 CHECK (buffer_after_minutes BETWEEN 0 AND 120),
  price_ore             integer NOT NULL CHECK (price_ore >= 0),
  active                boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE staff_service (
  staff_id   uuid NOT NULL REFERENCES staff (id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES service (id) ON DELETE CASCADE,
  PRIMARY KEY (staff_id, service_id)
);

-- ---------------------------------------------------------------------------
-- Schema: arbetstider (väggklocka) och frånvaro (absolut tid), ADR-0004
-- ---------------------------------------------------------------------------

CREATE TABLE working_hours (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  staff_id    uuid NOT NULL REFERENCES staff (id) ON DELETE CASCADE,
  weekday     smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7), -- ISO 8601, 1 = måndag
  start_time  time NOT NULL,
  end_time    time NOT NULL, -- '24:00' betyder midnatt i slutet av dagen
  valid_from  date NOT NULL,
  valid_until date,          -- exklusiv, NULL = tills vidare
  CHECK (end_time > start_time),
  CHECK (valid_until IS NULL OR valid_until > valid_from),
  CONSTRAINT working_hours_no_overlap EXCLUDE USING gist (
    staff_id WITH =,
    weekday WITH =,
    daterange(valid_from, valid_until, '[)') WITH &&,
    timerange(start_time, end_time, '[)') WITH &&
  )
);

CREATE TABLE time_off (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  staff_id   uuid NOT NULL REFERENCES staff (id) ON DELETE CASCADE,
  period     tstzrange NOT NULL CHECK (
    NOT isempty(period) AND lower_inc(period) AND NOT upper_inc(period)
    AND NOT lower_inf(period) AND NOT upper_inf(period)
  ),
  reason     text CHECK (char_length(reason) <= 500),
  created_by uuid REFERENCES app_user (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX time_off_staff_period_idx ON time_off USING gist (staff_id, period);

-- ---------------------------------------------------------------------------
-- Bokningar (ADR-0003)
-- ---------------------------------------------------------------------------

CREATE TABLE booking (
  id                    uuid PRIMARY KEY DEFAULT uuidv7(),
  customer_id           uuid NOT NULL REFERENCES customer (id) ON DELETE RESTRICT,
  service_id            uuid NOT NULL REFERENCES service (id) ON DELETE RESTRICT,
  staff_id              uuid NOT NULL REFERENCES staff (id) ON DELETE RESTRICT,
  starts_at             timestamptz NOT NULL,
  ends_at               timestamptz NOT NULL,
  -- Ögonblicksbild av tjänsten vid bokningstillfället, så att ändringar av
  -- tjänsten inte skriver om historiken.
  buffer_before_minutes integer NOT NULL CHECK (buffer_before_minutes BETWEEN 0 AND 120),
  buffer_after_minutes  integer NOT NULL CHECK (buffer_after_minutes BETWEEN 0 AND 120),
  price_ore             integer NOT NULL CHECK (price_ore >= 0),
  contact_name          text NOT NULL CHECK (char_length(contact_name) BETWEEN 1 AND 200),
  contact_phone         text CHECK (contact_phone ~ '^\+[1-9][0-9]{6,14}$'),
  customer_note         text CHECK (char_length(customer_note) <= 500),
  -- Tiden personalen är upptagen, inklusive buffert. Sätts alltid av
  -- triggern booking_10_set_blocked och kan inte skrivas av klienten.
  -- Defaultvärdet finns bara för att genererade typer ska markera kolumnen
  -- som valfri vid INSERT; triggern skriver alltid över det.
  blocked               tstzrange NOT NULL DEFAULT 'empty',
  status                text NOT NULL DEFAULT 'confirmed'
                        CHECK (status IN ('confirmed', 'cancelled', 'completed', 'no_show')),
  cancelled_at          timestamptz,
  cancelled_by          uuid REFERENCES app_user (id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT booking_ends_after_starts CHECK (ends_at > starts_at),
  CONSTRAINT booking_cancellation_consistent CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CONSTRAINT booking_no_overlap EXCLUDE USING gist (
    staff_id WITH =,
    blocked WITH &&
  ) WHERE (status <> 'cancelled')
);
CREATE INDEX booking_customer_idx ON booking (customer_id, starts_at DESC);
CREATE INDEX booking_starts_at_idx ON booking (starts_at);

-- Kapabilitetslänk i bekräftelsemejlet: hantera en enda bokning utan konto.
CREATE TABLE booking_access_token (
  token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
  booking_id uuid NOT NULL REFERENCES booking (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX booking_access_token_booking_idx ON booking_access_token (booking_id);

-- Idempotens för POST /bookings (ADR-0003).
CREATE TABLE idempotency_key (
  key             uuid PRIMARY KEY,
  request_hash    bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  response_status smallint NOT NULL,
  response_body   jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idempotency_key_created_at_idx ON idempotency_key (created_at);

-- ---------------------------------------------------------------------------
-- Tillgänglighet i SQL (ADR-0005). Ger fria intervall, inte tidsluckor.
-- ---------------------------------------------------------------------------

-- Arbetstid inom p_window, omräknad från väggklocka till absolut tid för varje
-- lokal kalenderdag. Dagen före och efter tas med eftersom fönstret anges i
-- absolut tid och kan skära lokala dygnsgränser.
CREATE FUNCTION staff_working_periods(p_staff_id uuid, p_window tstzrange)
RETURNS tstzmultirange
LANGUAGE sql STABLE
SET search_path = erc, public, pg_temp
AS $$
  SELECT coalesce(range_agg(r), '{}'::tstzmultirange)
  FROM (
    SELECT tstzrange(
             (d + wh.start_time) AT TIME ZONE b.timezone,
             (d + wh.end_time) AT TIME ZONE b.timezone,
             '[)'
           ) * p_window AS r
    FROM business b
    CROSS JOIN LATERAL generate_series(
      ((lower(p_window) AT TIME ZONE b.timezone)::date - 1)::timestamp,
      ((upper(p_window) AT TIME ZONE b.timezone)::date + 1)::timestamp,
      interval '1 day'
    ) AS g(day_ts)
    CROSS JOIN LATERAL (SELECT day_ts::date AS d) AS day
    JOIN working_hours wh
      ON wh.staff_id = p_staff_id
     AND wh.weekday = extract(isodow FROM d)
     AND d >= wh.valid_from
     AND (wh.valid_until IS NULL OR d < wh.valid_until)
  ) AS s
  WHERE NOT isempty(r)
$$;

-- Arbetstid minus frånvaro: när personen över huvud taget kan ta emot bokningar.
CREATE FUNCTION staff_open_periods(p_staff_id uuid, p_window tstzrange)
RETURNS tstzmultirange
LANGUAGE sql STABLE
SET search_path = erc, public, pg_temp
AS $$
  SELECT staff_working_periods(p_staff_id, p_window)
       - coalesce(
           (SELECT range_agg(t.period) FROM time_off t
             WHERE t.staff_id = p_staff_id AND t.period && p_window),
           '{}'::tstzmultirange)
$$;

-- Öppen tid minus befintliga bokningar (inklusive buffert).
CREATE FUNCTION staff_free_periods(p_staff_id uuid, p_window tstzrange)
RETURNS tstzmultirange
LANGUAGE sql STABLE
SET search_path = erc, public, pg_temp
AS $$
  SELECT staff_open_periods(p_staff_id, p_window)
       - coalesce(
           (SELECT range_agg(bk.blocked) FROM booking bk
             WHERE bk.staff_id = p_staff_id AND bk.status <> 'cancelled'
               AND bk.blocked && p_window),
           '{}'::tstzmultirange)
$$;

-- ---------------------------------------------------------------------------
-- Integritetstriggers för bokningar (ADR-0002, ADR-0003)
-- ---------------------------------------------------------------------------

CREATE FUNCTION booking_set_blocked() RETURNS trigger
LANGUAGE plpgsql
SET search_path = erc, public, pg_temp
AS $$
BEGIN
  NEW.blocked := tstzrange(
    NEW.starts_at - make_interval(mins => NEW.buffer_before_minutes),
    NEW.ends_at + make_interval(mins => NEW.buffer_after_minutes),
    '[)'
  );
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- PostgreSQL kör BEFORE-triggers för samma händelse i bokstavsordning efter
-- namn. Numreringen gör ordningen explicit: blocked måste vara satt innan
-- invarianterna kontrolleras.
CREATE TRIGGER booking_10_set_blocked
BEFORE INSERT OR UPDATE ON booking
FOR EACH ROW EXECUTE FUNCTION booking_set_blocked();

-- Invarianter som kontrolleras när en aktiv bokning skapas eller flyttas.
-- Krockar med andra bokningar hanteras av booking_no_overlap, inte här.
-- Senare schemaändringar (frånvaro, nya arbetstider) underkänner inte
-- befintliga bokningar; de visas som konflikter för personalen (ADR-0002).
CREATE FUNCTION booking_check_invariants() RETURNS trigger
LANGUAGE plpgsql
SET search_path = erc, public, pg_temp
AS $$
BEGIN
  IF NEW.status = 'cancelled' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.status <> 'cancelled'
     AND NEW.staff_id = OLD.staff_id
     AND NEW.service_id = OLD.service_id
     AND NEW.blocked = OLD.blocked THEN
    RETURN NEW; -- statusbyte eller annan ändring som inte flyttar bokningen
  END IF;

  IF NOT EXISTS (SELECT 1 FROM staff s WHERE s.id = NEW.staff_id AND s.active) THEN
    RAISE EXCEPTION 'staff % is not active', NEW.staff_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'booking_staff_active';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM staff_service ss
                  WHERE ss.staff_id = NEW.staff_id AND ss.service_id = NEW.service_id) THEN
    RAISE EXCEPTION 'staff % does not perform service %', NEW.staff_id, NEW.service_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'booking_staff_performs_service';
  END IF;

  IF NOT (NEW.blocked <@ staff_open_periods(NEW.staff_id, NEW.blocked)) THEN
    RAISE EXCEPTION 'booking % is outside the open hours of staff %', NEW.blocked, NEW.staff_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'booking_within_open_hours';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER booking_20_check_invariants
BEFORE INSERT OR UPDATE ON booking
FOR EACH ROW EXECUTE FUNCTION booking_check_invariants();
