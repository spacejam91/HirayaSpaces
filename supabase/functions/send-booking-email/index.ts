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
  // supabase-js sends x-client-info on every request — without it in the
  // allow-list the browser preflight fails and invoke() can't reach the function.
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
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

// Strip trailing whitespace from every line of the HTML body. denomailer
// 1.6.0 double-encodes trailing spaces (=20 in QP becomes =3D20 → decoded
// as the literal text "=20" by Gmail), so we don't give it any to chew on.
function tidyHtml(s: string): string {
  return s.split("\n").map(l => l.replace(/[\t ]+$/, "")).join("\n");
}

// ── GOOGLE CALENDAR HELPERS ──────────────────────────────────────────────
async function getGoogleAccessToken(clientId: string, clientSecret: string, refreshToken: string): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    throw new Error(`google token refresh failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.access_token;
}

function parseSlotTo24h(slot: string): { hour: number; minute: number } | null {
  const m = slot.match(/^(\d+):(\d+)\s*(am|pm)$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ampm = m[3].toLowerCase();
  if (ampm === "pm" && h < 12) h += 12;
  if (ampm === "am" && h === 12) h = 0;
  return { hour: h, minute: min };
}

function buildEventDescription(parts: {
  customerName: string; customerEmail: string; customerPhone: string;
  serviceName: string; addonsText: string; totalDisplay: string; idShort: string;
  notes: string;
}): string {
  const lines = [
    `Service: ${parts.serviceName}`,
    `Customer: ${parts.customerName}`,
    `Email: ${parts.customerEmail}`,
    parts.customerPhone ? `Phone: ${parts.customerPhone}` : null,
    `Add-ons: ${parts.addonsText}`,
    `Estimated total: ${parts.totalDisplay}`,
    `Booking ref: ${parts.idShort}`,
    parts.notes ? `\nNotes:\n${parts.notes}` : null,
  ].filter(Boolean);
  return lines.join("\n");
}

async function deleteCalendarEvent(opts: {
  refreshToken: string; clientId: string; clientSecret: string;
  calendarId: string; eventId: string;
}): Promise<boolean> {
  const accessToken = await getGoogleAccessToken(opts.clientId, opts.clientSecret, opts.refreshToken);
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(opts.calendarId)}/events/${encodeURIComponent(opts.eventId)}`,
    { method: "DELETE", headers: { authorization: `Bearer ${accessToken}` } },
  );
  // 204 = deleted, 410 = already gone, both are "success" for our purposes
  if (res.status === 204 || res.status === 410) return true;
  const errText = await res.text();
  throw new Error(`calendar event delete failed: ${res.status} ${errText}`);
}

