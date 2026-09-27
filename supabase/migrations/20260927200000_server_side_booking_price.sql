-- ============================================================================
-- Hiraya Spaces — the database prices every booking
-- 2026-09-27
--
-- RUN THIS IN THE SUPABASE SQL EDITOR WITH **Role: postgres**.
-- Idempotent: safe to re-run.
--
-- Run it only once the website version that books through create_booking()
-- has been live for ~10 minutes (browser caches). That version falls back to
-- the old save until this runs, so the order is: website first, then this.
--
-- Fixes:
--   1. Admin-created bookings carry the travel fee, and the recurring "next
--      visit" copy keeps it (and now also charges the extra services it copies).
--   2. The recurring discount comes off the cleaning only — never travel.
--   3. Customers book through create_booking(), which works the price out
--      from the catalog, and can no longer insert booking rows directly.
--
-- The script ends with a self-test. If any check fails, it raises an error
-- and — because the SQL editor runs the whole script as one transaction —
-- NOTHING in this file is applied. Test bookings are always rolled back.
-- ============================================================================


-- 1. Travel zones -------------------------------------------------------------
-- Same table as TRAVEL_ZONES in index.html and admin.js. Returns null for an
-- unknown zone so callers can refuse rather than guess at someone's money.
create or replace function public.travel_fee_cents_for_zone(p_zone text)
returns int
language sql
immutable
as $$
  select case lower(btrim(coalesce(p_zone, '')))
    when 'waterloo'  then 0
    when 'kitchener' then 0
    when 'cambridge' then 2500
    when 'guelph'    then 5000
    when 'other'     then 5000
  end
$$;


-- 2. Cadence discount -----------------------------------------------------------
-- Same rule the site has always used: measure the gap from the customer's most
-- recent COMPLETED visit to this booking's date.
--   <=  8 days -> 20%   <= 15 days -> 15%   <= 30 days -> 10%   beyond -> 0%
-- First-time customers always pay full price.
create or replace function public.cadence_discount_pct(p_user_id uuid, p_date date)
returns int
language sql
stable
set search_path = public
as $$
  select case
    when last_visit is null or p_date is null or p_date - last_visit <= 0 then 0
    when p_date - last_visit <= 8  then 20
    when p_date - last_visit <= 15 then 15
    when p_date - last_visit <= 30 then 10
    else 0
  end
  from (
    select max(preferred_date) as last_visit
    from public.bookings
    where user_id = p_user_id and status = 'completed'
  ) v
$$;
-- Internal helper: it reveals another customer's visit history.
revoke execute on function public.cadence_discount_pct(uuid, date) from public, anon, authenticated;


-- 3. create_booking — the only way a customer books --------------------------
-- The browser says WHAT is booked (service slugs, add-on slugs + quantities,
-- travel zone, date, address). Every price comes from the services / addons
-- tables and the travel zone table above.
--
-- p_services: [{"slug": "regular-2br", "tier_name": "2 BR / 2 BA"},
--              {"slug": "sofa"}]                      first one is the primary
--             [{"slug": "hourly-flexible", "hours": 4}]   hourly books alone
-- p_addons:   [{"slug": "inside-oven", "qty": 2}]
-- p_address:  {"street_address": "...", "unit": "...", "city": "...",
--              "postal_code": "..."}                   when not using a saved one
drop function if exists public.create_booking(jsonb, jsonb, text, date, text, uuid, jsonb, boolean, text, text, text, text);

