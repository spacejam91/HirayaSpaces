-- ============================================================================
-- Hiraya Spaces — bookings block the calendar for as long as they really take
-- 2026-09-27
--
-- RUN THIS IN THE SUPABASE SQL EDITOR WITH **Role: postgres**.
-- Idempotent: safe to re-run. Needs 20260927200000 to have run first.
-- Safe with the website as it is now; the matching admin code ships after.
--
-- Before this, the calendar treated every booking as the length of its main
-- service from the catalog. The hourly catalog row says 3 hours, so a 6-hour
-- clean at 8:00 left 11:00 open for someone else; extra services on a visit
-- (Regular + Sofa) were not counted either.
--
--   * bookings.duration_minutes records hours booked for flexible hourly
--     cleans (null = use the catalog), backfilled for existing ones.
--   * A booking's length = that (or the catalog) + its extra services.
--   * get_booked_slots() reports that length, so the calendar greys out
--     every overlapping start time.
--   * create_booking() refuses any overlap, not just the exact same slot.
--
-- Ends with a self-test; any failure aborts the whole script unchanged.
-- ============================================================================


-- 1. The column ------------------------------------------------------------------
alter table public.bookings add column if not exists duration_minutes int;
comment on column public.bookings.duration_minutes is
  'Length of the main service in minutes when the catalog cannot know it (flexible hourly: hours x 60). Null = use services.duration_minutes.';

alter table public.bookings drop constraint if exists bookings_duration_sane;
alter table public.bookings add constraint bookings_duration_sane
  check (duration_minutes is null or duration_minutes between 15 and 720) not valid;


-- 2. Helpers ------------------------------------------------------------------------
-- '8:00 am' -> 480, '1:00 pm' -> 780, '12:30 pm' -> 750. Null if unparseable.
create or replace function public.slot_start_minutes(p_slot text)
returns int
language sql
immutable
as $$
  select case when btrim(coalesce(p_slot, '')) ~* '^[0-9]{1,2}:[0-9]{2} ?(am|pm)$' then
    (split_part(btrim(p_slot), ':', 1)::int % 12
      + case when lower(btrim(p_slot)) like '%pm' then 12 else 0 end) * 60
    + substring(btrim(p_slot) from ':([0-9]{2})')::int
  end
$$;

-- How long a booking takes: its own recorded length, else the catalog's, else
-- 3 hours — plus every extra service on the visit.
create or replace function public.booking_duration_minutes(p_booking_id uuid)
returns int
language sql
stable
set search_path = public
as $$
  select coalesce(b.duration_minutes, s.duration_minutes, 180)
       + coalesce((
           select sum(coalesce(bs.duration_minutes, s2.duration_minutes, 0) * coalesce(bs.quantity, 1))::int
           from public.booking_services bs
           left join public.services s2 on s2.id = bs.service_id
           where bs.booking_id = b.id
         ), 0)
  from public.bookings b
  left join public.services s on s.id = b.service_id
  where b.id = p_booking_id
$$;
revoke execute on function public.booking_duration_minutes(uuid) from public, anon, authenticated;


-- 3. Backfill hourly bookings ---------------------------------------------------------
-- Hours worked back from the saved price at $40/hr, 3 to 8. Old admin bookings
-- priced at $50/hr come out an hour long at most, which only over-blocks.
update public.bookings b
set duration_minutes = 60 * greatest(3, least(8, round(
      ( (b.estimated_price_cents - coalesce(b.travel_fee_cents, 0))::numeric
          / (1 - coalesce(b.recurring_discount_pct, 0) / 100.0)
        - coalesce((select sum(coalesce(ba.price_cents, 0) * coalesce(ba.quantity, 1))
                    from public.booking_addons ba where ba.booking_id = b.id), 0)
        - coalesce((select sum(coalesce(bs.price_cents, 0) * coalesce(bs.quantity, 1))
                    from public.booking_services bs where bs.booking_id = b.id), 0)
      ) / 4000.0)::int))
from public.services s
where s.id = b.service_id
  and s.slug = 'hourly-flexible'
  and b.duration_minutes is null
  and b.estimated_price_cents is not null
  and coalesce(b.recurring_discount_pct, 0) between 0 and 99;


-- 4. The calendar's view of the day ----------------------------------------------------
create or replace function public.get_booked_slots(target_date date)
returns table (preferred_time_slot text, duration_minutes integer)
language sql
stable
security definer
set search_path = public
as $$
  select b.preferred_time_slot, public.booking_duration_minutes(b.id)
  from public.bookings b
  where b.preferred_date = target_date
    and b.status not in ('cancelled', 'no_show')
    and b.preferred_time_slot is not null;
$$;