async function createCalendarEvent(opts: {
  refreshToken: string; clientId: string; clientSecret: string;
  calendarId: string;
  summary: string; location: string; description: string;
  dateISO: string;        // "YYYY-MM-DD"
  timeSlot: string;       // "11:00 am"
  durationMin: number;
}): Promise<string | null> {
  const t = parseSlotTo24h(opts.timeSlot);
  if (!t) return null;

  const startMinutes = t.hour * 60 + t.minute;
  const endMinutes = startMinutes + (opts.durationMin || 180);
  const endHour = Math.floor(endMinutes / 60) % 24;
  const endMin = endMinutes % 60;

  const pad = (n: number) => String(n).padStart(2, "0");
  const startDateTime = `${opts.dateISO}T${pad(t.hour)}:${pad(t.minute)}:00`;
  // If the event runs past midnight, the date rolls forward by one day.
  let endDate = opts.dateISO;
  if (endMinutes >= 24 * 60) {
    const d = new Date(opts.dateISO + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + 1);
    endDate = d.toISOString().slice(0, 10);
  }
  const endDateTime = `${endDate}T${pad(endHour)}:${pad(endMin)}:00`;

  const accessToken = await getGoogleAccessToken(opts.clientId, opts.clientSecret, opts.refreshToken);

  const eventBody = {
    summary: opts.summary,
    location: opts.location || undefined,
    description: opts.description,
    start: { dateTime: startDateTime, timeZone: "America/Toronto" },
    end: { dateTime: endDateTime, timeZone: "America/Toronto" },
    reminders: { useDefault: true },
  };

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(opts.calendarId)}/events`,
    {
      method: "POST",
      headers: {
        "authorization": `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(eventBody),
    },
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`calendar event create failed: ${res.status} ${errText}`);
  }
  const data = await res.json();
  return data.id || null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    const body = await req.json();
    const booking_id = body?.booking_id;
    const declineReason: string | null = typeof body?.reason === "string" ? body.reason : null;
    type Mode = "booked" | "cancelled" | "confirmed" | "declined" | "completed" | "invoice";
    const requestedMode = body?.mode;
    const mode: Mode = (requestedMode === "cancelled" || requestedMode === "confirmed" || requestedMode === "declined" || requestedMode === "completed" || requestedMode === "invoice")
      ? requestedMode : "booked";
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
        services ( name, slug, starting_price_cents, duration_minutes ),
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

    // Anti-abuse: pin to a recent timestamp depending on which kind of
    // email we're sending. Booked = booking created < 10 min ago.
    // Cancelled = booking cancelled < 10 min ago AND status is actually
    // cancelled (a customer can't trigger a cancellation email for a
    // booking they haven't actually cancelled).
    if (mode === "cancelled") {
      if (booking.status !== "cancelled" || !booking.cancelled_at) {
        return jsonResponse({ error: "Booking is not cancelled" }, 400);
      }
      const cancelAgeMs = Date.now() - new Date(booking.cancelled_at).getTime();
      if (cancelAgeMs > 24 * 60 * 60 * 1000) {
        return jsonResponse({ error: "Cancellation too old to email" }, 410);
      }
    } else if (mode === "confirmed") {
      if (booking.status !== "confirmed") {
        return jsonResponse({ error: "Booking is not confirmed" }, 400);
      }
    } else if (mode === "declined") {
      if (booking.status !== "cancelled") {
        return jsonResponse({ error: "Booking is not declined" }, 400);
      }
    } else if (mode === "completed") {
      // Completed emails get sent at job-completion time, often days/weeks
      // after the booking was created — so don't gate on created_at age.
      // Gate on status + completed_at recency instead.
      if (booking.status !== "completed") {
        return jsonResponse({ error: "Booking is not completed" }, 400);
      }
      if (booking.completed_at) {
        const ageMs = Date.now() - new Date(booking.completed_at).getTime();
        if (ageMs > 7 * 24 * 60 * 60 * 1000) {
          return jsonResponse({ error: "Completion too old to email" }, 410);
        }
      }
    } else if (mode === "invoice") {
      // Invoices are sent on/after completion. No age cap — admin may re-send
      // weeks later. Booking just has to be completed.
      if (booking.status !== "completed") {
        return jsonResponse({ error: "Cannot invoice a booking that is not completed" }, 400);
      }
    } else {
      const ageMs = Date.now() - new Date(booking.created_at).getTime();
      if (ageMs > 10 * 60 * 1000) {
        return jsonResponse({ error: "Booking too old to email" }, 410);
      }
    }

    // Look up the customer's email from auth.users (not exposed in profiles)
    const { data: userResult, error: userErr } = await sb.auth.admin.getUserById(booking.user_id);
    if (userErr || !userResult?.user?.email) {
      console.error("user fetch failed:", userErr);
      return jsonResponse({ error: "User email not found" }, 404);
    }
    const customerEmail = userResult.user.email;
    const customerName = booking.profiles?.full_name || userResult.user.user_metadata?.full_name || "there";
    const customerPhone = booking.profiles?.phone || userResult.user.user_metadata?.phone || "";

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

    // Line-item rows for the booked summary: service base price first, then
    // each addon priced (or "Included" for $0 like Eco Products). Cleaner
    // than the old separate Service line + Add-ons bullet list, and shows
    // the customer how the total was built.
    const baseCents = booking.services?.starting_price_cents ?? 0;
    const addonsCents = bookingAddons.reduce((s: number, ba: any) => s + ((ba.price_cents || 0) * (ba.quantity || 1)), 0);
    // Use the saved total when it's there, otherwise reconstruct from parts.
    const lineRows: string[] = [];
    lineRows.push(
      `<tr><td style="padding:6px 0;color:#1a2e1e">${escapeHtml(serviceName)}</td>` +
      `<td style="padding:6px 0;text-align:right;color:#1a2e1e;font-weight:600">${baseCents ? dollars(baseCents) : "—"}</td></tr>`
    );
    for (const ba of bookingAddons) {
      const name = ba.addons?.name || "Add-on";
      const qty = ba.quantity > 1 ? ` × ${ba.quantity}` : "";
      const linePrice = (ba.price_cents || 0) * (ba.quantity || 1);
      const priceLabel = linePrice > 0 ? dollars(linePrice) : `<span style="color:#6a7d6e;font-weight:400">Included</span>`;
      lineRows.push(
        `<tr><td style="padding:6px 0;color:#1a2e1e">${escapeHtml(name)}${qty}</td>` +
        `<td style="padding:6px 0;text-align:right;color:#1a2e1e;font-weight:600">${priceLabel}</td></tr>`
      );
    }
    const lineItemsHtml = lineRows.join("");

    // Prefer the charged price once it's known (set during Mark complete).
    // Falls back to the estimate for pre-completion emails (booked, confirmed,
    // declined, cancelled) where final_price_cents is still null.
    const totalCents = booking.final_price_cents ?? booking.estimated_price_cents;
    const totalDisplay = dollars(totalCents);
    const isQuote = booking.estimated_price_cents == null || booking.status === "awaiting_quote";

    // ── CONFIRMED PATH (owner confirms a pending booking) ─────────────────
    if (mode === "confirmed") {
      const confirmedHtml = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f8faf8;font-family:'Helvetica Neue',Arial,sans-serif;color:#1a2e1e">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f8faf8;padding:40px 16px">
    <tr><td align="center">
      <table cellpadding="0" cellspacing="0" border="0" width="520" style="max-width:520px;background:white;border-radius:16px;overflow:hidden;border:1px solid #d4e2d8">
        <tr><td style="background:#f8faf8;padding:28px 24px;text-align:center;border-bottom:3px solid #1e4d2b">
          <img src="https://hirayaspaces.ca/logo-horizontal.jpg" alt="Hiraya Spaces" width="320" style="display:block;margin:0 auto;max-width:100%;height:auto">
        </td></tr>
        <tr><td style="padding:36px 30px 20px">
          <div style="display:inline-block;background:#1e4d2b;color:white;font-size:11px;font-weight:800;letter-spacing:1.5px;padding:6px 14px;border-radius:6px;margin-bottom:14px">CONFIRMED</div>
          <h1 style="font-family:Georgia,'Cormorant Garamond',serif;font-weight:400;font-size:28px;margin:0 0 10px;color:#1a2e1e">You're all set!</h1>
          <p style="font-size:14px;color:#6a7d6e;line-height:1.7;margin:0 0 24px">
            Hi ${escapeHtml(customerName)} — your booking <strong style="color:#1e4d2b">${idShort}</strong> is officially confirmed. See you on the day!
          </p>

          <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#e4f0e9;border:1px solid #5a9470;border-radius:12px;margin-bottom:18px">
            <tr><td style="padding:18px 22px">
              <div style="font-size:11px;font-weight:700;color:#1e4d2b;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:12px">Confirmed booking</div>
              <table cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:14px;color:#1a2e1e">
                <tr><td style="padding:4px 0;color:#6a7d6e">Service</td><td style="padding:4px 0;text-align:right">${escapeHtml(serviceName)}</td></tr>
                <tr><td style="padding:4px 0;color:#6a7d6e">Date</td><td style="padding:4px 0;text-align:right">${escapeHtml(dateDisplay)}${timeDisplay ? " at " + escapeHtml(timeDisplay) : ""}</td></tr>
                <tr><td style="padding:4px 0;color:#6a7d6e">Address</td><td style="padding:4px 0;text-align:right">${escapeHtml(addressLine)}</td></tr>
                <tr><td style="padding:8px 0 4px;color:#6a7d6e;font-weight:700;border-top:1px solid #5a9470">Estimated total</td><td style="padding:8px 0 4px;text-align:right;font-weight:700;color:#1e4d2b;border-top:1px solid #5a9470">${escapeHtml(totalDisplay)}</td></tr>
              </table>
            </td></tr>
          </table>

          <p style="font-size:12px;color:#6a7d6e;line-height:1.7;margin:0 0 12px">
            Need to make a change? Reply to this email or cancel from your account up to 24 hours before. We can't wait to clean for you.
          </p>
        </td></tr>
        <tr><td style="background:#f0f5f1;padding:18px 30px;text-align:center;font-size:11px;color:#6a7d6e;border-top:1px solid #d4e2d8">
          Hiraya Spaces · Waterloo, ON · <a href="https://hirayaspaces.ca" style="color:#1e4d2b;text-decoration:none">hirayaspaces.ca</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

      const smtpPortConf = parseInt(Deno.env.get("SMTP_PORT") || "465");
      const confClient = new SMTPClient({
        connection: {
          hostname: Deno.env.get("SMTP_HOST") || "smtp.gmail.com",
          port: smtpPortConf, tls: smtpPortConf === 465,
          auth: { username: Deno.env.get("SMTP_USER")!, password: Deno.env.get("SMTP_PASS")! },
        },
      });
      try {
        await confClient.send({
          from: Deno.env.get("SMTP_FROM") || Deno.env.get("SMTP_USER")!,
          to: customerEmail,
          subject: `Booking confirmed - ${idShort}`,
          html: tidyHtml(confirmedHtml),
        });
      } catch (e) { console.warn("confirmed email failed:", e); }
      try { await confClient.close(); } catch (_) {}
      return jsonResponse({ ok: true, booking_id, mode: "confirmed" });
    }

    // ── COMPLETED PATH (owner marks a booking done — tip + review asks) ───
    if (mode === "completed") {
      const completedHtml = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f8faf8;font-family:'Helvetica Neue',Arial,sans-serif;color:#1a2e1e">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f8faf8;padding:40px 16px">
    <tr><td align="center">
      <table cellpadding="0" cellspacing="0" border="0" width="520" style="max-width:520px;background:white;border-radius:16px;overflow:hidden;border:1px solid #d4e2d8">
        <tr><td style="background:#f8faf8;padding:28px 24px;text-align:center;border-bottom:3px solid #1e4d2b">
          <img src="https://hirayaspaces.ca/logo-horizontal.jpg" alt="Hiraya Spaces" width="320" style="display:block;margin:0 auto;max-width:100%;height:auto">
        </td></tr>
        <tr><td style="padding:36px 30px 20px">
          <div style="display:inline-block;background:#1e4d2b;color:white;font-size:11px;font-weight:800;letter-spacing:1.5px;padding:6px 14px;border-radius:6px;margin-bottom:14px">CLEAN COMPLETE</div>
          <h1 style="font-family:Georgia,'Cormorant Garamond',serif;font-weight:400;font-size:28px;margin:0 0 10px;color:#1a2e1e">Thanks ${escapeHtml(customerName.split(' ')[0])}!</h1>
          <p style="font-size:14px;color:#6a7d6e;line-height:1.7;margin:0 0 24px">
            Your clean is done and we hope your space feels amazing. Booking <strong style="color:#1e4d2b">${idShort}</strong> is officially wrapped up.
          </p>

          <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#e4f0e9;border:1px solid #5a9470;border-radius:12px;margin-bottom:18px">
            <tr><td style="padding:18px 22px">
              <div style="font-size:11px;font-weight:700;color:#1e4d2b;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:12px">Completed</div>
              <table cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:14px;color:#1a2e1e">
                <tr><td style="padding:4px 0;color:#6a7d6e">Service</td><td style="padding:4px 0;text-align:right">${escapeHtml(serviceName)}</td></tr>
                <tr><td style="padding:4px 0;color:#6a7d6e">Date</td><td style="padding:4px 0;text-align:right">${escapeHtml(dateDisplay)}</td></tr>
                <tr><td style="padding:4px 0;color:#6a7d6e">Address</td><td style="padding:4px 0;text-align:right">${escapeHtml(addressLine)}</td></tr>
                <tr><td style="padding:8px 0 4px;color:#6a7d6e;font-weight:700;border-top:1px solid #5a9470">Total</td><td style="padding:8px 0 4px;text-align:right;font-weight:700;color:#1e4d2b;border-top:1px solid #5a9470">${escapeHtml(totalDisplay)}</td></tr>
              </table>
            </td></tr>
          </table>

          <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#fffbeb;border:1px solid #e5d3a0;border-radius:12px;margin-bottom:14px">
            <tr><td style="padding:16px 20px">
              <div style="font-size:13px;color:#5a4318;line-height:1.6">
                <strong style="color:#3d2c0d">Love your clean?</strong> Tips are never expected but always appreciated — you can send one by e-transfer to <a href="mailto:hirayaspaces@gmail.com" style="color:#1e4d2b;font-weight:600">hirayaspaces@gmail.com</a>. 100% goes to your cleaner.
              </div>
            </td></tr>
          </table>

          <p style="font-size:13px;color:#1a2e1e;line-height:1.7;margin:0 0 18px">
            And if you have a moment, leaving a Google review helps us out more than anything else:<br>
            <a href="https://g.page/r/hirayaspaces/review" style="display:inline-block;margin-top:8px;background:#1e4d2b;color:white;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;font-size:13px">★ Leave a Google review</a>
          </p>

          <p style="font-size:12px;color:#6a7d6e;line-height:1.7;margin:0">
            Want to book another? Reply to this email or grab a slot at <a href="https://hirayaspaces.ca" style="color:#1e4d2b">hirayaspaces.ca</a>.
          </p>
        </td></tr>
        <tr><td style="background:#f0f5f1;padding:18px 30px;text-align:center;font-size:11px;color:#6a7d6e;border-top:1px solid #d4e2d8">
          Hiraya Spaces · Waterloo, ON · <a href="https://hirayaspaces.ca" style="color:#1e4d2b;text-decoration:none">hirayaspaces.ca</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

      const smtpPortDone = parseInt(Deno.env.get("SMTP_PORT") || "465");
      const doneClient = new SMTPClient({
        connection: {
          hostname: Deno.env.get("SMTP_HOST") || "smtp.gmail.com",
          port: smtpPortDone, tls: smtpPortDone === 465,
          auth: { username: Deno.env.get("SMTP_USER")!, password: Deno.env.get("SMTP_PASS")! },
        },
      });
      let completedErr: unknown = null;
      try {
        await doneClient.send({
          from: Deno.env.get("SMTP_FROM") || Deno.env.get("SMTP_USER")!,
          to: customerEmail,
          subject: `Clean complete - thanks - ${idShort}`,
          html: tidyHtml(completedHtml),
        });
      } catch (e) { console.warn("completed email failed:", e); completedErr = e; }
      try { await doneClient.close(); } catch (_) {}
      if (completedErr) {
        const msg = (completedErr as Error)?.message || String(completedErr);
        return jsonResponse({ error: "Completed email failed", debug: msg }, 502);
      }
      return jsonResponse({ ok: true, booking_id, mode: "completed" });
    }

    // ── INVOICE PATH (owner sends formal invoice after completion) ────────
    if (mode === "invoice") {
      // Look up or create the invoice row first so the email carries the
      // canonical invoice_number. One invoice per booking — re-sends reuse
      // the existing row.
      const finalCents = (booking.final_price_cents ?? booking.estimated_price_cents) ?? 0;
      const { data: existingInv } = await sb
        .from("invoices")
        .select("id, invoice_number, status, total_cents")
        .eq("booking_id", booking_id)
        .maybeSingle();

      let invoiceNumber = existingInv?.invoice_number;
      let invoiceTotal = existingInv?.total_cents ?? finalCents;
      let invoiceStatus = existingInv?.status || "unpaid";

      // If the invoice is still unpaid and the booking's final price has
      // changed since the invoice was first issued, sync the row so the
      // email reflects the current charge.
      if (existingInv && existingInv.status === "unpaid" && finalCents !== existingInv.total_cents) {
        const { error: updErr } = await sb.from("invoices")
          .update({ amount_cents: finalCents, total_cents: finalCents })
          .eq("id", existingInv.id);
        if (updErr) {
          console.warn("invoice total sync failed:", updErr.message);
        } else {
          invoiceTotal = finalCents;
        }
      }

      if (!existingInv) {
        const { data: seqRow, error: seqErr } = await sb
          .rpc("next_invoice_number");
        if (seqErr) {
          console.error("invoice number seq failed:", seqErr);
          return jsonResponse({ error: "Invoice number sequence failed", debug: seqErr.message }, 500);
        }
        invoiceNumber = seqRow as unknown as string;
        const { error: insErr } = await sb.from("invoices").insert({
          booking_id,
          user_id: booking.user_id,
          invoice_number: invoiceNumber,
          amount_cents: finalCents,
          total_cents: finalCents,
          status: "unpaid",
        });
        if (insErr) {
          console.error("invoice insert failed:", insErr);
          return jsonResponse({ error: "Invoice insert failed", debug: insErr.message }, 500);
        }
        invoiceTotal = finalCents;
      }

      const issuedDisplay = new Date().toLocaleDateString("en-CA", { month: "long", day: "numeric", year: "numeric" });
      const subtotalDisplay = dollars(invoiceTotal);
      // Build line items. Service + addons stay at their catalog prices so the
      // customer sees exactly what they originally booked. If the final invoice
      // is higher than that subtotal (e.g. admin marked complete with extra
      // work), the gap shows as its own "Additional services provided" line so
      // the upcharge is transparent.
      const baseCatalogCents = (booking.services?.starting_price_cents) ?? 0;
      const addonsTotalCents = bookingAddons.reduce((s: number, ba: any) => s + ((ba.price_cents || 0) * (ba.quantity || 1)), 0);
      const lineSubtotalCents = baseCatalogCents + addonsTotalCents;
      const additionalCents = invoiceTotal - lineSubtotalCents;
      const lineRows: string[] = [];
      lineRows.push(`<tr><td style="padding:8px 0;color:#1a2e1e">${escapeHtml(serviceName)}</td><td style="padding:8px 0;text-align:right;color:#1a2e1e">${dollars(baseCatalogCents)}</td></tr>`);
      for (const ba of bookingAddons) {
        const name = ba.addons?.name || "Add-on";
        const qty = ba.quantity > 1 ? ` × ${ba.quantity}` : "";
        const lineTotal = (ba.price_cents || 0) * (ba.quantity || 1);
        lineRows.push(`<tr><td style="padding:8px 0;color:#1a2e1e">${escapeHtml(name)}${qty}</td><td style="padding:8px 0;text-align:right;color:#1a2e1e">${dollars(lineTotal)}</td></tr>`);
      }
      if (additionalCents > 0) {
        lineRows.push(`<tr><td style="padding:8px 0;color:#1a2e1e">Additional services provided</td><td style="padding:8px 0;text-align:right;color:#1a2e1e">${dollars(additionalCents)}</td></tr>`);
      } else if (additionalCents < 0) {
        // Final came in lower than the catalog total — show as a discount so
        // the math still adds up cleanly.
        lineRows.push(`<tr><td style="padding:8px 0;color:#1a2e1e">Discount</td><td style="padding:8px 0;text-align:right;color:#1a2e1e">-${dollars(Math.abs(additionalCents))}</td></tr>`);
      }
      const lineItemsHtml = lineRows.join("");

      const invoiceHtml = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f8faf8;font-family:'Helvetica Neue',Arial,sans-serif;color:#1a2e1e">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f8faf8;padding:40px 16px">
    <tr><td align="center">
      <table cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:white;border-radius:16px;overflow:hidden;border:1px solid #d4e2d8">
        <tr><td style="background:#f8faf8;padding:28px 24px;text-align:center;border-bottom:3px solid #1e4d2b">
          <img src="https://hirayaspaces.ca/logo-horizontal.jpg" alt="Hiraya Spaces" width="320" style="display:block;margin:0 auto;max-width:100%;height:auto">
        </td></tr>
        <tr><td style="padding:36px 30px 20px">
          <div style="display:inline-block;background:#1e4d2b;color:white;font-size:11px;font-weight:800;letter-spacing:1.5px;padding:6px 14px;border-radius:6px;margin-bottom:14px">INVOICE</div>
          <h1 style="font-family:Georgia,'Cormorant Garamond',serif;font-weight:400;font-size:28px;margin:0 0 6px;color:#1a2e1e">${escapeHtml(invoiceNumber!)}</h1>
          <p style="font-size:13px;color:#6a7d6e;margin:0 0 22px">Issued ${escapeHtml(issuedDisplay)} · Booking <strong style="color:#1e4d2b">${idShort}</strong></p>

          <!-- Stacked single-column meta: customer block, then service block.
               Side-by-side TDs were getting crushed on phones. -->
          <table cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:14px;color:#1a2e1e;margin-bottom:20px;background:#f6f9f6;border:1px solid #d4e2d8;border-radius:12px">
            <tr><td style="padding:16px 18px;border-bottom:1px solid #d4e2d8">
              <div style="font-size:11px;font-weight:700;color:#6a7d6e;text-transform:uppercase;letter-spacing:1.2px;margin-bottom:8px">Billed to</div>
              <div style="font-weight:600">${escapeHtml(customerName)}</div>
              <div style="color:#6a7d6e;font-size:13px">${escapeHtml(customerEmail)}</div>
              ${customerPhone ? `<div style="color:#6a7d6e;font-size:13px">${escapeHtml(customerPhone)}</div>` : ""}
            </td></tr>
            <tr><td style="padding:16px 18px">
              <div style="font-size:11px;font-weight:700;color:#6a7d6e;text-transform:uppercase;letter-spacing:1.2px;margin-bottom:8px">Service date</div>
              <div style="font-weight:600">${escapeHtml(dateDisplay)}${timeDisplay ? " · " + escapeHtml(timeDisplay) : ""}</div>
              <div style="color:#6a7d6e;font-size:13px">${escapeHtml(addressLine)}</div>
            </td></tr>
          </table>

          <table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin-bottom:20px;font-size:14px">
            <tr><td colspan="2" style="border-bottom:2px solid #1e4d2b;padding-bottom:8px;font-size:11px;font-weight:700;color:#1e4d2b;text-transform:uppercase;letter-spacing:1.5px">Description</td></tr>
            ${lineItemsHtml}
            <tr><td style="padding:12px 0 6px;border-top:1px solid #d4e2d8;font-weight:700;font-size:15px">Total due</td><td style="padding:12px 0 6px;border-top:1px solid #d4e2d8;text-align:right;font-weight:700;color:#1e4d2b;font-size:18px">${escapeHtml(subtotalDisplay)}</td></tr>
          </table>

          <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#fffbeb;border:1px solid #e5d3a0;border-radius:12px;margin-bottom:14px">
            <tr><td style="padding:16px 20px">
              <div style="font-size:11px;font-weight:700;color:#5a4318;text-transform:uppercase;letter-spacing:1.2px;margin-bottom:8px">How to pay</div>
              <div style="font-size:13px;color:#3d2c0d;line-height:1.7">
                <strong>Cash:</strong> on arrival.<br>
                <strong>E-transfer:</strong> <a href="mailto:hirayaspaces@gmail.com" style="color:#1e4d2b;font-weight:600">hirayaspaces@gmail.com</a> — reference <strong>${escapeHtml(invoiceNumber!)}</strong>.
              </div>
            </td></tr>
          </table>

          <p style="font-size:12px;color:#6a7d6e;line-height:1.7;margin:0">
            Questions? Reply to this email or call (226) 751-4566. Thanks for choosing Hiraya Spaces.
          </p>
        </td></tr>
        <tr><td style="background:#f0f5f1;padding:18px 30px;text-align:center;font-size:11px;color:#6a7d6e;border-top:1px solid #d4e2d8">
          Hiraya Spaces · Waterloo, ON · <a href="https://hirayaspaces.ca" style="color:#1e4d2b;text-decoration:none">hirayaspaces.ca</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

      const smtpPortInv = parseInt(Deno.env.get("SMTP_PORT") || "465");
      const invClient = new SMTPClient({
        connection: {
          hostname: Deno.env.get("SMTP_HOST") || "smtp.gmail.com",
          port: smtpPortInv, tls: smtpPortInv === 465,
          auth: { username: Deno.env.get("SMTP_USER")!, password: Deno.env.get("SMTP_PASS")! },
        },
      });
      let invErr: unknown = null;
      try {
        await invClient.send({
          from: Deno.env.get("SMTP_FROM") || Deno.env.get("SMTP_USER")!,
          to: customerEmail,
          subject: `Invoice ${invoiceNumber} - Hiraya Spaces`,
          html: tidyHtml(invoiceHtml),
        });
      } catch (e) { console.warn("invoice email failed:", e); invErr = e; }
      try { await invClient.close(); } catch (_) {}
      if (invErr) {
        const msg = (invErr as Error)?.message || String(invErr);
        return jsonResponse({ error: "Invoice email failed", debug: msg }, 502);
      }
      return jsonResponse({ ok: true, booking_id, mode: "invoice", invoice_number: invoiceNumber, status: invoiceStatus });
    }

    // ── DECLINED PATH (owner declines a pending booking) ──────────────────
    if (mode === "declined") {
      const reasonText = declineReason && declineReason.trim() ? declineReason.trim() : null;
      const declinedHtml = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f8faf8;font-family:'Helvetica Neue',Arial,sans-serif;color:#1a2e1e">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f8faf8;padding:40px 16px">
    <tr><td align="center">
      <table cellpadding="0" cellspacing="0" border="0" width="520" style="max-width:520px;background:white;border-radius:16px;overflow:hidden;border:1px solid #d4e2d8">
        <tr><td style="background:#f8faf8;padding:28px 24px;text-align:center;border-bottom:3px solid #1e4d2b">
          <img src="https://hirayaspaces.ca/logo-horizontal.jpg" alt="Hiraya Spaces" width="320" style="display:block;margin:0 auto;max-width:100%;height:auto">
        </td></tr>
        <tr><td style="padding:36px 30px 20px">
          <div style="display:inline-block;background:#b08c4a;color:white;font-size:11px;font-weight:800;letter-spacing:1.5px;padding:6px 14px;border-radius:6px;margin-bottom:14px">UNABLE TO ACCEPT</div>
          <h1 style="font-family:Georgia,'Cormorant Garamond',serif;font-weight:400;font-size:28px;margin:0 0 10px;color:#1a2e1e">We're sorry — we can't take this one</h1>
          <p style="font-size:14px;color:#6a7d6e;line-height:1.7;margin:0 0 18px">
            Hi ${escapeHtml(customerName)} — unfortunately we couldn't accept booking <strong style="color:#1e4d2b">${idShort}</strong>${reasonText ? ` for the following reason: <em>${escapeHtml(reasonText)}</em>` : "."}
            ${reasonText ? "" : " We weren't able to fit it into our schedule."} You haven't been charged.
          </p>

          <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f6f9f6;border:1px solid #d4e2d8;border-radius:12px;margin-bottom:24px">
            <tr><td style="padding:18px 22px">
              <div style="font-size:11px;font-weight:600;color:#6a7d6e;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:12px">Original request</div>
              <table cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:14px;color:#1a2e1e">
                <tr><td style="padding:4px 0;color:#6a7d6e">Service</td><td style="padding:4px 0;text-align:right">${escapeHtml(serviceName)}</td></tr>
                <tr><td style="padding:4px 0;color:#6a7d6e">Date</td><td style="padding:4px 0;text-align:right">${escapeHtml(dateDisplay)}${timeDisplay ? " at " + escapeHtml(timeDisplay) : ""}</td></tr>
                <tr><td style="padding:4px 0;color:#6a7d6e">Address</td><td style="padding:4px 0;text-align:right">${escapeHtml(addressLine)}</td></tr>
              </table>
            </td></tr>
          </table>

          <p style="font-size:13px;color:#6a7d6e;line-height:1.7;margin:0 0 12px">
            We'd love to clean for you another time. <a href="https://hirayaspaces.ca/#how" style="color:#1e4d2b;font-weight:600;text-decoration:none">Try a different date or service →</a>
          </p>
        </td></tr>
        <tr><td style="background:#f0f5f1;padding:18px 30px;text-align:center;font-size:11px;color:#6a7d6e;border-top:1px solid #d4e2d8">
          Hiraya Spaces · Waterloo, ON · <a href="https://hirayaspaces.ca" style="color:#1e4d2b;text-decoration:none">hirayaspaces.ca</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

      const smtpPortDec = parseInt(Deno.env.get("SMTP_PORT") || "465");
      const decClient = new SMTPClient({
        connection: {
          hostname: Deno.env.get("SMTP_HOST") || "smtp.gmail.com",
          port: smtpPortDec, tls: smtpPortDec === 465,
          auth: { username: Deno.env.get("SMTP_USER")!, password: Deno.env.get("SMTP_PASS")! },
        },
      });
      try {
        await decClient.send({
          from: Deno.env.get("SMTP_FROM") || Deno.env.get("SMTP_USER")!,
          to: customerEmail,
          subject: `Booking update - ${idShort}`,
          html: tidyHtml(declinedHtml),
        });
      } catch (e) { console.warn("declined email failed:", e); }
      try { await decClient.close(); } catch (_) {}

      // Delete the linked Google Calendar event (best-effort) + clear the FK.
      const refreshToken = Deno.env.get("GOOGLE_OAUTH_REFRESH_TOKEN");
      const clientId = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID");
      const clientSecret = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET");
      if (booking.google_calendar_event_id && refreshToken && clientId && clientSecret) {
        try {
          await deleteCalendarEvent({
            refreshToken, clientId, clientSecret,
            calendarId: Deno.env.get("GOOGLE_CALENDAR_ID") || "primary",
            eventId: booking.google_calendar_event_id,
          });
          await sb.from("bookings").update({ google_calendar_event_id: null }).eq("id", booking_id);
        } catch (calErr) { console.warn("calendar event delete failed:", calErr); }
      }
      return jsonResponse({ ok: true, booking_id, mode: "declined" });
    }

    // ── CANCELLATION PATH ─────────────────────────────────────────────────
    // When mode === "cancelled" we send a different pair of emails (customer
    // confirmation of cancellation + owner alert) and delete the linked
    // Google Calendar event. Then we return early so the booked-path code
    // below doesn't try to re-send the confirmation email.
    if (mode === "cancelled") {
      const cancelledHtml = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f8faf8;font-family:'Helvetica Neue',Arial,sans-serif;color:#1a2e1e">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f8faf8;padding:40px 16px">
    <tr><td align="center">
      <table cellpadding="0" cellspacing="0" border="0" width="520" style="max-width:520px;background:white;border-radius:16px;overflow:hidden;border:1px solid #d4e2d8">
        <tr><td style="background:#f8faf8;padding:28px 24px;text-align:center;border-bottom:3px solid #1e4d2b">
          <img src="https://hirayaspaces.ca/logo-horizontal.jpg" alt="Hiraya Spaces" width="320" style="display:block;margin:0 auto;max-width:100%;height:auto">
        </td></tr>
        <tr><td style="padding:36px 30px 20px">
          <h1 style="font-family:Georgia,'Cormorant Garamond',serif;font-weight:400;font-size:28px;margin:0 0 10px;color:#1a2e1e">Booking cancelled</h1>
          <p style="font-size:14px;color:#6a7d6e;line-height:1.7;margin:0 0 24px">
            Hi ${escapeHtml(customerName)} — we've cancelled booking <strong style="color:#1e4d2b">${idShort}</strong>. You haven't been charged and your spot has been freed for someone else.
          </p>

          <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f6f9f6;border:1px solid #d4e2d8;border-radius:12px;margin-bottom:24px">
            <tr><td style="padding:18px 22px">
              <div style="font-size:11px;font-weight:600;color:#6a7d6e;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:12px">Cancelled booking</div>
              <table cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:14px;color:#1a2e1e">
                <tr><td style="padding:4px 0;color:#6a7d6e">Service</td><td style="padding:4px 0;text-align:right">${escapeHtml(serviceName)}</td></tr>
                <tr><td style="padding:4px 0;color:#6a7d6e">Date</td><td style="padding:4px 0;text-align:right">${escapeHtml(dateDisplay)}${timeDisplay ? " at " + escapeHtml(timeDisplay) : ""}</td></tr>
                <tr><td style="padding:4px 0;color:#6a7d6e">Address</td><td style="padding:4px 0;text-align:right">${escapeHtml(addressLine)}</td></tr>
              </table>
            </td></tr>
          </table>

          <p style="font-size:13px;color:#6a7d6e;line-height:1.7;margin:0 0 18px">
            Changed your mind? You're welcome to <a href="https://hirayaspaces.ca/#how" style="color:#1e4d2b;font-weight:600;text-decoration:none">book a new clean</a> anytime. We'd love to have you back.
          </p>
        </td></tr>
        <tr><td style="background:#f0f5f1;padding:18px 30px;text-align:center;font-size:11px;color:#6a7d6e;border-top:1px solid #d4e2d8">
          Hiraya Spaces · Waterloo, ON · <a href="https://hirayaspaces.ca" style="color:#1e4d2b;text-decoration:none">hirayaspaces.ca</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

      const ownerCancelHtml = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f8faf8;font-family:'Helvetica Neue',Arial,sans-serif;color:#1a2e1e">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f8faf8;padding:32px 16px">
    <tr><td align="center">
      <table cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:white;border-radius:14px;overflow:hidden;border:1px solid #d4e2d8">
        <tr><td style="background:#1e4d2b;padding:20px 26px;color:white">
          <table cellpadding="0" cellspacing="0" border="0" width="100%">
            <tr>
              <td valign="middle" width="56">
                <img src="https://hirayaspaces.ca/logo-mark.jpg" alt="Hiraya Spaces" width="44" height="44" style="display:block;border-radius:8px">
              </td>
              <td valign="middle" style="padding-left:14px">
                <div style="font-family:Georgia,serif;font-size:13px;letter-spacing:2px;text-transform:uppercase;opacity:0.85">HIRAYA · ADMIN</div>
                <div style="font-size:20px;font-weight:600;margin-top:2px">Booking cancelled</div>
              </td>
            </tr>
          </table>
        </td></tr>
        <tr><td style="padding:22px 26px 8px">
          <table cellpadding="0" cellspacing="0" border="0" width="100%">
            <tr>
              <td><span style="background:#b08c4a;color:white;font-size:11px;font-weight:800;letter-spacing:1.5px;padding:5px 12px;border-radius:6px">CANCELLED</span> <span style="font-size:11px;color:#6a7d6e;margin-left:6px">by customer</span></td>
              <td style="text-align:right;font-size:12px;color:#6a7d6e">Ref <strong style="color:#1a2e1e">${idShort}</strong></td>
            </tr>
          </table>
        </td></tr>

        <tr><td style="padding:14px 26px 6px">
          <h2 style="font-family:Georgia,serif;font-size:22px;font-weight:500;margin:0 0 4px;color:#1a2e1e">${escapeHtml(serviceName)}</h2>
          <div style="font-size:14px;color:#6a7d6e">${escapeHtml(dateDisplay)}${timeDisplay ? " · " + escapeHtml(timeDisplay) : ""}</div>
        </td></tr>

        <tr><td style="padding:14px 26px">
          <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f6f9f6;border:1px solid #d4e2d8;border-radius:10px">
            <tr><td style="padding:14px 18px">
              <div style="font-size:10px;font-weight:700;color:#1e4d2b;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Customer</div>
              <div style="font-size:15px;font-weight:600;color:#1a2e1e">${escapeHtml(customerName)}</div>
              <div style="font-size:13px;color:#1a2e1e;margin-top:4px"><a href="mailto:${escapeHtml(customerEmail)}" style="color:#1e4d2b;text-decoration:none">${escapeHtml(customerEmail)}</a></div>
              ${customerPhone ? `<div style="font-size:13px;color:#1a2e1e;margin-top:2px">${escapeHtml(customerPhone)}</div>` : ""}
            </td></tr>
          </table>
        </td></tr>

        <tr><td style="padding:0 26px 22px">
          <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f6f9f6;border:1px solid #d4e2d8;border-radius:10px">
            <tr><td style="padding:14px 18px">
              <div style="font-size:10px;font-weight:700;color:#1e4d2b;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Address</div>
              <div style="font-size:13px;color:#1a2e1e;line-height:1.5">${escapeHtml(addressLine)}</div>
            </td></tr>
          </table>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

      const smtpPortCancel = parseInt(Deno.env.get("SMTP_PORT") || "465");
      const useTlsCancel = smtpPortCancel === 465;
      const cancelClient = new SMTPClient({
        connection: {
          hostname: Deno.env.get("SMTP_HOST") || "smtp.gmail.com",
          port: smtpPortCancel,
          tls: useTlsCancel,
          auth: {
            username: Deno.env.get("SMTP_USER")!,
            password: Deno.env.get("SMTP_PASS")!,
          },
        },
      });

      // Both customer and owner emails are best-effort so a single SMTP
      // hiccup doesn't block the calendar delete (which the customer cares
      // about most — they don't want to be charged for a clean they cancelled).
      try {
        await cancelClient.send({
          from: Deno.env.get("SMTP_FROM") || Deno.env.get("SMTP_USER")!,
          to: customerEmail,
          subject: `Booking cancelled - ${idShort}`,
          html: tidyHtml(cancelledHtml),
        });
      } catch (custCancelErr) {
        console.warn("customer cancel notification failed:", custCancelErr);
      }

      const ownerEmailCancel = Deno.env.get("OWNER_EMAIL") || Deno.env.get("SMTP_USER")!;
      try {
        await cancelClient.send({
          from: Deno.env.get("SMTP_FROM") || Deno.env.get("SMTP_USER")!,
          to: ownerEmailCancel,
          replyTo: customerEmail,
          subject: `Booking cancelled: ${customerName} - ${dateDisplay} - ${idShort}`,
          html: tidyHtml(ownerCancelHtml),
        });
      } catch (ownerCancelErr) {
        console.warn("owner cancel notification failed:", ownerCancelErr);
      }
      try { await cancelClient.close(); } catch (_) { /* close errors don't matter */ }

      // Delete the linked Google Calendar event (best-effort) + clear the FK.
      const refreshToken = Deno.env.get("GOOGLE_OAUTH_REFRESH_TOKEN");
      const clientId = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID");
      const clientSecret = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET");
      if (booking.google_calendar_event_id && refreshToken && clientId && clientSecret) {
        try {
          await deleteCalendarEvent({
            refreshToken, clientId, clientSecret,
            calendarId: Deno.env.get("GOOGLE_CALENDAR_ID") || "primary",
            eventId: booking.google_calendar_event_id,
          });
          await sb.from("bookings").update({ google_calendar_event_id: null }).eq("id", booking_id);
        } catch (calErr) {
          console.warn("calendar event delete failed:", calErr);
        }
      }

      return jsonResponse({ ok: true, booking_id, mode: "cancelled" });
    }

    const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f8faf8;font-family:'Helvetica Neue',Arial,sans-serif;color:#1a2e1e">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f8faf8;padding:40px 16px">
    <tr><td align="center">
      <table cellpadding="0" cellspacing="0" border="0" width="520" style="max-width:520px;background:white;border-radius:16px;overflow:hidden;border:1px solid #d4e2d8">
        <tr><td style="background:#f8faf8;padding:28px 24px;text-align:center;border-bottom:3px solid #1e4d2b">
          <img src="https://hirayaspaces.ca/logo-horizontal.jpg" alt="Hiraya Spaces" width="320" style="display:block;margin:0 auto;max-width:100%;height:auto">
        </td></tr>
        <tr><td style="padding:36px 30px 20px">
          <div style="display:inline-block;background:#b08c4a;color:white;font-size:11px;font-weight:800;letter-spacing:1.5px;padding:6px 14px;border-radius:6px;margin-bottom:14px">${isQuote ? "AWAITING QUOTE" : "PENDING REVIEW"}</div>
          <h1 style="font-family:Georgia,'Cormorant Garamond',serif;font-weight:400;font-size:28px;margin:0 0 10px;color:#1a2e1e">${isQuote ? "Quote request received" : "We've got your request"}</h1>
          <p style="font-size:14px;color:#6a7d6e;line-height:1.7;margin:0 0 24px">
            Thanks, <strong style="color:#1a2e1e">${escapeHtml(customerName)}</strong> — your booking request <strong style="color:#1e4d2b">${idShort}</strong> has been logged. ${isQuote ? "We'll review and send a tailored quote shortly." : "We'll review and send a separate confirmation email once it's locked in. Your spot isn't held until then."}
          </p>

          <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#e4f0e9;border:1px solid #5a9470;border-radius:12px;margin-bottom:24px">
            <tr><td style="padding:20px 22px">
              <div style="font-size:11px;font-weight:600;color:#1e4d2b;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:14px">Booking summary</div>

              <table cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:14px;color:#1a2e1e;margin-bottom:14px">
                <tr><td style="padding:5px 0;color:#6a7d6e;width:80px">Date</td><td style="padding:5px 0;text-align:right;font-weight:600">${escapeHtml(dateDisplay)}${timeDisplay ? " at " + escapeHtml(timeDisplay) : ""}</td></tr>
                <tr><td style="padding:5px 0;color:#6a7d6e;vertical-align:top">Address</td><td style="padding:5px 0;text-align:right">${escapeHtml(addressLine)}</td></tr>
              </table>

              <table cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:14px;border-top:1px solid #5a9470;padding-top:10px">
                ${lineItemsHtml}
              </table>

              <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:14px;padding-top:14px;border-top:1px solid #5a9470">
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

    // HTML-only sends (no parallel text/plain) — keeps the envelope a simple
    // single-part message, which renders cleanly in Gmail. The previous
    // multipart/mixed > multipart/alternative wrapping caused some clients
    // to show raw MIME source instead of rendered HTML.
    await client.send({
      from: Deno.env.get("SMTP_FROM") || Deno.env.get("SMTP_USER")!,
      to: customerEmail,
      subject: `${isQuote ? "Quote request" : "Booking received - pending review"} - ${idShort}`,
      html: tidyHtml(html),
    });

    // ── OWNER NOTIFICATION (best-effort — don't fail the request if this errors)
    const ownerEmail = Deno.env.get("OWNER_EMAIL") || Deno.env.get("SMTP_USER")!;
    try {
      const phoneDisplay = customerPhone || "Not provided";
      const phoneHref = customerPhone ? customerPhone.replace(/[^\d+]/g, "") : "";
      const mapsHref = booking.addresses
        ? "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(addressLine)
        : "";
      const statusLabel = isQuote ? "AWAITING QUOTE" : "PENDING REVIEW";
      const statusColor = isQuote ? "#b08c4a" : "#1e4d2b";

      const ownerAddonsHtml = bookingAddons.length
        ? `<ul style="margin:6px 0 0;padding-left:18px;color:#1a2e1e;font-size:13px">${bookingAddons.map((ba: any) => {
            const name = ba.addons?.name || ba.addon_id;
            const qty = ba.quantity > 1 ? ` × ${ba.quantity}` : "";
            const price = ba.price_cents ? ` — ${dollars(ba.price_cents * (ba.quantity || 1))}` : "";
            return `<li style="margin-bottom:3px">${escapeHtml(name)}${qty}${price}</li>`;
          }).join("")}</ul>`
        : `<div style="color:#6a7d6e;font-style:italic;font-size:13px;margin-top:4px">None</div>`;

      const ownerHtml = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f8faf8;font-family:'Helvetica Neue',Arial,sans-serif;color:#1a2e1e">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f8faf8;padding:32px 16px">
    <tr><td align="center">
      <table cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:white;border-radius:14px;overflow:hidden;border:1px solid #d4e2d8">
        <tr><td style="background:#1e4d2b;padding:20px 26px;color:white">
          <table cellpadding="0" cellspacing="0" border="0" width="100%">
            <tr>
              <td valign="middle" width="56">
                <img src="https://hirayaspaces.ca/logo-mark.jpg" alt="Hiraya Spaces" width="44" height="44" style="display:block;border-radius:8px">
              </td>
              <td valign="middle" style="padding-left:14px">
                <div style="font-family:Georgia,serif;font-size:13px;letter-spacing:2px;text-transform:uppercase;opacity:0.85">HIRAYA · ADMIN</div>
                <div style="font-size:20px;font-weight:600;margin-top:2px">New booking</div>
              </td>
            </tr>
          </table>
        </td></tr>
        <tr><td style="padding:22px 26px 8px">
          <table cellpadding="0" cellspacing="0" border="0" width="100%">
            <tr>
              <td><span style="background:${statusColor};color:white;font-size:10px;font-weight:700;letter-spacing:1px;padding:4px 10px;border-radius:6px">${statusLabel}</span></td>
              <td style="text-align:right;font-size:12px;color:#6a7d6e">Ref <strong style="color:#1a2e1e">${idShort}</strong></td>
            </tr>
          </table>
        </td></tr>

        <tr><td style="padding:14px 26px 6px">
          <h2 style="font-family:Georgia,serif;font-size:22px;font-weight:500;margin:0 0 4px;color:#1a2e1e">${escapeHtml(serviceName)}</h2>
          <div style="font-size:14px;color:#6a7d6e">${escapeHtml(dateDisplay)}${timeDisplay ? " · " + escapeHtml(timeDisplay) : ""}</div>
        </td></tr>

        <tr><td style="padding:14px 26px">
          <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#e4f0e9;border:1px solid #5a9470;border-radius:10px">
            <tr><td style="padding:14px 18px">
              <div style="font-size:10px;font-weight:700;color:#1e4d2b;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Customer</div>
              <div style="font-size:15px;font-weight:600;color:#1a2e1e">${escapeHtml(customerName)}</div>
              <div style="font-size:13px;color:#1a2e1e;margin-top:4px"><a href="mailto:${escapeHtml(customerEmail)}" style="color:#1e4d2b;text-decoration:none">${escapeHtml(customerEmail)}</a></div>
              <div style="font-size:13px;color:#1a2e1e;margin-top:2px">${phoneHref ? `<a href="tel:${escapeHtml(phoneHref)}" style="color:#1e4d2b;text-decoration:none">${escapeHtml(phoneDisplay)}</a>` : escapeHtml(phoneDisplay)}</div>
            </td></tr>
          </table>
        </td></tr>

        <tr><td style="padding:0 26px 14px">
          <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f6f9f6;border:1px solid #d4e2d8;border-radius:10px">
            <tr><td style="padding:14px 18px">
              <div style="font-size:10px;font-weight:700;color:#1e4d2b;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Address</div>
              <div style="font-size:13px;color:#1a2e1e;line-height:1.5">${escapeHtml(addressLine)}</div>
              ${mapsHref ? `<div style="margin-top:8px"><a href="${mapsHref}" style="font-size:12px;color:#1e4d2b;text-decoration:none;font-weight:600">🗺 Open in Google Maps →</a></div>` : ""}
            </td></tr>
          </table>
        </td></tr>

        <tr><td style="padding:0 26px 14px">
          <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f6f9f6;border:1px solid #d4e2d8;border-radius:10px">
            <tr><td style="padding:14px 18px">
              <div style="font-size:10px;font-weight:700;color:#1e4d2b;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Add-ons</div>
              ${ownerAddonsHtml}
            </td></tr>
          </table>
        </td></tr>

        ${booking.customer_notes ? `
        <tr><td style="padding:0 26px 14px">
          <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#fff8e8;border:1px solid #e0c890;border-radius:10px">
            <tr><td style="padding:14px 18px">
              <div style="font-size:10px;font-weight:700;color:#8a6a18;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Customer notes</div>
              <div style="font-size:13px;color:#1a2e1e;line-height:1.5;white-space:pre-wrap">${escapeHtml(booking.customer_notes)}</div>
            </td></tr>
          </table>
        </td></tr>
        ` : ""}

        <tr><td style="padding:0 26px 22px">
          <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#1e4d2b;border-radius:10px">
            <tr><td style="padding:16px 20px">
              <table cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr>
                  <td style="color:white;font-size:14px;font-weight:600">${isQuote ? "Estimate (TBD)" : "Estimated total"}</td>
                  <td style="text-align:right;color:white;font-size:22px;font-weight:700">${escapeHtml(totalDisplay)}</td>
                </tr>
              </table>
            </td></tr>
          </table>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

      await client.send({
        from: Deno.env.get("SMTP_FROM") || Deno.env.get("SMTP_USER")!,
        to: ownerEmail,
        replyTo: customerEmail,
        subject: `New booking: ${customerName} - ${dateDisplay}${timeDisplay ? " " + timeDisplay : ""} - ${idShort}`,
        html: tidyHtml(ownerHtml),
      });
    } catch (ownerErr) {
      console.warn("owner notification failed:", ownerErr);
    }

    await client.close();

    // ── GOOGLE CALENDAR (best-effort — never fail the booking on a calendar error)
    try {
      const refreshToken = Deno.env.get("GOOGLE_OAUTH_REFRESH_TOKEN");
      const clientId = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID");
      const clientSecret = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET");
      if (refreshToken && clientId && clientSecret && booking.preferred_date && booking.preferred_time_slot) {
        const eventId = await createCalendarEvent({
          refreshToken, clientId, clientSecret,
          calendarId: Deno.env.get("GOOGLE_CALENDAR_ID") || "primary",
          summary: `🌿 ${customerName} — ${serviceName}`,
          location: booking.addresses ? addressLine : "",
          description: buildEventDescription({
            customerName, customerEmail, customerPhone, serviceName,
            addonsText: bookingAddons.length
              ? bookingAddons.map((ba: any) => `${ba.addons?.name || ba.addon_id}${ba.quantity > 1 ? " ×" + ba.quantity : ""}`).join(", ")
              : "None",
            totalDisplay, idShort,
            notes: booking.customer_notes || "",
          }),
          dateISO: booking.preferred_date,
          timeSlot: booking.preferred_time_slot,
          durationMin: booking.services?.duration_minutes || 180,
        });
        if (eventId) {
          await sb.from("bookings").update({ google_calendar_event_id: eventId }).eq("id", booking_id);
        }
      }
    } catch (calErr) {
      console.warn("calendar event creation failed:", calErr);
    }

    return jsonResponse({ ok: true, booking_id });
  } catch (err) {
    console.error("send-booking-email error:", err);
    return jsonResponse({ error: String((err as Error).message || err) }, 500);
  }
});
