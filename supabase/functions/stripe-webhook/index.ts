// Stripe → us webhook receiver. Fires when a customer completes (or fails)
// a checkout session. On success: marks the invoice paid + invokes the
// send-booking-email function in payment_received mode to email the receipt.
//
// Deploy: supabase functions deploy stripe-webhook --no-verify-jwt
//
// Required Supabase secrets:
//   STRIPE_SECRET_KEY        (sk_test_... or sk_live_...)
//   STRIPE_WEBHOOK_SECRET    (whsec_... — from the Stripe dashboard webhook config)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") || "";
const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") || "";

const stripe = STRIPE_SECRET_KEY
  ? new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-04-10", httpClient: Stripe.createFetchHttpClient() })
  : null;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);
  if (!stripe || !STRIPE_WEBHOOK_SECRET) {
    return jsonResponse({ error: "Stripe not configured (missing secret(s))" }, 503);
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return jsonResponse({ error: "missing stripe-signature header" }, 400);
  }

  const rawBody = await req.text();

  // Verify the signature using the async constructor (Deno needs the WebCrypto
  // backend; constructEventAsync handles that).
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      STRIPE_WEBHOOK_SECRET,
    );
  } catch (e) {
    console.error("stripe signature verification failed:", e);
    return jsonResponse({ error: "signature verification failed" }, 400);
  }

  // Only act on successful checkout completions. We intentionally ignore other
  // event types — Stripe sends many that aren't relevant to this flow.
  if (event.type !== "checkout.session.completed") {
    return jsonResponse({ ok: true, ignored: event.type });
  }

  const session = event.data.object as Stripe.Checkout.Session;
  if (session.payment_status !== "paid") {
    return jsonResponse({ ok: true, ignored: "not paid", payment_status: session.payment_status });
  }

  const invoiceId = (session.metadata?.invoice_id || "") as string;
  const bookingId = (session.metadata?.booking_id || "") as string;
  if (!invoiceId || !bookingId) {
    console.error("checkout session missing metadata:", session.id);
    return jsonResponse({ error: "missing invoice/booking metadata on session" }, 400);
  }

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Idempotency: if the invoice is already paid, skip the update + email so
  // Stripe retries don't double-email the customer.
  const { data: invRow } = await sb
    .from("invoices")
    .select("status")
    .eq("id", invoiceId)
    .maybeSingle();

  if (invRow?.status === "paid") {
    return jsonResponse({ ok: true, already_paid: true });
  }

  const { error: updErr } = await sb
    .from("invoices")
    .update({
      status: "paid",
      paid_at: new Date().toISOString(),
    })
    .eq("id", invoiceId);

  if (updErr) {
    console.error("invoice update failed:", updErr);
    return jsonResponse({ error: "invoice update failed", debug: updErr.message }, 500);
  }

  // Fire the customer's "Payment received" email with the PAID-stamped PDF.
  // Service-role auth on the internal send-booking-email call.
  try {
    const emailResp = await fetch(`${SUPABASE_URL}/functions/v1/send-booking-email`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
        "apikey": SERVICE_ROLE_KEY,
      },
      body: JSON.stringify({ booking_id: bookingId, mode: "payment_received" }),
    });
    if (!emailResp.ok) {
      const txt = await emailResp.text();
      console.warn("payment_received email returned non-ok:", emailResp.status, txt);
    }
  } catch (e) {
    console.warn("payment_received email failed:", e);
    // Don't fail the webhook — invoice is paid in DB, email failure is recoverable.
  }

  return jsonResponse({
    ok: true,
    invoice_id: invoiceId,
    booking_id: bookingId,
    stripe_session: session.id,
    stripe_payment_intent: session.payment_intent,
  });
});