-- 5. create_booking records hourly length and refuses overlaps ---------------------------
create or replace function public.create_booking(
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
  line_minutes int;
  visit_minutes int := 0;
  hourly_minutes int;
  start_min int;
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
      line_minutes := hours * 60;
      hourly_minutes := line_minutes;
    elsif svc.requires_quote or svc.starting_price_cents is null then
      needs_quote := true;
      line_cents := null;
      line_minutes := svc.duration_minutes;
    else
      line_cents := svc.starting_price_cents;
      line_minutes := svc.duration_minutes;
    end if;
    cleaning_cents := cleaning_cents + coalesce(line_cents, 0);
    visit_minutes := visit_minutes + coalesce(line_minutes, 0);

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

  -- The whole visit must fit: refuse if it overlaps any active booking that
  -- day, using each booking's real length (hours booked, plus extra services).
  start_min := public.slot_start_minutes(slot);
  if exists (
    select 1 from public.bookings ob
    where ob.preferred_date = p_preferred_date
      and ob.status in ('pending_review', 'awaiting_quote', 'confirmed', 'in_progress')
      and (
        ob.preferred_time_slot = slot
        or (start_min is not null
            and public.slot_start_minutes(ob.preferred_time_slot) is not null
            and start_min < public.slot_start_minutes(ob.preferred_time_slot) + public.booking_duration_minutes(ob.id)
            and public.slot_start_minutes(ob.preferred_time_slot) < start_min + case when visit_minutes > 0 then visit_minutes else 180 end)
      )
  ) then
    raise exception 'Sorry, that time overlaps another booking. Please pick another.';
  end if;

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
    duration_minutes,
    customer_notes,
    entry_method, entry_instructions,
    frequency, recurring_discount_pct
  ) values (
    uid, primary_service_id, addr_id,
    p_preferred_date, slot,
    total_cents, travel_cents, new_status,
    hourly_minutes,
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





-- 6. Admin bookings record hourly length ------------------------------------------------
drop function if exists public.admin_create_booking(uuid, text, uuid, date, text, int, text, text, text, text, text, text, int, int);
drop function if exists public.admin_create_booking(uuid, text, uuid, date, text, int, text, text, text, text, text, text, int, int, int);

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
  p_travel_fee_cents int default 0,
  p_duration_minutes int default null
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
  if p_duration_minutes is not null and (p_duration_minutes < 15 or p_duration_minutes > 720) then
    raise exception 'Duration must be between 15 minutes and 12 hours.';
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
    duration_minutes,
    customer_notes, internal_notes,
    entry_method, entry_instructions,
    frequency, recurring_discount_pct,
    confirmed_at
  ) values (
    p_user_id, svc_id, p_address_id,
    p_preferred_date, p_preferred_time_slot,
    p_estimated_price_cents, coalesce(p_travel_fee_cents, 0), p_status,
    p_duration_minutes,
    p_customer_notes, p_internal_notes,
    p_entry_method, p_entry_instructions,
    p_frequency, p_recurring_discount_pct,
    case when p_status = 'confirmed' then now() else null end
  ) returning id into new_id;
  return new_id;
end;
$$;

grant execute on function public.admin_create_booking(uuid, text, uuid, date, text, int, text, text, text, text, text, text, int, int, int) to authenticated;



-- Owner-only: set or clear a booking's recorded length (the edit screen's
-- hours field). Null = use the catalog.
create or replace function public.admin_set_booking_duration(p_booking_id uuid, p_duration_minutes int)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  affected int;
begin
  if not public.is_owner() then raise exception 'forbidden'; end if;
  if p_duration_minutes is not null and (p_duration_minutes < 15 or p_duration_minutes > 720) then
    raise exception 'Duration must be between 15 minutes and 12 hours.';
  end if;
  update public.bookings
  set duration_minutes = p_duration_minutes, updated_at = now()
  where id = p_booking_id;
  get diagnostics affected = row_count;
  return affected > 0;
end;
$$;
grant execute on function public.admin_set_booking_duration(uuid, int) to authenticated;


