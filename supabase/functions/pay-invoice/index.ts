// Customer-facing entry point for online payment. The customer clicks "Pay"
// in their invoice email → this function looks up the invoice → creates a
// Stripe Checkout Session for the right amount → 302 redirects to Stripe's
// hosted checkout. Public-facing (no JWT), authentication is implicit via
// the invoice number (which is in the email only the customer received).
//
// Deploy: supabase functions deploy pay-invoice --no-verify-jwt
//
// Required Supabase secrets:
//   STRIPE_SECRET_KEY  (sk_test_... or sk_live_...)
//   PUBLIC_SITE_URL    (e.g. https://hirayaspaces.ca) — used for success/cancel URLs

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") || "";
const PUBLIC_SITE_URL = Deno.env.get("PUBLIC_SITE_URL") || "https://hirayaspaces.ca";

const stripe = STRIPE_SECRET_KEY
  ? new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-04-10", httpClient: Stripe.createFetchHttpClient() })
  : null;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
};

function errorPage(title: string, body: string, status = 400): Response {
  return new Response(`<!DOCTYPE html><html><body style="font-family:Helvetica,Arial,sans-serif;background:#f8faf8;color:#1a2e1e;padding:60px 24px;text-align:center">
  <h1 style="font-family:Georgia,serif;font-weight:400;color:#1e4d2b">${title}</h1>
  <p style="color:#6a7d6e;max-width:480px;margin:16px auto">${body}</p>
  <p style="margin-top:24px"><a href="https://hirayaspaces.ca" style="color:#1e4d2b;font-weight:600">← Back to Hiraya Spaces</a></p>
  </body></html>`, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...CORS },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  if (!stripe) {
    return errorPage("Payments not yet enabled", "Online payment isn't configured yet — please pay by e-transfer (see your invoice email for instructions) or reach out to Hiraya at (226) 751-4566.", 503);
  }

  const url = new URL(req.url);
  // Accept invoice number from ?n= or ?invoice_number= (alias for clarity).
  const invoiceNumber = url.searchParams.get("n") || url.searchParams.get("invoice_number");
  if (!invoiceNumber) {
    return errorPage("Invoice not specified", "This payment link is missing the invoice number. If you got here from an email, the link may have been truncated — try copy-pasting the full URL.", 400);
  }

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Look up the invoice + the booking it's attached to (for customer email
  // and service description).
  const { data: invoice, error: invErr } = await sb
    .from("invoices")
    .select("id, invoice_number, status, total_cents, booking_id, user_id")
    .eq("invoice_number", invoiceNumber)
    .maybeSingle();

  if (invErr || !invoice) {
    return errorPage("Invoice not found", "We couldn't find an invoice with that number. Double-check the link from your email, or call Hiraya at (226) 751-4566.", 404);
  }

  if (invoice.status === "paid") {
    return errorPage("Already paid", `Invoice ${invoiceNumber} has already been paid. Thank you! If you got here by mistake, no action is needed.`, 200);
  }
  if (invoice.status === "cancelled" || invoice.status === "refunded") {
    return errorPage("Invoice unavailable", `Invoice ${invoiceNumber} is ${invoice.status} and can't be paid online. If this is a mistake, reach out to Hiraya at (226) 751-4566.`, 400);
  }

  // Look up the customer email via auth.users.
  const { data: userResult } = await sb.auth.admin.getUserById(invoice.user_id);
  const customerEmail = userResult?.user?.email || undefined;

  // Fetch a friendly service name for the line description.
  const { data: booking } = await sb
    .from("bookings")
    .select("id, services(name)")
    .eq("id", invoice.booking_id)
    .maybeSingle();
  const serviceName = (booking?.services as { name?: string } | null)?.name || "Cleaning service";

  // Build the Stripe Checkout Session. amount_total is in cents.
  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [{
        price_data: {
          currency: "cad",
          product_data: {
            name: `Hiraya Spaces — ${serviceName}`,
            description: `Invoice ${invoiceNumber}`,
          },
          unit_amount: invoice.total_cents,
        },
        quantity: 1,
      }],
      customer_email: customerEmail,
      success_url: `${PUBLIC_SITE_URL}/?paid=${encodeURIComponent(invoiceNumber)}`,
      cancel_url: `${PUBLIC_SITE_URL}/?paycancel=${encodeURIComponent(invoiceNumber)}`,
      // The webhook handler reads this back to know which invoice to mark paid.
      metadata: {
        invoice_id: invoice.id,
        invoice_number: invoiceNumber,
        booking_id: invoice.booking_id,
      },
    });
  } catch (e) {
    console.error("stripe checkout create failed:", e);
    return errorPage("Payment setup failed", "We hit a snag creating your payment session. Please try again or contact Hiraya at (226) 751-4566.", 502);
  }

  if (!session.url) {
    return errorPage("Payment setup failed", "Stripe didn't return a checkout URL. Please contact Hiraya at (226) 751-4566.", 502);
  }

  // 302 redirect to Stripe's hosted checkout.
  return new Response(null, {
    status: 303,
    headers: {
      Location: session.url,
      ...CORS,
    },
  });
});