create function public.create_booking(
  p_services jsonb,
  p_addons jsonb default '[]'::jsonb,
  p_travel_zone text default null,
  p_preferred_date date default null,
  p_preferred_time_slot text default null,
  p_address_id uuid default null,
  p_address jsonb default null,
  p_save_address boolean default true,
  p_frequency text default 'one_time',
  p_entry_method text default 'home',
  p_entry_instructions text default null,
  p_customer_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  hourly_rate_cents constant int := 4000;   -- HOURLY_RATE in index.html
  today date := (now() at time zone 'America/Toronto')::date;
  slot text := btrim(coalesce(p_preferred_time_slot, ''));
  line jsonb;
  item jsonb;
  svc record;
  ad record;
  n int := 0;
  hours int;
  qty int;
  line_cents int;
  primary_service_id int;
  needs_quote boolean := false;
  cleaning_cents int := 0;
  travel_cents int;
  discount_pct int;
  total_cents int;
  extras jsonb := '[]'::jsonb;
  addon_rows jsonb := '[]'::jsonb;
  addr_id uuid;
  street text;
  notes text := nullif(btrim(coalesce(p_customer_notes, '')), '');
  new_status text;
  new_id uuid;
begin
  if uid is null then
    raise exception 'Please sign in to book.';
  end if;

  -- When ---------------------------------------------------------------------
  if p_preferred_date is null or slot = '' then
    raise exception 'Please pick a date and time on the calendar.';
  end if;
  if p_preferred_date < today then
    raise exception 'That date has already passed. Please pick another.';
  end if;
  if exists (select 1 from public.blocked_dates where "date" = p_preferred_date) then
    raise exception 'We are not taking bookings that day. Please pick another.';
  end if;
  if exists (
    select 1 from public.bookings
    where preferred_date = p_preferred_date
      and preferred_time_slot = slot
      and status in ('pending_review', 'awaiting_quote', 'confirmed', 'in_progress')
  ) then
    raise exception 'Sorry, that time was just booked. Please pick another.';
  end if;
  if coalesce(p_frequency, 'one_time') not in ('one_time', 'weekly', 'biweekly', 'monthly') then
    raise exception 'Unknown frequency: %', p_frequency;
  end if;

  -- What: services -------------------------------------------------------------
  if p_services is null or jsonb_typeof(p_services) <> 'array' or jsonb_array_length(p_services) = 0 then
    raise exception 'Please choose a service before booking.';
  end if;
  if jsonb_array_length(p_services) > 10 then
    raise exception 'Too many services on one booking.';
  end if;

  for line in select value from jsonb_array_elements(p_services) loop
    n := n + 1;
    select id, slug, name, starting_price_cents, requires_quote, duration_minutes
      into svc
      from public.services
      where slug = line->>'slug' and is_active;
    if not found then
      raise exception 'Unknown service: %', coalesce(line->>'slug', '(none)');
    end if;

    if svc.slug = 'hourly-flexible' then
      if jsonb_array_length(p_services) > 1 then
        raise exception 'Flexible hourly cleaning is booked on its own.';
      end if;
      hours := (line->>'hours')::int;
      if hours is null or hours < 3 or hours > 8 then
        raise exception 'Flexible cleaning is 3 to 8 hours.';
      end if;
      line_cents := hours * hourly_rate_cents;
    elsif svc.requires_quote or svc.starting_price_cents is null then
      needs_quote := true;
      line_cents := null;
    else
      line_cents := svc.starting_price_cents;
    end if;
    cleaning_cents := cleaning_cents + coalesce(line_cents, 0);

    if n = 1 then
      primary_service_id := svc.id;
    else
      extras := extras || jsonb_build_object(
        'service_id', svc.id,
        'tier_slug', svc.slug,
        -- Display text only; the price never comes from the browser.
        'tier_name', coalesce(nullif(left(btrim(coalesce(line->>'tier_name', '')), 80), ''), svc.name),
        'price_cents', line_cents,
        'duration_minutes', svc.duration_minutes
      );
    end if;
  end loop;

  -- What: add-ons -----------------------------------------------------------------
  if p_addons is not null and jsonb_typeof(p_addons) = 'array' then
    if jsonb_array_length(p_addons) > 20 then
      raise exception 'Too many add-ons on one booking.';
    end if;
    for item in select value from jsonb_array_elements(p_addons) loop
      select id, price_cents into ad
        from public.addons
        where slug = item->>'slug' and is_active;
      if not found then
        raise exception 'Unknown add-on: %', coalesce(item->>'slug', '(none)');
      end if;
      qty := coalesce((item->>'qty')::int, 1);
      if qty < 1 or qty > 30 then
        raise exception 'Add-on quantity must be between 1 and 30.';
      end if;
      cleaning_cents := cleaning_cents + coalesce(ad.price_cents, 0) * qty;
      addon_rows := addon_rows || jsonb_build_object(
        'addon_id', ad.id, 'quantity', qty, 'price_cents', ad.price_cents
      );
    end loop;
  end if;

  -- Travel, discount, total -------------------------------------------------------
  travel_cents := public.travel_fee_cents_for_zone(p_travel_zone);
  if travel_cents is null then
    raise exception 'Please choose your city so we can include any travel fee.';
  end if;

  discount_pct := public.cadence_discount_pct(uid, p_preferred_date);

  -- The recurring discount comes off the cleaning only. Travel is added after,
  -- at full price, and stored in its own column so every screen can show it.
  if needs_quote then
    total_cents := null;
    new_status := 'awaiting_quote';
  else
    total_cents := round(cleaning_cents * (100 - discount_pct) / 100.0)::int + travel_cents;
    new_status := 'pending_review';
  end if;

  -- Where ---------------------------------------------------------------------------
  if p_address_id is not null then
    if not exists (select 1 from public.addresses where id = p_address_id and user_id = uid) then
      raise exception 'That saved address was not found on your account.';
    end if;
    addr_id := p_address_id;
  elsif p_address is not null and jsonb_typeof(p_address) = 'object' then
    street := btrim(coalesce(p_address->>'street_address', ''));
    if street = '' or btrim(coalesce(p_address->>'city', '')) = '' then
      raise exception 'Please fill in street, city, and postal code.';
    end if;
    if p_save_address then
      insert into public.addresses (user_id, label, street_address, unit, city, province, postal_code)
      values (
        uid,
        concat_ws(', ', street, nullif(btrim(coalesce(p_address->>'unit', '')), '')),
        street,
        nullif(btrim(coalesce(p_address->>'unit', '')), ''),
        btrim(p_address->>'city'),
        'ON',
        nullif(btrim(coalesce(p_address->>'postal_code', '')), '')
      )
      returning id into addr_id;
    else
      -- Not saved to the account, but the cleaner still needs to know where
      -- to go. The emails already fall back to customer_notes for this.
      notes := concat_ws(E'\n',
        'Address: ' || concat_ws(', ', street,
          nullif(btrim(coalesce(p_address->>'unit', '')), ''),
          btrim(p_address->>'city'),
          nullif(btrim(coalesce(p_address->>'postal_code', '')), '')),
        notes);
    end if;
  else
    raise exception 'Please add the address for this clean.';
  end if;

  -- Save ----------------------------------------------------------------------------
  insert into public.bookings (
    user_id, service_id, address_id,
    preferred_date, preferred_time_slot,
    estimated_price_cents, travel_fee_cents, status,
    customer_notes,
    entry_method, entry_instructions,
    frequency, recurring_discount_pct
  ) values (
    uid, primary_service_id, addr_id,
    p_preferred_date, slot,
    total_cents, travel_cents, new_status,
    notes,
    coalesce(nullif(btrim(coalesce(p_entry_method, '')), ''), 'home'),
    nullif(btrim(coalesce(p_entry_instructions, '')), ''),
    coalesce(p_frequency, 'one_time'), discount_pct
  )
  returning id into new_id;

  insert into public.booking_addons (booking_id, addon_id, quantity, price_cents)
  select new_id, (a->>'addon_id')::int, (a->>'quantity')::int, (a->>'price_cents')::int
  from jsonb_array_elements(addon_rows) a;

  insert into public.booking_services
    (booking_id, service_id, tier_slug, tier_name, price_cents, duration_minutes, quantity)
  select new_id, (e->>'service_id')::int, e->>'tier_slug', e->>'tier_name',
         (e->>'price_cents')::int, (e->>'duration_minutes')::int, 1
  from jsonb_array_elements(extras) e;

  return jsonb_build_object(
    'id', new_id,
    'status', new_status,
    'estimated_price_cents', total_cents,
    'travel_fee_cents', travel_cents,
    'recurring_discount_pct', discount_pct
  );
end;
$$;

revoke execute on function public.create_booking(jsonb, jsonb, text, date, text, uuid, jsonb, boolean, text, text, text, text) from public, anon;
grant execute on function public.create_booking(jsonb, jsonb, text, date, text, uuid, jsonb, boolean, text, text, text, text) to authenticated;



-- 4. Admin bookings carry the travel fee --------------------------------------
-- Same as the live version (read 2026-09-27) plus p_travel_fee_cents. The
-- owner is trusted with the amount: the admin form sets it from the address's
-- travel zone, and it may be waived. p_estimated_price_cents already includes
-- it. The new parameter has a default, so older admin pages keep working.
drop function if exists public.admin_create_booking(uuid, text, uuid, date, text, int, text, text, text, text, text, text, int);
drop function if exists public.admin_create_booking(uuid, text, uuid, date, text, int, text, text, text, text, text, text, int, int);

create function public.admin_create_booking(
  p_user_id uuid,
  p_service_slug text,
  p_address_id uuid,
  p_preferred_date date,
  p_preferred_time_slot text,
  p_estimated_price_cents int,
  p_customer_notes text default null,
  p_internal_notes text default null,
  p_status text default 'confirmed',
  p_entry_method text default null,
  p_entry_instructions text default null,
  p_frequency text default 'one_time',
  p_recurring_discount_pct int default 0,
  p_travel_fee_cents int default 0
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_id uuid;
  svc_id int;
begin
  if not public.is_owner() then raise exception 'forbidden'; end if;
  if p_status not in ('pending_review','awaiting_quote','confirmed','in_progress','completed') then
    raise exception 'invalid status: %', p_status;
  end if;
  if coalesce(p_travel_fee_cents, 0) < 0 then
    raise exception 'Travel fee cannot be negative.';
  end if;
  select id into svc_id from public.services where slug = p_service_slug;
  if svc_id is null then raise exception 'unknown service slug: %', p_service_slug; end if;
  if p_preferred_date is not null and p_preferred_time_slot is not null and exists (
    select 1 from public.bookings
    where preferred_date = p_preferred_date
      and preferred_time_slot = p_preferred_time_slot
      and status in ('pending_review','awaiting_quote','confirmed','in_progress')
  ) then
    raise exception 'Time slot % on % is already booked. Pick a different time or cancel the existing booking first.',
      p_preferred_time_slot, p_preferred_date;
  end if;
  insert into public.bookings (
    user_id, service_id, address_id,
    preferred_date, preferred_time_slot,
    estimated_price_cents, travel_fee_cents, status,
    customer_notes, internal_notes,
    entry_method, entry_instructions,
    frequency, recurring_discount_pct,
    confirmed_at
  ) values (
    p_user_id, svc_id, p_address_id,
    p_preferred_date, p_preferred_time_slot,
    p_estimated_price_cents, coalesce(p_travel_fee_cents, 0), p_status,
    p_customer_notes, p_internal_notes,
    p_entry_method, p_entry_instructions,
    p_frequency, p_recurring_discount_pct,
    case when p_status = 'confirmed' then now() else null end
  ) returning id into new_id;
  return new_id;
end;
$$;

grant execute on function public.admin_create_booking(uuid, text, uuid, date, text, int, text, text, text, text, text, text, int, int) to authenticated;


-- 5. The recurring "next visit" copy -----------------------------------------------
-- Same as the live version except:
--   * the travel fee is copied, and added after the discount;
--   * the extra services it copies onto the next visit are now charged on it;
--   * hourly visits carry the source visit's cleaning price, since the catalog
--     row cannot know how many hours were booked.
create or replace function public.admin_create_next_recurring(p_booking_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  src record;
  next_date date;
  new_id uuid;
  interval_days int;
  declared_pct int;
  subtotal_cents int;
  new_price_cents int;
  svc_slug text;
  catalog_base int;
  addons_total int;
  extras_total int;
  travel_cents int;
begin
  if not public.is_owner() then raise exception 'forbidden'; end if;
  select * into src from public.bookings where id = p_booking_id;
  if src.id is null then return null; end if;
  if src.frequency is null or src.frequency = 'one_time' then return null; end if;

  interval_days := case src.frequency
    when 'weekly' then 7
    when 'biweekly' then 14
    when 'monthly' then 28
    else 0
  end;
  if interval_days = 0 then return null; end if;

  declared_pct := case src.frequency
    when 'weekly' then 20
    when 'biweekly' then 15
    when 'monthly' then 10
    else 0
  end;

  next_date := src.preferred_date + (interval_days || ' days')::interval;
  travel_cents := coalesce(src.travel_fee_cents, 0);

  -- Use the service catalog + the source's add-ons and extra services as the
  -- subtotal anchor. This avoids propagating bad historical data where
  -- src.estimated_price_cents and src.recurring_discount_pct disagree.
  if src.estimated_price_cents is null then
    new_price_cents := null;
  else
    select slug, starting_price_cents into svc_slug, catalog_base
      from public.services where id = src.service_id;
    select coalesce(sum(coalesce(price_cents, 0) * coalesce(quantity, 1)), 0)
      into addons_total
      from public.booking_addons where booking_id = src.id;
    select coalesce(sum(coalesce(price_cents, 0) * coalesce(quantity, 1)), 0)
      into extras_total
      from public.booking_services where booking_id = src.id;

    if svc_slug = 'hourly-flexible' and coalesce(src.recurring_discount_pct, 0) between 0 and 99 then
      subtotal_cents := round(
        (src.estimated_price_cents - travel_cents)::numeric
        / (1.0 - coalesce(src.recurring_discount_pct, 0)::numeric / 100.0));
    else
      subtotal_cents := coalesce(catalog_base, 0) + addons_total + extras_total;
    end if;
    -- The discount comes off the cleaning; travel is charged in full.
    new_price_cents := round(subtotal_cents::numeric * (1.0 - declared_pct::numeric / 100.0)) + travel_cents;
  end if;

  insert into public.bookings (
    user_id, service_id, address_id,
    preferred_date, preferred_time_slot,
    estimated_price_cents, travel_fee_cents, status,
    customer_notes, internal_notes,
    entry_method, entry_instructions,
    frequency, recurring_discount_pct,
    confirmed_at
  ) values (
    src.user_id, src.service_id, src.address_id,
    next_date, src.preferred_time_slot,
    new_price_cents, travel_cents, 'confirmed',
    src.customer_notes, src.internal_notes,
    src.entry_method, src.entry_instructions,
    src.frequency, declared_pct,
    now()
  )
  returning id into new_id;

  insert into public.booking_addons (booking_id, addon_id, quantity, price_cents)
  select new_id, addon_id, quantity, price_cents
  from public.booking_addons where booking_id = src.id;

  insert into public.booking_services (booking_id, service_id, tier_slug, tier_name, price_cents, duration_minutes, quantity)
  select new_id, service_id, tier_slug, tier_name, price_cents, duration_minutes, quantity
  from public.booking_services where booking_id = src.id;

  return new_id;
end;
$$;


-- 6. Customers can no longer write booking rows directly ---------------------------
-- create_booking() is their only way in. Owners are unaffected: the admin
-- screens write through SECURITY DEFINER functions.
drop policy if exists "users create own bookings" on public.bookings;
drop policy if exists "users insert own booking addons" on public.booking_addons;
drop policy if exists "users insert own booking services" on public.booking_services;

-- Sanity limits on the money columns. NOT VALID: enforced for every new or
-- changed row, without re-checking history.
alter table public.bookings drop constraint if exists bookings_money_sane;
alter table public.bookings add constraint bookings_money_sane check (
  coalesce(estimated_price_cents, 0) >= 0
  and coalesce(final_price_cents, 0) >= 0
  and coalesce(travel_fee_cents, 0) >= 0
  and coalesce(recurring_discount_pct, 0) between 0 and 100
) not valid;


-- 7. Self-test -------------------------------------------------------------------------
-- Books as the owner account on dates 400+ days out, checks every price, then
-- rolls all of it back. Any failure aborts the whole script.
do $selftest$
declare
  me uuid;
  d date := (now() at time zone 'America/Toronto')::date + 400;
  r jsonb;
  bid uuid;
  nid uuid;
  cnt int;
  v int;
  b record;
  fails text[] := '{}';
  test_detail text;
  addr jsonb := '{"street_address": "1 Test St", "city": "Guelph", "postal_code": "N1H 1A1"}';
begin
  -- The owner account: whichever user is_owner() accepts.
  for me in select u.id from auth.users u join public.profiles p on p.id = u.id loop
    perform set_config('request.jwt.claims', json_build_object('sub', me, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', me::text, true);
    exit when public.is_owner();
  end loop;
  if me is null or not public.is_owner() then
    raise exception 'Self-test: no owner account found. Nothing was changed.';
  end if;

  begin
    perform set_config('request.jwt.claims', json_build_object('sub', me, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', me::text, true);

    -- A completed visit 7 days before d, so d earns the 20% weekly rate.
    insert into public.bookings (user_id, service_id, preferred_date, preferred_time_slot, estimated_price_cents, status)
    values (me, (select id from public.services where slug = 'regular-1br'), d - 7, '8:00 am', 12000, 'completed');

    -- 1. Guelph, two services + add-ons, 20% cadence discount, address not saved.
    --    Cleaning 180 + 65 + 2x35 + 10 = 325; less 20% = 260; + 50 travel = 310.
    r := public.create_booking(
      p_services => '[{"slug": "regular-2br", "tier_name": "2 BR / 2 BA"}, {"slug": "carpet-living-room", "tier_name": "Living room"}]',
      p_addons => '[{"slug": "inside-oven", "qty": 2}, {"slug": "eco-friendly", "qty": 1}]',
      p_travel_zone => 'guelph', p_preferred_date => d, p_preferred_time_slot => '9:30 am',
      p_address => addr, p_save_address => false, p_frequency => 'weekly');
    bid := (r->>'id')::uuid;
    if (r->>'estimated_price_cents')::int is distinct from 31000 then fails := fails || ('1 total=' || coalesce(r->>'estimated_price_cents', 'null')); end if;
    if (r->>'recurring_discount_pct')::int is distinct from 20 then fails := fails || ('1 pct=' || coalesce(r->>'recurring_discount_pct', 'null')); end if;
    select * into b from public.bookings where id = bid;
    if b.travel_fee_cents <> 5000 then fails := fails || ('1 travel=' || b.travel_fee_cents); end if;
    if b.status <> 'pending_review' then fails := fails || ('1 status=' || b.status); end if;
    if b.address_id is not null or coalesce(b.customer_notes, '') not like 'Address: 1 Test St, Guelph, N1H 1A1%' then
      fails := fails || ('1 address: ' || coalesce(b.customer_notes, 'none'));
    end if;
    select count(*), sum(price_cents * quantity) into cnt, v from public.booking_addons where booking_id = bid;
    if cnt <> 2 or v <> 8000 then fails := fails || ('1 addons=' || cnt || '/' || coalesce(v, 0)); end if;
    select count(*), max(price_cents) into cnt, v from public.booking_services where booking_id = bid;
    if cnt <> 1 or v <> 6500 then fails := fails || ('1 extras=' || cnt || '/' || coalesce(v, 0)); end if;

    -- 2. Hourly, 5 hours, Kitchener, address saved, no discount (67 days since last visit).
    r := public.create_booking(
      p_services => '[{"slug": "hourly-flexible", "hours": 5}]',
      p_travel_zone => 'kitchener', p_preferred_date => d + 60, p_preferred_time_slot => '8:00 am',
      p_address => '{"street_address": "2 Test St", "city": "Kitchener"}', p_save_address => true);
    if (r->>'estimated_price_cents')::int is distinct from 20000 then fails := fails || ('2 total=' || coalesce(r->>'estimated_price_cents', 'null')); end if;
    if (r->>'travel_fee_cents')::int is distinct from 0 then fails := fails || ('2 travel=' || (r->>'travel_fee_cents')); end if;
    select address_id into nid from public.bookings where id = (r->>'id')::uuid;
    if nid is null or not exists (select 1 from public.addresses where id = nid and user_id = me) then
      fails := fails || '2 address not saved'::text;
    end if;

    -- 3. Quote-only service: no price, awaiting quote, travel still recorded.
    r := public.create_booking(
      p_services => '[{"slug": "post-renovation"}]',
      p_travel_zone => 'cambridge', p_preferred_date => d + 61, p_preferred_time_slot => '8:00 am',
      p_address => addr, p_save_address => false);
    if r->>'estimated_price_cents' is not null or r->>'status' <> 'awaiting_quote' or (r->>'travel_fee_cents')::int <> 2500 then
      fails := fails || ('3 quote: ' || r::text);
    end if;

    -- 4. Refusals.
    begin
      perform public.create_booking(p_services => '[{"slug": "regular-1br"}]', p_travel_zone => 'mars',
        p_preferred_date => d + 62, p_preferred_time_slot => '8:00 am', p_address => addr, p_save_address => false);
      fails := fails || 'unknown zone accepted'::text;
    exception when others then null; end;
    begin
      perform public.create_booking(p_services => '[{"slug": "regular-1br"}]', p_travel_zone => 'waterloo',
        p_preferred_date => (now() at time zone 'America/Toronto')::date - 1, p_preferred_time_slot => '8:00 am',
        p_address => addr, p_save_address => false);
      fails := fails || 'past date accepted'::text;
    exception when others then null; end;
    begin
      perform public.create_booking(p_services => '[{"slug": "regular-1br"}]', p_addons => '[{"slug": "inside-oven", "qty": 50}]',
        p_travel_zone => 'waterloo', p_preferred_date => d + 63, p_preferred_time_slot => '8:00 am',
        p_address => addr, p_save_address => false);
      fails := fails || 'qty 50 accepted'::text;
    exception when others then null; end;
    begin
      perform public.create_booking(p_services => '[{"slug": "free-clean"}]', p_travel_zone => 'waterloo',
        p_preferred_date => d + 64, p_preferred_time_slot => '8:00 am', p_address => addr, p_save_address => false);
      fails := fails || 'unknown service accepted'::text;
    exception when others then null; end;
    begin
      perform public.create_booking(p_services => '[{"slug": "regular-1br"}]', p_travel_zone => 'waterloo',
        p_preferred_date => d, p_preferred_time_slot => '9:30 am', p_address => addr, p_save_address => false);
      fails := fails || 'double booking accepted'::text;
    exception when others then null; end;
    begin
      perform public.create_booking(p_services => '[{"slug": "regular-1br"}]', p_travel_zone => 'waterloo',
        p_preferred_date => d + 65, p_preferred_time_slot => '8:00 am',
        p_address_id => gen_random_uuid());
      fails := fails || 'someone else''s address accepted'::text;
    exception when others then null; end;

    -- 5. Admin: travel stored, and carried (undiscounted) to the next visit,
    --    along with the extra service. Next visit: (180 + 110) less 20% = 232, + 25 = 257.
    nid := public.admin_create_booking(
      p_user_id => me, p_service_slug => 'regular-2br', p_address_id => null,
      p_preferred_date => d + 70, p_preferred_time_slot => '8:00 am',
      p_estimated_price_cents => 20500, p_frequency => 'weekly', p_travel_fee_cents => 2500);
    select travel_fee_cents into v from public.bookings where id = nid;
    if v <> 2500 then fails := fails || ('5 admin travel=' || v); end if;
    insert into public.booking_services (booking_id, service_id, tier_slug, tier_name, price_cents, quantity)
    values (nid, (select id from public.services where slug = 'sofa'), 'sofa', 'Sofa', 11000, 1);
    bid := public.admin_create_next_recurring(nid);
    select * into b from public.bookings where id = bid;
    if b.estimated_price_cents is distinct from 25700 or b.travel_fee_cents <> 2500 or b.preferred_date <> d + 77 then
      fails := fails || ('5 next visit=' || coalesce(b.estimated_price_cents::text, 'null') || '/' || b.travel_fee_cents || '/' || b.preferred_date);
    end if;

    -- 6. Signed out: refused.
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', '', true);
    begin
      perform public.create_booking(p_services => '[{"slug": "regular-1br"}]', p_travel_zone => 'waterloo',
        p_preferred_date => d + 66, p_preferred_time_slot => '8:00 am', p_address => addr, p_save_address => false);
      fails := fails || 'signed-out booking accepted'::text;
    exception when others then null; end;

    -- 7. A signed-in customer inserting a booking row directly: refused.
    perform set_config('request.jwt.claims', json_build_object('sub', me, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', me::text, true);
    perform set_config('role', 'authenticated', true);
    begin
      insert into public.bookings (user_id, service_id, preferred_date, preferred_time_slot, estimated_price_cents)
      values (me, (select id from public.services where slug = 'regular-1br'), d + 80, '8:00 am', 1);
      fails := fails || 'direct insert allowed'::text;
    exception when insufficient_privilege then null; end;

    raise exception 'SELFTEST_ROLLBACK' using detail = array_to_string(fails, '; ');
  exception when others then
    if sqlerrm <> 'SELFTEST_ROLLBACK' then
      raise exception 'Self-test crashed: % (%). Nothing was changed.', sqlerrm, sqlstate;
    end if;
    get stacked diagnostics test_detail = pg_exception_detail;
    if coalesce(test_detail, '') <> '' then
      raise exception 'Self-test failed: %. Nothing was changed.', test_detail;
    end if;
  end;
  raise notice 'Self-test passed: all checks OK.';
end
$selftest$;


-- ============================================================================
-- If you see "Success. No rows returned", everything above is live.
-- If you see "Self-test failed" or "Self-test crashed", nothing was changed.
-- ============================================================================