-- 7. The next-visit copy keeps the length --------------------------------------------------
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
    duration_minutes,
    customer_notes, internal_notes,
    entry_method, entry_instructions,
    frequency, recurring_discount_pct,
    confirmed_at
  ) values (
    src.user_id, src.service_id, src.address_id,
    next_date, src.preferred_time_slot,
    new_price_cents, travel_cents, 'confirmed',
    src.duration_minutes,
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



-- 8. Self-test -----------------------------------------------------------------------------
do $selftest$
declare
  me uuid;
  d date := (now() at time zone 'America/Toronto')::date + 420;
  r jsonb;
  nid uuid;
  bid uuid;
  v int;
  fails text[] := '{}';
  test_detail text;
  addr jsonb := '{"street_address": "1 Test St", "city": "Kitchener", "postal_code": "N2G 1A1"}';
begin
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

    -- Slot parsing.
    if public.slot_start_minutes('8:00 am') is distinct from 480
       or public.slot_start_minutes('1:00 pm') is distinct from 780
       or public.slot_start_minutes('12:30 pm') is distinct from 750
       or public.slot_start_minutes('12:00 am') is distinct from 0
       or public.slot_start_minutes('soon') is not null then
      fails := fails || 'slot parsing'::text;
    end if;

    -- 1. A 6-hour clean at 8:00 records 360 minutes, and the calendar sees 360.
    r := public.create_booking(p_services => '[{"slug": "hourly-flexible", "hours": 6}]',
      p_travel_zone => 'kitchener', p_preferred_date => d, p_preferred_time_slot => '8:00 am',
      p_address => addr, p_save_address => false);
    select duration_minutes into v from public.bookings where id = (r->>'id')::uuid;
    if v is distinct from 360 then fails := fails || ('1 stored=' || coalesce(v::text, 'null')); end if;
    select g.duration_minutes into v from public.get_booked_slots(d) g where g.preferred_time_slot = '8:00 am';
    if v is distinct from 360 then fails := fails || ('1 calendar=' || coalesce(v::text, 'null')); end if;

    -- 2. 11:00 overlaps it (8:00 + 6h = 2:00 pm) and is refused; 2:30 pm is fine.
    begin
      perform public.create_booking(p_services => '[{"slug": "regular-1br"}]', p_travel_zone => 'waterloo',
        p_preferred_date => d, p_preferred_time_slot => '11:00 am', p_address => addr, p_save_address => false);
      fails := fails || '2 overlap at 11:00 accepted'::text;
    exception when others then null; end;
    begin
      perform public.create_booking(p_services => '[{"slug": "regular-1br"}]', p_travel_zone => 'waterloo',
        p_preferred_date => d, p_preferred_time_slot => '2:30 pm', p_address => addr, p_save_address => false);
    exception when others then fails := fails || ('2 2:30 pm refused: ' || sqlerrm); end;

    -- 3. Regular 2BR (4h) + sofa (1h) at 8:00 blocks 5 hours: 11:00 refused, 1:00 pm fine.
    r := public.create_booking(p_services => '[{"slug": "regular-2br"}, {"slug": "sofa"}]',
      p_travel_zone => 'waterloo', p_preferred_date => d + 1, p_preferred_time_slot => '8:00 am',
      p_address => addr, p_save_address => false);
    v := public.booking_duration_minutes((r->>'id')::uuid);
    if v is distinct from 300 then fails := fails || ('3 length=' || coalesce(v::text, 'null')); end if;
    begin
      perform public.create_booking(p_services => '[{"slug": "regular-1br"}]', p_travel_zone => 'waterloo',
        p_preferred_date => d + 1, p_preferred_time_slot => '11:00 am', p_address => addr, p_save_address => false);
      fails := fails || '3 overlap at 11:00 accepted'::text;
    exception when others then null; end;
    begin
      perform public.create_booking(p_services => '[{"slug": "regular-1br"}]', p_travel_zone => 'waterloo',
        p_preferred_date => d + 1, p_preferred_time_slot => '1:00 pm', p_address => addr, p_save_address => false);
    exception when others then fails := fails || ('3 1:00 pm refused: ' || sqlerrm); end;

    -- 4. A fixed-price booking records no length of its own (the catalog's is used).
    select duration_minutes into v from public.bookings where id = (r->>'id')::uuid;
    if v is not null then fails := fails || ('4 fixed stored=' || v); end if;

    -- 5. Admin: hourly length stored, editable, and copied to the next visit.
    nid := public.admin_create_booking(
      p_user_id => me, p_service_slug => 'hourly-flexible', p_address_id => null,
      p_preferred_date => d + 10, p_preferred_time_slot => '8:00 am',
      p_estimated_price_cents => 20000, p_frequency => 'weekly', p_duration_minutes => 300);
    select duration_minutes into v from public.bookings where id = nid;
    if v is distinct from 300 then fails := fails || ('5 admin stored=' || coalesce(v::text, 'null')); end if;
    perform public.admin_set_booking_duration(nid, 420);
    select duration_minutes into v from public.bookings where id = nid;
    if v is distinct from 420 then fails := fails || ('5 edited=' || coalesce(v::text, 'null')); end if;
    bid := public.admin_create_next_recurring(nid);
    select duration_minutes into v from public.bookings where id = bid;
    if v is distinct from 420 then fails := fails || ('5 next visit=' || coalesce(v::text, 'null')); end if;

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
