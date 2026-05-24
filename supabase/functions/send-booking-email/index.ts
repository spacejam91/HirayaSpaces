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
    const mode: "booked" | "cancelled" = body?.mode === "cancelled" ? "cancelled" : "booked";
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
      // Cancellations are legitimate at any time. The status='cancelled' check
      // above is the real anti-abuse gate (a caller can't trigger this email
      // for a booking they haven't actually cancelled via the RPC). Keep a
      // generous 24h window mostly to dodge replay attacks long after the
      // fact, but allow customers to retry shortly after an initial failure.
      const cancelAgeMs = Date.now() - new Date(booking.cancelled_at).getTime();
      if (cancelAgeMs > 24 * 60 * 60 * 1000) {
        return jsonResponse({ error: "Cancellation too old to email" }, 410);
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

    const totalDisplay = dollars(booking.estimated_price_cents);
    const isQuote = booking.estimated_price_cents == null || booking.status === "awaiting_quote";

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

    // HTML-only sends (no parallel text/plain) — keeps the envelope a simple
    // single-part message, which renders cleanly in Gmail. The previous
    // multipart/mixed > multipart/alternative wrapping caused some clients
    // to show raw MIME source instead of rendered HTML.
    await client.send({
      from: Deno.env.get("SMTP_FROM") || Deno.env.get("SMTP_USER")!,
      to: customerEmail,
      subject: `${isQuote ? "Quote request" : "Booking confirmed"} - ${idShort}`,
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
