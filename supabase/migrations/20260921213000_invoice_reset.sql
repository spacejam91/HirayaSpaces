-- Undo a manual invoice override.
--
-- admin_adjust_invoice_total always sets manually_adjusted, and nothing could
-- clear it. So a mistyped override was permanent: typing the old number back
-- restored the amount but left the invoice flagged, which permanently stops
-- send-booking-email re-syncing it from the booking price.
--
-- This puts the invoice back to the booking's own price and clears the flag,
-- so the invoice resumes tracking the booking.

create or replace function public.admin_reset_invoice_to_calculated(
  p_invoice_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  affected int;
  v_booking uuid;
  v_calc int;
  v_tax int;
begin
  if not public.is_owner() then raise exception 'forbidden'; end if;

  select i.booking_id, coalesce(i.tax_cents, 0)
    into v_booking, v_tax
  from public.invoices i
  where i.id = p_invoice_id;

  if v_booking is null then
    return false;
  end if;

  -- The booking's own price is the source of truth: the charged amount once
  -- the clean is complete, otherwise the estimate.
  select coalesce(b.final_price_cents, b.estimated_price_cents, 0)
    into v_calc
  from public.bookings b
  where b.id = v_booking;

  if v_calc is null or v_calc < 0 then
    raise exception 'booking has no usable price to reset to';
  end if;

  if v_tax > v_calc then
    v_tax := 0;   -- a stale tax larger than the recomputed total is meaningless
  end if;

  update public.invoices
  set total_cents       = v_calc,
      tax_cents         = v_tax,
      amount_cents      = v_calc - v_tax,
      manually_adjusted = false
  where id = p_invoice_id;

  get diagnostics affected = row_count;
  return affected > 0;
end;
$$;

grant execute on function public.admin_reset_invoice_to_calculated(uuid) to authenticated;
