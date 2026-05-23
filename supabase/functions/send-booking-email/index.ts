// Supabase Edge Function: send-booking-email
// Sends a branded booking confirmation email via Gmail SMTP.
//
// Deploy:
//   supabase functions deploy send-booking-email --no-verify-jwt
//
// Required secrets (set with `supabase secrets set KEY=value`):
//   SMTP_HOST=smtp.gmail.com
//   SMTP_PORT=587
//   SMTP_USER=hirayaspaces@gmail.com
//   SMTP_PASS=<16-char-gmail-app-password>
//   SMTP_FROM=Hiraya Spaces <hirayaspaces@gmail.com>
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.

import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
};

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function dollars(cents: number | null | undefined): string {
  if (cents == null) return "Quote on request";
  return "$" + (Number(cents) / 100).toFixed(0);
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    const { booking_id } = await req.json();
    if (!booking_id || typeof booking_id !== "string") {
      return jsonResponse({ error: "booking_id required" }, 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    // Prefer the new SUPABASE_SECRET_KEYS (JSON array) when present —
    // projects on the new API key system have a legacy SERVICE_ROLE_KEY that
    // is silently revoked. Fall back to legacy if SECRET_KEYS unavailable.
    let serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const secretKeysRaw = Deno.env.get("SUPABASE_SECRET_KEYS");
    if (secretKeysRaw) {
      try {
        const parsed = JSON.parse(secretKeysRaw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const first = parsed[0];
          serviceKey = typeof first === "string" ? first : (first?.key || first?.value || serviceKey);
        } else if (typeof parsed === "string") {
          serviceKey = parsed;
        }
      } catch (_) {
        // Not JSON — maybe a single key string
        serviceKey = secretKeysRaw;
      }
    }
    const sb = createClient(supabaseUrl, serviceKey);

    // Fetch booking with joined service, addons, address, profile
    const { data: booking, error } = await sb
      .from("bookings")
      .select(`
        *,
        services ( name, slug, starting_price_cents ),
        booking_addons ( quantity, price_cents, addons ( name, slug ) ),
        addresses ( street_address, unit, city, province, postal_code ),
        profiles ( full_name, phone )
      `)
      .eq("id", booking_id)
      .single();

    if (error || !booking) {
      console.error("booking fetch failed for id=" + booking_id, error);
      return jsonResponse({ error: "Booking not found", debug: error?.message || error?.code || "no row" }, 404);
    }

    // Anti-abuse: only send for bookings created in the last 10 minutes.
    const ageMs = Date.now() - new Date(booking.created_at).getTime();
    if (ageMs > 10 * 60 * 1000) {
      return jsonResponse({ error: "Booking too old to email" }, 410);
    }

    // Look up the customer's email from auth.users (not exposed in profiles)
    const { data: userResult, error: userErr } = await sb.auth.admin.getUserById(booking.user_id);
    if (userErr || !userResult?.user?.email) {
      console.error("user fetch failed:", userErr);
      return jsonResponse({ error: "User email not found" }, 404);
    }
    const customerEmail = userResult.user.email;
    const customerName = booking.profiles?.full_name || userResult.user.user_metadata?.full_name || "there";

    const idShort = String(booking.id).slice(0, 8).toUpperCase();
    const serviceName = booking.services?.name || "Cleaning service";
    const dateDisplay = booking.preferred_date
      ? new Date(booking.preferred_date).toLocaleDateString("en-CA", { month: "long", day: "numeric", year: "numeric" })
      : "TBD";
    const timeDisplay = booking.preferred_time_slot || "";

    const addressLine = booking.addresses
      ? [booking.addresses.unit, booking.addresses.street_address, booking.addresses.city, booking.addresses.province, booking.addresses.postal_code]
          .filter(Boolean).join(", ")
      : (booking.customer_notes || "—");

    const bookingAddons = Array.isArray(booking.booking_addons) ? booking.booking_addons : [];
    const addonsHtml = bookingAddons.length
      ? `<ul style="margin:8px 0 0;padding-left:20px;color:#1a2e1e">${bookingAddons.map((ba: any) => {
          const name = ba.addons?.name || ba.addon_id;
          const qty = ba.quantity > 1 ? ` × ${ba.quantity}` : "";
          const price = ba.price_cents ? ` — ${dollars(ba.price_cents * (ba.quantity || 1))}` : "";
          return `<li style="margin-bottom:4px">${escapeHtml(name)}${qty}${price}</li>`;
        }).join("")}</ul>`
      : `<div style="color:#6a7d6e;font-style:italic;margin-top:6px">No add-ons</div>`;

    const totalDisplay = dollars(booking.estimated_price_cents);
    const isQuote = booking.estimated_price_cents == null || booking.status === "awaiting_quote";

    const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f8faf8;font-family:'Helvetica Neue',Arial,sans-serif;color:#1a2e1e">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f8faf8;padding:40px 16px">
    <tr><td align="center">
      <table cellpadding="0" cellspacing="0" border="0" width="520" style="max-width:520px;background:white;border-radius:16px;overflow:hidden;border:1px solid #d4e2d8">
        <tr><td style="background:#1e4d2b;padding:28px 30px;text-align:center;color:white">
          <div style="font-family:Georgia,'Cinzel',serif;font-size:22px;letter-spacing:3px;text-transform:uppercase">HIRAYA SPACES</div>
          <div style="font-size:10px;letter-spacing:2px;opacity:0.75;margin-top:6px">RESIDENTIAL CLEANING · WATERLOO REGION</div>
        </td></tr>
        <tr><td style="padding:36px 30px 20px">
          <h1 style="font-family:Georgia,'Cormorant Garamond',serif;font-weight:400;font-size:28px;margin:0 0 10px;color:#1a2e1e">${isQuote ? "Quote request received" : "You're booked!"}</h1>
          <p style="font-size:14px;color:#6a7d6e;line-height:1.7;margin:0 0 24px">
            Thanks, <strong style="color:#1a2e1e">${escapeHtml(customerName)}</strong> — we've received your request. Booking reference <strong style="color:#1e4d2b">${idShort}</strong>. ${isQuote ? "We'll be in touch with a tailored quote shortly." : "We'll be in touch shortly to confirm timing."}
          </p>

          <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#e4f0e9;border:1px solid #5a9470;border-radius:12px;margin-bottom:24px">
            <tr><td style="padding:20px 22px">
              <div style="font-size:11px;font-weight:600;color:#1e4d2b;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:14px">Booking summary</div>

              <table cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:14px;color:#1a2e1e">
                <tr><td style="padding:5px 0;color:#6a7d6e">Service</td><td style="padding:5px 0;text-align:right;font-weight:600">${escapeHtml(serviceName)}</td></tr>
                <tr><td style="padding:5px 0;color:#6a7d6e">Date</td><td style="padding:5px 0;text-align:right;font-weight:600">${escapeHtml(dateDisplay)}${timeDisplay ? " at " + escapeHtml(timeDisplay) : ""}</td></tr>
                <tr><td style="padding:5px 0;color:#6a7d6e">Address</td><td style="padding:5px 0;text-align:right">${escapeHtml(addressLine)}</td></tr>
              </table>

              <div style="margin-top:14px;padding-top:12px;border-top:1px solid #5a9470">
                <div style="font-size:13px;color:#6a7d6e;margin-bottom:4px">Add-ons</div>
                ${addonsHtml}
              </div>

              <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:16px;padding-top:14px;border-top:1px solid #5a9470">
                <tr>
                  <td style="font-size:16px;font-weight:700">${isQuote ? "Estimate" : "Estimated total"}</td>
                  <td style="font-size:18px;font-weight:700;color:#1e4d2b;text-align:right">${escapeHtml(totalDisplay)}</td>
                </tr>
              </table>
            </td></tr>
          </table>

          <p style="font-size:12px;color:#6a7d6e;line-height:1.7;margin:0 0 12px">
            Final pricing is confirmed after a quick walkthrough on the day of service. You can cancel free of charge up to 24 hours before. Questions? Just reply to this email.
          </p>
        </td></tr>
        <tr><td style="background:#f0f5f1;padding:18px 30px;text-align:center;font-size:11px;color:#6a7d6e;border-top:1px solid #d4e2d8">
          Hiraya Spaces · Waterloo, ON · <a href="https://hirayaspaces.ca" style="color:#1e4d2b;text-decoration:none">hirayaspaces.ca</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

    // Use SMTPS (direct TLS on 465) — STARTTLS on 587 is flaky inside the
    // Deno Edge runtime and tends to hang the function.
    const smtpPort = parseInt(Deno.env.get("SMTP_PORT") || "465");
    const useTls = smtpPort === 465;
    const client = new SMTPClient({
      connection: {
        hostname: Deno.env.get("SMTP_HOST") || "smtp.gmail.com",
        port: smtpPort,
        tls: useTls,
        auth: {
          username: Deno.env.get("SMTP_USER")!,
          password: Deno.env.get("SMTP_PASS")!,
        },
      },
    });

    await client.send({
      from: Deno.env.get("SMTP_FROM") || Deno.env.get("SMTP_USER")!,
      to: customerEmail,
      subject: `${isQuote ? "Quote request" : "Booking confirmed"} — ${idShort}`,
      html,
      content: `Hi ${customerName}, your Hiraya Spaces ${isQuote ? "quote request" : "booking"} (${idShort}) for ${serviceName} on ${dateDisplay}${timeDisplay ? " at " + timeDisplay : ""} has been received. ${isQuote ? "We'll send a tailored quote soon." : "Estimated total: " + totalDisplay + "."} Reply to this email with any questions.`,
    });

    await client.close();

    return jsonResponse({ ok: true, booking_id });
  } catch (err) {
    console.error("send-booking-email error:", err);
    return jsonResponse({ error: String((err as Error).message || err) }, 500);
  }
});
