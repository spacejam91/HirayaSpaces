-- Protect a manually adjusted invoice total from being overwritten.
--
-- send-booking-email re-syncs an unpaid invoice's total from the booking price
-- every time it runs, so an owner's override was silently reverted the next
-- time anyone resent the invoice. This flag tells that sync to leave the
-- invoice alone.

alter table public.invoices
  add column if not exists manually_adjusted boolean not null default false;

comment on column public.invoices.manually_adjusted is
  'True when an owner set the total by hand. send-booking-email must not re-sync it from the booking price.';

-- Set the flag whenever the total is adjusted by hand.
create or replace function public.admin_adjust_invoice_total(
  p_invoice_id uuid,
  p_total_cents int,
  p_tax_cents int default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  affected int;
  v_tax int;
begin
  if not public.is_owner() then raise exception 'forbidden'; end if;

  if p_total_cents is null or p_total_cents < 0 then
    raise exception 'total must be zero or more';
  end if;

  if p_total_cents > 10000000 then
    raise exception 'total looks wrong (over $100,000) — check the amount';
  end if;

  select coalesce(p_tax_cents, tax_cents, 0) into v_tax
  from public.invoices where id = p_invoice_id;

  if v_tax > p_total_cents then
    raise exception 'tax cannot exceed the total';
  end if;

  update public.invoices
  set total_cents       = p_total_cents,
      tax_cents         = v_tax,
      amount_cents      = p_total_cents - v_tax,
      manually_adjusted = true
  where id = p_invoice_id;

  get diagnostics affected = row_count;
  return affected > 0;
end;
$$;

grant execute on function public.admin_adjust_invoice_total(uuid, int, int) to authenticated;

-- Return the flag so the admin UI can show that a total was set by hand.
drop function if exists public.admin_get_invoice_for_booking(uuid);

create function public.admin_get_invoice_for_booking(p_booking_id uuid)
returns table (
  id uuid,
  invoice_number text,
  amount_cents int,
  total_cents int,
  tax_cents int,
  status text,
  paid_at timestamptz,
  created_at timestamptz,
  manually_adjusted boolean
)
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  if not public.is_owner() then raise exception 'forbidden'; end if;
  return query
    select i.id, i.invoice_number, i.amount_cents, i.total_cents,
           i.tax_cents, i.status::text, i.paid_at, i.created_at,
           i.manually_adjusted
    from public.invoices i
    where i.booking_id = p_booking_id
    order by i.created_at desc
    limit 1;
end;
$$;

grant execute on function public.admin_get_invoice_for_booking(uuid) to authenticated;
