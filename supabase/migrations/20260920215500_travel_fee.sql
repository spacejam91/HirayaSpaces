-- ============================================================================
-- Hiraya Spaces — out-of-region travel fee
-- 2026-09-20
--
-- RUN THIS IN THE SUPABASE SQL EDITOR WITH **Role: postgres**.
-- The editor defaults to `authenticated`, which silently denies DDL with a
-- confusing "permission denied for schema public" error.
--
-- Idempotent: safe to re-run.
--
-- Zones (the website enforces the same table):
--   Waterloo, Kitchener ....  $0
--   Cambridge ..............  $25
--   Guelph / elsewhere .....  $50
--
-- Why a column and not just a bigger total: the account and admin screens
-- derive the service price as (estimated_price_cents - sum of add-ons). If the
-- travel fee were folded into the total, every booking would display the
-- SERVICE as $25-50 more than it actually is. Storing it separately keeps that
-- arithmetic honest.
-- ============================================================================


-- 1. The column ------------------------------------------------------------
alter table public.bookings
  add column if not exists travel_fee_cents int not null default 0;

comment on column public.bookings.travel_fee_cents is
  'Out-of-region travel fee in cents, charged per visit. 0 = Waterloo/Kitchener.';

-- Existing bookings all predate the fee, so 0 is correct for them.

-- 2. get_pending_bookings --------------------------------------------------
-- A function whose RETURNS TABLE shape changes cannot be CREATE OR REPLACE'd,
-- so it has to be dropped first.
drop function if exists public.get_pending_bookings();

create function public.get_pending_bookings()
returns table (
  id uuid,
  user_id uuid,
  service_name text,
  preferred_date date,
  preferred_time_slot text,
  estimated_price_cents int,
  travel_fee_cents int,
  status text,
  customer_notes text,
  created_at timestamptz,
  customer_name text,
  customer_email text,
  customer_phone text,
  street_address text,
  unit text,
  city text,
  postal_code text,
  entry_method text,
  entry_instructions text,
  frequency text,
  recurring_discount_pct int
)
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  if not public.is_owner() then raise exception 'forbidden'; end if;
  return query
    select
      b.id, b.user_id,
      s.name::text,
      b.preferred_date, b.preferred_time_slot,
      b.estimated_price_cents,
      b.travel_fee_cents,
      b.status::text,
      b.customer_notes, b.created_at,
      p.full_name::text,
      u.email::text,
      p.phone::text,
      a.street_address::text, a.unit::text, a.city::text, a.postal_code::text,
      b.entry_method, b.entry_instructions,
      b.frequency, b.recurring_discount_pct
    from public.bookings b
    left join public.services s on s.id = b.service_id
    left join public.profiles p on p.id = b.user_id
    left join auth.users u on u.id = b.user_id
    left join public.addresses a on a.id = b.address_id
    where b.status in ('pending_review', 'awaiting_quote')
    order by b.preferred_date asc nulls last, b.created_at asc;
end;
$$;

grant execute on function public.get_pending_bookings() to authenticated;

-- 3. get_all_bookings ------------------------------------------------------
drop function if exists public.get_all_bookings();

create function public.get_all_bookings()
returns table (
  id uuid,
  user_id uuid,
  service_name text,
  preferred_date date,
  preferred_time_slot text,
  estimated_price_cents int,
  final_price_cents int,
  travel_fee_cents int,
  status text,
  customer_notes text,
  internal_notes text,
  created_at timestamptz,
  customer_name text,
  customer_email text,
  customer_phone text,
  street_address text,
  unit text,
  city text,
  postal_code text,
  entry_method text,
  entry_instructions text,
  frequency text,
  recurring_discount_pct int,
  check_in_at timestamptz,
  check_out_at timestamptz
)
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  if not public.is_owner() then raise exception 'forbidden'; end if;
  return query
    select
      b.id, b.user_id,
      s.name::text,
      b.preferred_date, b.preferred_time_slot,
      b.estimated_price_cents,
      b.final_price_cents,
      b.travel_fee_cents,
      b.status::text,
      b.customer_notes,
      b.internal_notes,
      b.created_at,
      p.full_name::text,
      u.email::text,
      p.phone::text,
      a.street_address::text, a.unit::text, a.city::text, a.postal_code::text,
      b.entry_method, b.entry_instructions,
      b.frequency, b.recurring_discount_pct,
      b.check_in_at, b.check_out_at
    from public.bookings b
    left join public.services s on s.id = b.service_id
    left join public.profiles p on p.id = b.user_id
    left join auth.users u on u.id = b.user_id
    left join public.addresses a on a.id = b.address_id
    order by b.preferred_date desc nulls last, b.created_at desc;
end;
$$;

grant execute on function public.get_all_bookings() to authenticated;


-- ============================================================================
-- Check it worked:
--
--   select column_name, data_type, column_default
--   from information_schema.columns
--   where table_schema = 'public'
--     and table_name  = 'bookings'
--     and column_name = 'travel_fee_cents';
--
--   select * from public.get_pending_bookings() limit 1;
--
-- The second one should run without error and include a travel_fee_cents
-- column. If it raises 'forbidden', you are not signed in as an owner email —
-- that is expected in the SQL editor and does not mean the function is broken.
-- ============================================================================
