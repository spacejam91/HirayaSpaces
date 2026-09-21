-- Adjust the total on an invoice that already exists.
--
-- Until now the price could only be changed BEFORE the invoice was raised
-- (complete-amount on Mark complete, or edit-price on Edit booking). Once the
-- invoice existed it was read-only, so a goodwill discount or a correction
-- meant cancelling and re-issuing. This lets an owner set the total in place.
--
-- Deliberately narrow: it writes the money columns and nothing else. Status,
-- invoice number, and paid_at are left alone — a paid invoice keeps its
-- paid_at, and changing an amount is not the same as changing whether it was
-- paid. Owner-only, same as every other admin_ function here.

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

  -- Guard against a fat-fingered extra zero. $100k is far beyond any
  -- residential clean, so treat it as a typo rather than accept it silently.
  if p_total_cents > 10000000 then
    raise exception 'total looks wrong (over $100,000) — check the amount';
  end if;

  -- Keep the existing tax when the caller does not pass one.
  select coalesce(p_tax_cents, tax_cents, 0) into v_tax
  from public.invoices where id = p_invoice_id;

  if v_tax > p_total_cents then
    raise exception 'tax cannot exceed the total';
  end if;

  update public.invoices
  set total_cents  = p_total_cents,
      tax_cents    = v_tax,
      amount_cents = p_total_cents - v_tax
  where id = p_invoice_id;

  get diagnostics affected = row_count;
  return affected > 0;
end;
$$;

grant execute on function public.admin_adjust_invoice_total(uuid, int, int) to authenticated;
