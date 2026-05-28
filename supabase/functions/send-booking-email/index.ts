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
import { PDFDocument, StandardFonts, rgb, degrees } from "https://esm.sh/pdf-lib@1.17.1";

// pdf-lib's standard fonts only encode WinAnsi (Latin-1). Stripping/
// substituting any unicode the catalog uses (≤, ×, —, …) so we don't crash
// on tier names like "Single room (≤200 sqft)" or "Inside Oven × 2".
function sanitizePdfText(s: string): string {
  if (s == null) return "";
  return String(s)
    .replace(/[‘’‚‛]/g, "'")    // smart single quotes
    .replace(/[“”„‟]/g, '"')   // smart double quotes
    .replace(/[–—]/g, "-")               // en/em dashes → hyphen
    .replace(/…/g, "...")                     // ellipsis
    .replace(/·/g, "-")                       // middle dot
    .replace(/•/g, "*")                       // bullet
    .replace(/×/g, "x")                       // multiplication sign
    .replace(/≤/g, "<=")                      // less-than-or-equal
    .replace(/≥/g, ">=")                      // greater-than-or-equal
    .replace(/′/g, "'")                       // prime
    .replace(/″/g, '"')                       // double prime
    .replace(/ /g, " ")                       // non-breaking space
    // Anything else outside WinAnsi gets stripped rather than crashing.
    .replace(/[^\x00-\xff]/g, "");
}

// ─── INVOICE PDF BUILDER ─────────────────────────────────────────────────
// Programmatic PDF rendering (no headless browser) using pdf-lib. Matches
// the HTML invoice layout: header, billed-to + service date stacked, line
// items, total due, how-to-pay. US Letter, single page.
async function buildInvoicePdf(opts: {
  invoiceNumber: string;
  issuedDisplay: string;
  idShort: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  dateDisplay: string;
  timeDisplay: string;
  addressLine: string;
  lineItems: { name: string; priceLabel: string }[];
  totalDisplay: string;
  paid?: boolean;
  paidDisplay?: string;
}): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]); // US Letter @ 72 dpi
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const serif = await pdf.embedFont(StandardFonts.TimesRoman);

  const sage = rgb(30 / 255, 77 / 255, 43 / 255);
  const muted = rgb(106 / 255, 125 / 255, 110 / 255);
  const text = rgb(26 / 255, 46 / 255, 30 / 255);
  const border = rgb(212 / 255, 226 / 255, 216 / 255);

  const left = 50;
  const right = 562;
  let y = 750;

  const drawRight = (str: string, yPos: number, f = font, size = 11, color = text) => {
    const s = sanitizePdfText(str);
    const w = f.widthOfTextAtSize(s, size);
    page.drawText(s, { x: right - w, y: yPos, font: f, size, color });
  };
  const drawAt = (str: string, x: number, yPos: number, f = font, size = 11, color = text) => {
    page.drawText(sanitizePdfText(str), { x, y: yPos, font: f, size, color });
  };

  // Brand header — embed the live logo image. Falls back to the text wordmark
  // if the fetch fails so the invoice still renders.
  let headerBottomY = y - 30;
  try {
    // Cleaner B&W mark for the invoice. Emails still use the colour logo via
    // their own <img src>. If the PNG isn't deployed yet (or fetch fails), the
    // catch falls back to the text wordmark below.
    const logoResp = await fetch("https://hirayaspaces.ca/logo-horizontal-bw.png");
    if (!logoResp.ok) throw new Error(`logo fetch ${logoResp.status}`);
    const logoBytes = new Uint8Array(await logoResp.arrayBuffer());
    const logo = await pdf.embedPng(logoBytes);
    const logoDims = logo.scaleToFit(180, 80);
    const logoTop = 770;
    page.drawImage(logo, {
      x: left,
      y: logoTop - logoDims.height,
      width: logoDims.width,
      height: logoDims.height,
    });
    drawRight("Kitchener, ON - hirayaspaces.ca", logoTop - logoDims.height / 2 - 4, font, 10, muted);
    headerBottomY = logoTop - logoDims.height - 12;
  } catch (_logoErr) {
    drawAt("HIRAYA SPACES", left, y, bold, 14, sage);
    drawRight("Kitchener, ON - hirayaspaces.ca", y, font, 10, muted);
    y -= 14;
    drawAt("Turning homes into dream spaces", left, y, font, 9, muted);
    headerBottomY = y - 16;
  }

  // Divider
  y = headerBottomY;
  page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 2, color: sage });

  // INVOICE badge
  y -= 30;
  page.drawRectangle({ x: left, y: y - 4, width: 68, height: 20, color: sage });
  drawAt("INVOICE", left + 9, y, bold, 10, rgb(1, 1, 1));

  // Invoice number
  y -= 32;
  drawAt(opts.invoiceNumber, left, y, serif, 22, text);

  y -= 16;
  drawAt(`Issued ${opts.issuedDisplay}  -  Booking ${opts.idShort}`, left, y, font, 10, muted);

  // Billed to
  y -= 32;
  drawAt("BILLED TO", left, y, bold, 9, muted);
  y -= 14;
  drawAt(opts.customerName, left, y, bold, 11, text);
  y -= 13;
  drawAt(opts.customerEmail, left, y, font, 10, muted);
  if (opts.customerPhone) {
    y -= 13;
    drawAt(opts.customerPhone, left, y, font, 10, muted);
  }

  // Service date
  y -= 22;
  drawAt("SERVICE DATE", left, y, bold, 9, muted);
  y -= 14;
  const dateLine = opts.dateDisplay + (opts.timeDisplay ? "  -  " + opts.timeDisplay : "");
  drawAt(dateLine, left, y, bold, 11, text);
  y -= 13;
  drawAt(opts.addressLine, left, y, font, 10, muted);

  // Description header
  y -= 30;
  drawAt("DESCRIPTION", left, y, bold, 9, sage);
  y -= 6;
  page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 1.5, color: sage });

  // Line items
  y -= 18;
  for (const item of opts.lineItems) {
    drawAt(item.name, left, y, font, 11, text);
    drawRight(item.priceLabel, y, font, 11, text);
    y -= 18;
  }

  // Total line — show invoiced amount, then a $0 "balance due" line when paid
  y -= 4;
  page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 0.5, color: border });
  y -= 20;
  if (opts.paid) {
    drawAt("Invoice total", left, y, font, 11, muted);
    drawRight(opts.totalDisplay, y, font, 11, muted);
    y -= 16;
    drawAt("Payment received", left, y, font, 11, muted);
    drawRight("-" + opts.totalDisplay, y, font, 11, muted);
    y -= 6;
    page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 0.5, color: border });
    y -= 20;
    drawAt("Balance due", left, y, bold, 13, text);
    drawRight("$0", y, bold, 14, sage);
  } else {
    drawAt("Total due", left, y, bold, 13, text);
    drawRight(opts.totalDisplay, y, bold, 14, sage);
  }

  // How to pay (only when unpaid). When paid we show a thank-you box instead.
  y -= 50;
  if (opts.paid) {
    page.drawRectangle({ x: left, y: y - 60, width: right - left, height: 76, color: rgb(228 / 255, 240 / 255, 233 / 255), borderColor: sage, borderWidth: 1 });
    drawAt("PAYMENT RECEIVED", left + 14, y, bold, 9, sage);
    y -= 18;
    drawAt("Thank you — this invoice has been paid in full.", left + 14, y, font, 10, text);
    if (opts.paidDisplay) {
      y -= 14;
      drawAt(`Paid on ${opts.paidDisplay}.`, left + 14, y, font, 10, muted);
    }
  } else {
    page.drawRectangle({ x: left, y: y - 60, width: right - left, height: 76, color: rgb(255 / 255, 251 / 255, 235 / 255), borderColor: rgb(229 / 255, 211 / 255, 160 / 255), borderWidth: 1 });
    drawAt("HOW TO PAY", left + 14, y, bold, 9, rgb(90 / 255, 67 / 255, 24 / 255));
    y -= 18;
    drawAt("Cash: on arrival.", left + 14, y, font, 10, rgb(61 / 255, 44 / 255, 13 / 255));
    y -= 14;
    drawAt(`E-transfer: hirayaspaces@gmail.com  -  reference ${opts.invoiceNumber}.`, left + 14, y, font, 10, rgb(61 / 255, 44 / 255, 13 / 255));
  }

  // Footer
  y = 40;
  drawAt("Questions? Reply to the invoice email or call (226) 751-4566.", left, y, font, 9, muted);

  // PAID watermark — drawn LAST so it sits on top of everything underneath.
  // Big sage-tinted text rotated diagonally across the page center.
  if (opts.paid) {
    const stampText = "PAID";
    const stampSize = 140;
    const stampW = bold.widthOfTextAtSize(stampText, stampSize);
    const angleDeg = 30;
    const angleRad = (angleDeg * Math.PI) / 180;
    const cx = 306; // page center x (612 / 2)
    const cy = 420;
    page.drawText(stampText, {
      x: cx - (stampW / 2) * Math.cos(angleRad),
      y: cy - (stampW / 2) * Math.sin(angleRad),
      font: bold,
      size: stampSize,
      color: sage,
      opacity: 0.15,
      rotate: degrees(angleDeg),
    });
  }

  return await pdf.save();
}


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
    type Mode = "booked" | "cancelled" | "confirmed" | "declined" | "completed" | "invoice" | "payment_received" | "updated" | "rescheduled" | "reminder" | "checked_in";
    const requestedMode = body?.mode;
    const mode: Mode = (requestedMode === "cancelled" || requestedMode === "confirmed" || requestedMode === "declined" || requestedMode === "completed" || requestedMode === "invoice" || requestedMode === "payment_received" || requestedMode === "updated" || requestedMode === "rescheduled" || requestedMode === "reminder" || requestedMode === "checked_in")
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

    // Fetch booking with joined service, addons, extra services, address, profile
    const { data: booking, error } = await sb
      .from("bookings")
      .select(`
        *,
        services ( name, slug, starting_price_cents, duration_minutes ),
        booking_addons ( quantity, price_cents, addons ( name, slug ) ),
        booking_services ( tier_name, price_cents, duration_minutes, quantity, services ( name ) ),
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
    } else if (mode === "payment_received") {
      // Payment confirmation goes out after admin marks the invoice paid.
      // The booking must be completed AND have a paid invoice on file.
      if (booking.status !== "completed") {
        return jsonResponse({ error: "Cannot confirm payment for a non-completed booking" }, 400);
      }
    } else if (mode === "updated") {
      // Edit notifications: only meaningful for active/editable bookings.
      if (!["pending_review","awaiting_quote","confirmed","in_progress"].includes(booking.status)) {
        return jsonResponse({ error: "Cannot send update for a non-active booking" }, 400);
      }
    } else if (mode === "rescheduled") {
      if (!["pending_review","awaiting_quote","confirmed","in_progress"].includes(booking.status)) {
        return jsonResponse({ error: "Cannot send reschedule for a non-active booking" }, 400);
      }
    } else if (mode === "reminder") {
      if (!["confirmed"].includes(booking.status)) {
        return jsonResponse({ error: "Only confirmed bookings get 24h reminders" }, 400);
      }
      if (booking.reminder_sent_at) {
        return jsonResponse({ ok: true, skipped: true, reason: "already_sent", booking_id }, 200);
      }
    } else if (mode === "checked_in") {
      if (booking.status !== "in_progress" || !booking.check_in_at) {
        return jsonResponse({ error: "Booking is not in_progress with a check_in_at" }, 400);
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
    const extraServices = Array.isArray(booking.booking_services) ? booking.booking_services : [];
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
    // Primary service first.
    lineRows.push(
      `<tr><td style="padding:6px 0;color:#1a2e1e">${escapeHtml(serviceName)}</td>` +
      `<td style="padding:6px 0;text-align:right;color:#1a2e1e;font-weight:600">${baseCents ? dollars(baseCents) : "—"}</td></tr>`
    );
    // Any extra services the customer added (Regular + Carpet + Sofa case).
    for (const es of extraServices) {
      const svcName = es.services?.name || "Service";
      const tierLabel = es.tier_name ? ` — ${es.tier_name}` : "";
      const qty = es.quantity > 1 ? ` × ${es.quantity}` : "";
      const linePrice = (es.price_cents || 0) * (es.quantity || 1);
      lineRows.push(
        `<tr><td style="padding:6px 0;color:#1a2e1e">${escapeHtml(svcName + tierLabel)}${qty}</td>` +
        `<td style="padding:6px 0;text-align:right;color:#1a2e1e;font-weight:600">${dollars(linePrice)}</td></tr>`
      );
    }
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

    // Recurring banner — shown on every customer email for a recurring booking
    // so the customer always sees the schedule (and the applied discount once
    // it kicks in). Empty string for one-time bookings.
    const FREQ_LABELS: Record<string, string> = {
      weekly: "Weekly",
      biweekly: "Every 2 weeks",
      monthly: "Monthly",
    };
    const freqLabel = FREQ_LABELS[booking.frequency] || "";
    const recurringBanner = (booking.frequency && booking.frequency !== "one_time" && freqLabel)
      ? `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:14px 0 0">
          <tr><td align="center">
            <div style="display:inline-block;background:#e4f0e9;color:#1e4d2b;font-size:13px;font-weight:600;padding:8px 16px;border-radius:20px;letter-spacing:0.3px">
              &#128257; Recurring clean &mdash; ${escapeHtml(freqLabel)}${booking.recurring_discount_pct ? ` &middot; ${booking.recurring_discount_pct}% off` : ""}
            </div>
          </td></tr>
        </table>`
      : "";

    // ── CONFIRMED PATH (owner confirms a pending booking) ─────────────────
    if (mode === "confirmed") {
      const confirmedHtml = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f8faf8;font-family:'Helvetica Neue',Arial,sans-serif;color:#1a2e1e">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f8faf8;padding:40px 16px">
    <tr><td align="center">
      <table cellpadding="0" cellspacing="0" border="0" width="520" style="max-width:520px;background:white;border-radius:16px;overflow:hidden;border:1px solid #d4e2d8">
        <tr><td style="background:#f8faf8;padding:28px 24px;text-align:center;border-bottom:3px solid #1e4d2b">
          <img src="https://hirayaspaces.ca/logo-horizontal-bw.png" alt="Hiraya Spaces" width="320" style="display:block;margin:0 auto;max-width:100%;height:auto">
          ${recurringBanner}
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
          Hiraya Spaces · Kitchener, ON · <a href="https://hirayaspaces.ca" style="color:#1e4d2b;text-decoration:none">hirayaspaces.ca</a>
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
          <img src="https://hirayaspaces.ca/logo-horizontal-bw.png" alt="Hiraya Spaces" width="320" style="display:block;margin:0 auto;max-width:100%;height:auto">
          ${recurringBanner}
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
          Hiraya Spaces · Kitchener, ON · <a href="https://hirayaspaces.ca" style="color:#1e4d2b;text-decoration:none">hirayaspaces.ca</a>
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
        .select("id, invoice_number, status, total_cents, paid_at")
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
      const extrasTotalCents = extraServices.reduce((s: number, es: any) => s + ((es.price_cents || 0) * (es.quantity || 1)), 0);
      const addonsTotalCents = bookingAddons.reduce((s: number, ba: any) => s + ((ba.price_cents || 0) * (ba.quantity || 1)), 0);
      const lineSubtotalCents = baseCatalogCents + extrasTotalCents + addonsTotalCents;
      const additionalCents = invoiceTotal - lineSubtotalCents;
      // Build line items as structured data first so we can render to both
      // HTML (for email body) and PDF (for attachment / admin download).
      const lineItems: { name: string; priceLabel: string }[] = [];
      lineItems.push({ name: serviceName, priceLabel: dollars(baseCatalogCents) });
      // Extra services come right after the primary so they read as part of
      // the cleaning scope, before discrete add-ons.
      for (const es of extraServices) {
        const svcName = es.services?.name || "Service";
        const tierLabel = es.tier_name ? ` — ${es.tier_name}` : "";
        const qty = es.quantity > 1 ? ` × ${es.quantity}` : "";
        const lineTotal = (es.price_cents || 0) * (es.quantity || 1);
        lineItems.push({ name: svcName + tierLabel + qty, priceLabel: dollars(lineTotal) });
      }
      for (const ba of bookingAddons) {
        const baseName = ba.addons?.name || "Add-on";
        const qty = ba.quantity > 1 ? ` × ${ba.quantity}` : "";
        const lineTotal = (ba.price_cents || 0) * (ba.quantity || 1);
        lineItems.push({ name: baseName + qty, priceLabel: dollars(lineTotal) });
      }
      if (additionalCents > 0) {
        lineItems.push({ name: "Additional services provided", priceLabel: dollars(additionalCents) });
      } else if (additionalCents < 0) {
        lineItems.push({ name: "Discount", priceLabel: "-" + dollars(Math.abs(additionalCents)) });
      }
      const lineItemsHtml = lineItems.map(item =>
        `<tr><td style="padding:8px 0;color:#1a2e1e">${escapeHtml(item.name)}</td><td style="padding:8px 0;text-align:right;color:#1a2e1e">${escapeHtml(item.priceLabel)}</td></tr>`
      ).join("");

      const invoiceHtml = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f8faf8;font-family:'Helvetica Neue',Arial,sans-serif;color:#1a2e1e">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f8faf8;padding:40px 16px">
    <tr><td align="center">
      <table cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:white;border-radius:16px;overflow:hidden;border:1px solid #d4e2d8">
        <tr><td style="background:#f8faf8;padding:28px 24px;text-align:center;border-bottom:3px solid #1e4d2b">
          <img src="https://hirayaspaces.ca/logo-horizontal-bw.png" alt="Hiraya Spaces" width="320" style="display:block;margin:0 auto;max-width:100%;height:auto">
          ${recurringBanner}
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

          <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:14px">
            <tr><td align="center" style="padding:0 0 14px">
              <a href="${SUPABASE_URL}/functions/v1/pay-invoice?n=${encodeURIComponent(invoiceNumber!)}"
                 style="display:inline-block;background:#1e4d2b;color:#fff;font-weight:700;font-size:15px;letter-spacing:0.5px;text-decoration:none;padding:14px 32px;border-radius:30px">
                Pay invoice online &rarr;
              </a>
            </td></tr>
          </table>

          <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#fffbeb;border:1px solid #e5d3a0;border-radius:12px;margin-bottom:14px">
            <tr><td style="padding:16px 20px">
              <div style="font-size:11px;font-weight:700;color:#5a4318;text-transform:uppercase;letter-spacing:1.2px;margin-bottom:8px">Other ways to pay</div>
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
          Hiraya Spaces · Kitchener, ON · <a href="https://hirayaspaces.ca" style="color:#1e4d2b;text-decoration:none">hirayaspaces.ca</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

      // Build the PDF copy of the invoice. Used both as email attachment
      // AND as the response payload for the admin "Download PDF" button.
      const isPaid = (existingInv?.status === "paid") || !!existingInv?.paid_at;
      const paidDisplay = existingInv?.paid_at
        ? new Date(existingInv.paid_at).toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric" })
        : "";
      const pdfBytes = await buildInvoicePdf({
        invoiceNumber: invoiceNumber!,
        issuedDisplay,
        idShort,
        customerName,
        customerEmail,
        customerPhone,
        dateDisplay,
        timeDisplay,
        addressLine,
        lineItems,
        totalDisplay: subtotalDisplay,
        paid: isPaid,
        paidDisplay,
      });

      // Admin "Download PDF" path: don't send email, just return the bytes
      // base64-encoded so the browser can save it as a file.
      if (body?.download_pdf === true) {
        // Convert Uint8Array → base64 in chunks to avoid blowing the call
        // stack on larger PDFs (btoa(String.fromCharCode(...big)) crashes).
        let binary = "";
        const chunk = 0x8000;
        for (let i = 0; i < pdfBytes.length; i += chunk) {
          binary += String.fromCharCode(...pdfBytes.subarray(i, i + chunk));
        }
        const base64 = btoa(binary);
        return jsonResponse({
          ok: true,
          booking_id,
          mode: "invoice",
          invoice_number: invoiceNumber,
          status: invoiceStatus,
          pdf_base64: base64,
          pdf_filename: `${invoiceNumber}.pdf`,
        });
      }

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
          attachments: [{
            contentType: "application/pdf",
            filename: `${invoiceNumber}.pdf`,
            encoding: "binary",
            content: pdfBytes,
          }],
        });
      } catch (e) { console.warn("invoice email failed:", e); invErr = e; }
      try { await invClient.close(); } catch (_) {}
      if (invErr) {
        const msg = (invErr as Error)?.message || String(invErr);
        return jsonResponse({ error: "Invoice email failed", debug: msg }, 502);
      }
      return jsonResponse({ ok: true, booking_id, mode: "invoice", invoice_number: invoiceNumber, status: invoiceStatus });
    }

    // ── PAYMENT RECEIVED PATH (admin marked invoice paid) ─────────────────
    if (mode === "payment_received") {
      // Look up the existing invoice — payment can only be confirmed once an
      // invoice has been created. Marked paid is the trigger, but we still
      // verify here in case the admin marks paid → unpaid → fires this stale.
      const { data: paidInv } = await sb
        .from("invoices")
        .select("id, invoice_number, status, total_cents, paid_at, amount_cents")
        .eq("booking_id", booking_id)
        .maybeSingle();
      if (!paidInv) {
        return jsonResponse({ error: "No invoice on file for this booking" }, 400);
      }
      if (paidInv.status !== "paid") {
        return jsonResponse({ error: "Invoice is not marked paid" }, 400);
      }

      const issuedDisplay = paidInv.paid_at
        ? new Date(paidInv.paid_at).toLocaleDateString("en-CA", { month: "long", day: "numeric", year: "numeric" })
        : new Date().toLocaleDateString("en-CA", { month: "long", day: "numeric", year: "numeric" });
      const paidTotal = paidInv.total_cents ?? 0;
      const paidTotalDisplay = dollars(paidTotal);

      // Rebuild the same line items as the invoice mode so the attached PDF
      // matches the original invoice (just stamped PAID this time).
      const baseCatalogCents = (booking.services?.starting_price_cents) ?? 0;
      const extrasTotalCents = extraServices.reduce((s: number, es: any) => s + ((es.price_cents || 0) * (es.quantity || 1)), 0);
      const addonsTotalCents = bookingAddons.reduce((s: number, ba: any) => s + ((ba.price_cents || 0) * (ba.quantity || 1)), 0);
      const lineSubtotalCents = baseCatalogCents + extrasTotalCents + addonsTotalCents;
      const additionalCents = paidTotal - lineSubtotalCents;
      const lineItems: { name: string; priceLabel: string }[] = [];
      lineItems.push({ name: serviceName, priceLabel: dollars(baseCatalogCents) });
      for (const es of extraServices) {
        const svcName = es.services?.name || "Service";
        const tierLabel = es.tier_name ? ` — ${es.tier_name}` : "";
        const qty = es.quantity > 1 ? ` × ${es.quantity}` : "";
        const lineTotal = (es.price_cents || 0) * (es.quantity || 1);
        lineItems.push({ name: svcName + tierLabel + qty, priceLabel: dollars(lineTotal) });
      }
      for (const ba of bookingAddons) {
        const baseName = ba.addons?.name || "Add-on";
        const qty = ba.quantity > 1 ? ` × ${ba.quantity}` : "";
        const lineTotal = (ba.price_cents || 0) * (ba.quantity || 1);
        lineItems.push({ name: baseName + qty, priceLabel: dollars(lineTotal) });
      }
      if (additionalCents > 0) {
        lineItems.push({ name: "Additional services provided", priceLabel: dollars(additionalCents) });
      } else if (additionalCents < 0) {
        lineItems.push({ name: "Discount", priceLabel: "-" + dollars(Math.abs(additionalCents)) });
      }

      const paidHtml = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f8faf8;font-family:'Helvetica Neue',Arial,sans-serif;color:#1a2e1e">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f8faf8;padding:40px 16px">
    <tr><td align="center">
      <table cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:white;border-radius:16px;overflow:hidden;border:1px solid #d4e2d8">
        <tr><td style="background:#f8faf8;padding:28px 24px;text-align:center;border-bottom:3px solid #1e4d2b">
          <img src="https://hirayaspaces.ca/logo-horizontal-bw.png" alt="Hiraya Spaces" width="320" style="display:block;margin:0 auto;max-width:100%;height:auto">
          ${recurringBanner}
        </td></tr>
        <tr><td style="padding:36px 30px 20px">
          <div style="display:inline-block;background:#1e4d2b;color:white;font-size:11px;font-weight:800;letter-spacing:1.5px;padding:6px 14px;border-radius:6px;margin-bottom:14px">PAYMENT RECEIVED</div>
          <h1 style="font-family:Georgia,'Cormorant Garamond',serif;font-weight:400;font-size:28px;margin:0 0 10px;color:#1a2e1e">Thank you, ${escapeHtml(customerName)}!</h1>
          <p style="font-size:14px;color:#6a7d6e;line-height:1.7;margin:0 0 24px">
            We've received your payment for invoice <strong style="color:#1e4d2b">${escapeHtml(paidInv.invoice_number)}</strong>. A copy of the paid invoice is attached for your records.
          </p>

          <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#e4f0e9;border:1px solid #5a9470;border-radius:12px;margin-bottom:20px">
            <tr><td style="padding:18px 22px">
              <div style="font-size:11px;font-weight:700;color:#1e4d2b;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:12px">Payment summary</div>
              <table cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:14px;color:#1a2e1e">
                <tr><td style="padding:4px 0;color:#6a7d6e">Invoice</td><td style="padding:4px 0;text-align:right;font-weight:600">${escapeHtml(paidInv.invoice_number)}</td></tr>
                <tr><td style="padding:4px 0;color:#6a7d6e">Service date</td><td style="padding:4px 0;text-align:right">${escapeHtml(dateDisplay)}</td></tr>
                <tr><td style="padding:4px 0;color:#6a7d6e">Paid on</td><td style="padding:4px 0;text-align:right">${escapeHtml(issuedDisplay)}</td></tr>
                <tr><td style="padding:8px 0 0;border-top:1px solid #5a9470;font-weight:700;font-size:15px">Amount paid</td><td style="padding:8px 0 0;border-top:1px solid #5a9470;text-align:right;font-weight:700;color:#1e4d2b;font-size:18px">${escapeHtml(paidTotalDisplay)}</td></tr>
              </table>
            </td></tr>
          </table>

          <p style="font-size:13px;color:#6a7d6e;line-height:1.7;margin:0 0 8px">
            Want another clean? Book any time at <a href="https://hirayaspaces.ca/#booking" style="color:#1e4d2b;font-weight:600;text-decoration:none">hirayaspaces.ca</a> — or just reply to this email.
          </p>
          <p style="font-size:12px;color:#6a7d6e;line-height:1.7;margin:14px 0 0">
            Questions about the receipt? Reply here or call (226) 751-4566.
          </p>
        </td></tr>
        <tr><td style="background:#f0f5f1;padding:18px 30px;text-align:center;font-size:11px;color:#6a7d6e;border-top:1px solid #d4e2d8">
          Hiraya Spaces · Kitchener, ON · <a href="https://hirayaspaces.ca" style="color:#1e4d2b;text-decoration:none">hirayaspaces.ca</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

      // Generate the PAID-stamped PDF copy.
      const paidPdfBytes = await buildInvoicePdf({
        invoiceNumber: paidInv.invoice_number,
        issuedDisplay,
        idShort,
        customerName,
        customerEmail,
        customerPhone,
        dateDisplay,
        timeDisplay,
        addressLine,
        lineItems,
        totalDisplay: paidTotalDisplay,
        paid: true,
        paidDisplay: issuedDisplay,
      });

      const smtpPortPaid = parseInt(Deno.env.get("SMTP_PORT") || "465");
      const paidClient = new SMTPClient({
        connection: {
          hostname: Deno.env.get("SMTP_HOST") || "smtp.gmail.com",
          port: smtpPortPaid, tls: smtpPortPaid === 465,
          auth: { username: Deno.env.get("SMTP_USER")!, password: Deno.env.get("SMTP_PASS")! },
        },
      });
      let paidErr: unknown = null;
      try {
        await paidClient.send({
          from: Deno.env.get("SMTP_FROM") || Deno.env.get("SMTP_USER")!,
          to: customerEmail,
          subject: `Payment received — ${paidInv.invoice_number}`,
          html: tidyHtml(paidHtml),
          attachments: [{
            contentType: "application/pdf",
            filename: `${paidInv.invoice_number}-paid.pdf`,
            encoding: "binary",
            content: paidPdfBytes,
          }],
        });
      } catch (e) { console.warn("payment_received email failed:", e); paidErr = e; }
      try { await paidClient.close(); } catch (_) {}
      if (paidErr) {
        const msg = (paidErr as Error)?.message || String(paidErr);
        return jsonResponse({ error: "Payment receipt email failed", debug: msg }, 502);
      }
      return jsonResponse({ ok: true, booking_id, mode: "payment_received", invoice_number: paidInv.invoice_number });
    }

    // ── CHECKED-IN PATH (cleaner just arrived) ────────────────────────────
    if (mode === "checked_in") {
      const arrivedAt = booking.check_in_at
        ? new Date(booking.check_in_at).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" })
        : "";
      const checkedInHtml = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f8faf8;font-family:'Helvetica Neue',Arial,sans-serif;color:#1a2e1e">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f8faf8;padding:40px 16px">
    <tr><td align="center">
      <table cellpadding="0" cellspacing="0" border="0" width="520" style="max-width:520px;background:white;border-radius:16px;overflow:hidden;border:1px solid #d4e2d8">
        <tr><td style="background:#f8faf8;padding:28px 24px;text-align:center;border-bottom:3px solid #1e4d2b">
          <img src="https://hirayaspaces.ca/logo-horizontal-bw.png" alt="Hiraya Spaces" width="320" style="display:block;margin:0 auto;max-width:100%;height:auto">
          ${recurringBanner}
        </td></tr>
        <tr><td style="padding:36px 30px 20px">
          <div style="display:inline-block;background:#3b82a8;color:white;font-size:11px;font-weight:800;letter-spacing:1.5px;padding:6px 14px;border-radius:6px;margin-bottom:14px">CLEANER ON SITE</div>
          <h1 style="font-family:Georgia,'Cormorant Garamond',serif;font-weight:400;font-size:28px;margin:0 0 10px;color:#1a2e1e">We've arrived, ${escapeHtml(customerName.split(' ')[0])}!</h1>
          <p style="font-size:14px;color:#6a7d6e;line-height:1.7;margin:0 0 24px">
            Your cleaner just checked in${arrivedAt ? ` at ${escapeHtml(arrivedAt)}` : ""} for booking <strong style="color:#1e4d2b">${idShort}</strong>. You'll get another note when we wrap up.
          </p>

          <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#e0eef7;border:1px solid #3b82a8;border-radius:12px;margin-bottom:18px">
            <tr><td style="padding:18px 22px">
              <div style="font-size:11px;font-weight:600;color:#2b5a73;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:12px">Today's clean</div>
              <table cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:14px;color:#1a2e1e">
                <tr><td style="padding:5px 0;color:#6a7d6e">Service</td><td style="padding:5px 0;text-align:right;font-weight:600">${escapeHtml(serviceName)}</td></tr>
                <tr><td style="padding:5px 0;color:#6a7d6e">Address</td><td style="padding:5px 0;text-align:right">${escapeHtml(addressLine)}</td></tr>
              </table>
            </td></tr>
          </table>

          <p style="font-size:12px;color:#6a7d6e;line-height:1.7;margin:0">
            Need to flag anything to us mid-clean? Just reply to this email or call (226) 751-4566.
          </p>
        </td></tr>
        <tr><td style="background:#f0f5f1;padding:18px 30px;text-align:center;font-size:11px;color:#6a7d6e;border-top:1px solid #d4e2d8">
          Hiraya Spaces · Kitchener, ON · <a href="https://hirayaspaces.ca" style="color:#1e4d2b;text-decoration:none">hirayaspaces.ca</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

      const smtpPortCi = parseInt(Deno.env.get("SMTP_PORT") || "465");
      const ciClient = new SMTPClient({
        connection: {
          hostname: Deno.env.get("SMTP_HOST") || "smtp.gmail.com",
          port: smtpPortCi, tls: smtpPortCi === 465,
          auth: { username: Deno.env.get("SMTP_USER")!, password: Deno.env.get("SMTP_PASS")! },
        },
      });
      let ciErr: unknown = null;
      try {
        await ciClient.send({
          from: Deno.env.get("SMTP_FROM") || Deno.env.get("SMTP_USER")!,
          to: customerEmail,
          subject: `Your cleaner has arrived - ${idShort}`,
          html: tidyHtml(checkedInHtml),
        });
      } catch (e) { console.warn("checked_in email failed:", e); ciErr = e; }
      try { await ciClient.close(); } catch (_) {}
      if (ciErr) {
        const msg = (ciErr as Error)?.message || String(ciErr);
        return jsonResponse({ error: "Checked-in email failed", debug: msg }, 502);
      }
      return jsonResponse({ ok: true, booking_id, mode: "checked_in" });
    }

    // ── REMINDER PATH (24h before a confirmed clean) ──────────────────────
    if (mode === "reminder") {
      const reminderHtml = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f8faf8;font-family:'Helvetica Neue',Arial,sans-serif;color:#1a2e1e">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f8faf8;padding:40px 16px">
    <tr><td align="center">
      <table cellpadding="0" cellspacing="0" border="0" width="520" style="max-width:520px;background:white;border-radius:16px;overflow:hidden;border:1px solid #d4e2d8">
        <tr><td style="background:#f8faf8;padding:28px 24px;text-align:center;border-bottom:3px solid #1e4d2b">
          <img src="https://hirayaspaces.ca/logo-horizontal-bw.png" alt="Hiraya Spaces" width="320" style="display:block;margin:0 auto;max-width:100%;height:auto">
          ${recurringBanner}
        </td></tr>
        <tr><td style="padding:36px 30px 20px">
          <div style="display:inline-block;background:#1e4d2b;color:white;font-size:11px;font-weight:800;letter-spacing:1.5px;padding:6px 14px;border-radius:6px;margin-bottom:14px">TOMORROW</div>
          <h1 style="font-family:Georgia,'Cormorant Garamond',serif;font-weight:400;font-size:28px;margin:0 0 10px;color:#1a2e1e">See you tomorrow, ${escapeHtml(customerName.split(' ')[0])}!</h1>
          <p style="font-size:14px;color:#6a7d6e;line-height:1.7;margin:0 0 24px">
            Just a friendly heads up — your clean is on the schedule for tomorrow. Here are the details so nothing slips by:
          </p>

          <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#e4f0e9;border:1px solid #5a9470;border-radius:12px;margin-bottom:18px">
            <tr><td style="padding:18px 22px">
              <div style="font-size:11px;font-weight:600;color:#1e4d2b;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:12px">Your booking</div>
              <table cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:14px;color:#1a2e1e">
                <tr><td style="padding:5px 0;color:#6a7d6e">Service</td><td style="padding:5px 0;text-align:right;font-weight:600">${escapeHtml(serviceName)}</td></tr>
                <tr><td style="padding:5px 0;color:#6a7d6e">When</td><td style="padding:5px 0;text-align:right;font-weight:600">${escapeHtml(dateDisplay)}${timeDisplay ? " at " + escapeHtml(timeDisplay) : ""}</td></tr>
                <tr><td style="padding:5px 0;color:#6a7d6e">Address</td><td style="padding:5px 0;text-align:right">${escapeHtml(addressLine)}</td></tr>
              </table>
            </td></tr>
          </table>

          <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#fffbeb;border:1px solid #e5d3a0;border-radius:12px;margin-bottom:14px">
            <tr><td style="padding:16px 20px">
              <div style="font-size:13px;color:#5a4318;line-height:1.7">
                <strong style="color:#3d2c0d">Before we arrive:</strong> tidy any loose items so we can focus on the deep clean, and let us know about pets, alarm codes, or parking. Just reply to this email.
              </div>
            </td></tr>
          </table>

          <p style="font-size:12px;color:#6a7d6e;line-height:1.7;margin:0">
            Need to change anything? Reply to this email or call (226) 751-4566. Cancellations within 24 hours are subject to a $45 fee.
          </p>
        </td></tr>
        <tr><td style="background:#f0f5f1;padding:18px 30px;text-align:center;font-size:11px;color:#6a7d6e;border-top:1px solid #d4e2d8">
          Hiraya Spaces · Kitchener, ON · <a href="https://hirayaspaces.ca" style="color:#1e4d2b;text-decoration:none">hirayaspaces.ca</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

      const smtpPortRem = parseInt(Deno.env.get("SMTP_PORT") || "465");
      const remClient = new SMTPClient({
        connection: {
          hostname: Deno.env.get("SMTP_HOST") || "smtp.gmail.com",
          port: smtpPortRem, tls: smtpPortRem === 465,
          auth: { username: Deno.env.get("SMTP_USER")!, password: Deno.env.get("SMTP_PASS")! },
        },
      });
      let remErr: unknown = null;
      try {
        await remClient.send({
          from: Deno.env.get("SMTP_FROM") || Deno.env.get("SMTP_USER")!,
          to: customerEmail,
          subject: `Your Hiraya clean is tomorrow - ${idShort}`,
          html: tidyHtml(reminderHtml),
        });
      } catch (e) { console.warn("reminder email failed:", e); remErr = e; }
      try { await remClient.close(); } catch (_) {}
      if (remErr) {
        const msg = (remErr as Error)?.message || String(remErr);
        return jsonResponse({ error: "Reminder email failed", debug: msg }, 502);
      }
      // Stamp reminder_sent_at so the cron job doesn't pick this up again.
      const { error: stampErr } = await sb.from("bookings")
        .update({ reminder_sent_at: new Date().toISOString() })
        .eq("id", booking_id);
      if (stampErr) {
        console.warn("reminder_sent_at update failed:", stampErr.message);
      }
      return jsonResponse({ ok: true, booking_id, mode: "reminder" });
    }

    // ── RESCHEDULED PATH (admin moved date/time) ──────────────────────────
    if (mode === "rescheduled") {
      // Old slot is passed in the request body — we can't pull it from the
      // booking row anymore because it's already been overwritten.
      const oldDateRaw = typeof body?.old_date === "string" ? body.old_date : "";
      const oldTime = typeof body?.old_time_slot === "string" ? body.old_time_slot : "";
      const oldDateDisplay = oldDateRaw
        ? new Date(oldDateRaw).toLocaleDateString("en-CA", { month: "long", day: "numeric", year: "numeric" })
        : "";
      const oldLine = oldDateDisplay
        ? `${escapeHtml(oldDateDisplay)}${oldTime ? " at " + escapeHtml(oldTime) : ""}`
        : "your previously-scheduled time";
      const newLine = `${escapeHtml(dateDisplay)}${timeDisplay ? " at " + escapeHtml(timeDisplay) : ""}`;

      const rescheduledHtml = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f8faf8;font-family:'Helvetica Neue',Arial,sans-serif;color:#1a2e1e">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f8faf8;padding:40px 16px">
    <tr><td align="center">
      <table cellpadding="0" cellspacing="0" border="0" width="520" style="max-width:520px;background:white;border-radius:16px;overflow:hidden;border:1px solid #d4e2d8">
        <tr><td style="background:#f8faf8;padding:28px 24px;text-align:center;border-bottom:3px solid #1e4d2b">
          <img src="https://hirayaspaces.ca/logo-horizontal-bw.png" alt="Hiraya Spaces" width="320" style="display:block;margin:0 auto;max-width:100%;height:auto">
          ${recurringBanner}
        </td></tr>
        <tr><td style="padding:36px 30px 20px">
          <div style="display:inline-block;background:#1e4d2b;color:white;font-size:11px;font-weight:800;letter-spacing:1.5px;padding:6px 14px;border-radius:6px;margin-bottom:14px">RESCHEDULED</div>
          <h1 style="font-family:Georgia,'Cormorant Garamond',serif;font-weight:400;font-size:28px;margin:0 0 10px;color:#1a2e1e">We've moved your clean, ${escapeHtml(customerName.split(' ')[0])}</h1>
          <p style="font-size:14px;color:#6a7d6e;line-height:1.7;margin:0 0 24px">
            Booking <strong style="color:#1e4d2b">${idShort}</strong> has been rescheduled. If the new time doesn't work, just reply to this email and we'll find another slot.
          </p>

          <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#fffbeb;border:1px solid #e5d3a0;border-radius:12px;margin-bottom:14px">
            <tr><td style="padding:16px 20px">
              <div style="font-size:11px;font-weight:700;color:#5a4318;text-transform:uppercase;letter-spacing:1.2px;margin-bottom:8px">Was</div>
              <div style="font-size:14px;color:#3d2c0d;text-decoration:line-through">${oldLine}</div>
            </td></tr>
          </table>

          <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#e4f0e9;border:1px solid #5a9470;border-radius:12px;margin-bottom:18px">
            <tr><td style="padding:18px 22px">
              <div style="font-size:11px;font-weight:700;color:#1e4d2b;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:8px">Now</div>
              <div style="font-size:16px;font-weight:600;color:#1a2e1e;margin-bottom:10px">${newLine}</div>
              <div style="font-size:13px;color:#6a7d6e;line-height:1.6">
                ${escapeHtml(serviceName)}<br>
                ${escapeHtml(addressLine)}
              </div>
            </td></tr>
          </table>

          <p style="font-size:12px;color:#6a7d6e;line-height:1.7;margin:0">
            Need this changed again? Reply to this email or call (226) 751-4566. Thanks for being flexible.
          </p>
        </td></tr>
        <tr><td style="background:#f0f5f1;padding:18px 30px;text-align:center;font-size:11px;color:#6a7d6e;border-top:1px solid #d4e2d8">
          Hiraya Spaces · Kitchener, ON · <a href="https://hirayaspaces.ca" style="color:#1e4d2b;text-decoration:none">hirayaspaces.ca</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

      const smtpPortRsch = parseInt(Deno.env.get("SMTP_PORT") || "465");
      const rschClient = new SMTPClient({
        connection: {
          hostname: Deno.env.get("SMTP_HOST") || "smtp.gmail.com",
          port: smtpPortRsch, tls: smtpPortRsch === 465,
          auth: { username: Deno.env.get("SMTP_USER")!, password: Deno.env.get("SMTP_PASS")! },
        },
      });
      let rschErr: unknown = null;
      try {
        await rschClient.send({
          from: Deno.env.get("SMTP_FROM") || Deno.env.get("SMTP_USER")!,
          to: customerEmail,
          subject: `Booking rescheduled - ${idShort}`,
          html: tidyHtml(rescheduledHtml),
        });
      } catch (e) { console.warn("rescheduled email failed:", e); rschErr = e; }
      try { await rschClient.close(); } catch (_) {}
      if (rschErr) {
        const msg = (rschErr as Error)?.message || String(rschErr);
        return jsonResponse({ error: "Rescheduled email failed", debug: msg }, 502);
      }
      return jsonResponse({ ok: true, booking_id, mode: "rescheduled" });
    }

    // ── UPDATED PATH (admin manually edited a booking) ────────────────────
    if (mode === "updated") {
      const updatedHtml = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f8faf8;font-family:'Helvetica Neue',Arial,sans-serif;color:#1a2e1e">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f8faf8;padding:40px 16px">
    <tr><td align="center">
      <table cellpadding="0" cellspacing="0" border="0" width="520" style="max-width:520px;background:white;border-radius:16px;overflow:hidden;border:1px solid #d4e2d8">
        <tr><td style="background:#f8faf8;padding:28px 24px;text-align:center;border-bottom:3px solid #1e4d2b">
          <img src="https://hirayaspaces.ca/logo-horizontal-bw.png" alt="Hiraya Spaces" width="320" style="display:block;margin:0 auto;max-width:100%;height:auto">
          ${recurringBanner}
        </td></tr>
        <tr><td style="padding:36px 30px 20px">
          <div style="display:inline-block;background:#1e4d2b;color:white;font-size:11px;font-weight:800;letter-spacing:1.5px;padding:6px 14px;border-radius:6px;margin-bottom:14px">BOOKING UPDATED</div>
          <h1 style="font-family:Georgia,'Cormorant Garamond',serif;font-weight:400;font-size:28px;margin:0 0 10px;color:#1a2e1e">Heads up, ${escapeHtml(customerName.split(' ')[0])}</h1>
          <p style="font-size:14px;color:#6a7d6e;line-height:1.7;margin:0 0 24px">
            We've made a change to your upcoming booking <strong style="color:#1e4d2b">${idShort}</strong>. Here are the current details — please reply to this email if anything looks off.
          </p>

          <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#e4f0e9;border:1px solid #5a9470;border-radius:12px;margin-bottom:18px">
            <tr><td style="padding:20px 22px">
              <div style="font-size:11px;font-weight:600;color:#1e4d2b;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:14px">Current details</div>
              <table cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:14px;color:#1a2e1e;margin-bottom:12px">
                <tr><td style="padding:5px 0;color:#6a7d6e">Service</td><td style="padding:5px 0;text-align:right;font-weight:600">${escapeHtml(serviceName)}</td></tr>
                <tr><td style="padding:5px 0;color:#6a7d6e">Date</td><td style="padding:5px 0;text-align:right;font-weight:600">${escapeHtml(dateDisplay)}${timeDisplay ? " at " + escapeHtml(timeDisplay) : ""}</td></tr>
                <tr><td style="padding:5px 0;color:#6a7d6e">Address</td><td style="padding:5px 0;text-align:right">${escapeHtml(addressLine)}</td></tr>
              </table>
              <div style="border-top:1px solid #5a9470;padding-top:10px;font-size:13px;color:#1a2e1e">
                <strong style="color:#6a7d6e;font-size:11px;text-transform:uppercase;letter-spacing:1.2px">Main service</strong>
                <div style="margin:6px 0 12px;font-weight:600">${escapeHtml(serviceName)}</div>
                <strong style="color:#6a7d6e;font-size:11px;text-transform:uppercase;letter-spacing:1.2px">Add-ons</strong>
                ${addonsHtml}
              </div>
              <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:14px;padding-top:12px;border-top:1px solid #5a9470">
                <tr>
                  <td style="font-size:15px;font-weight:700">Estimated total</td>
                  <td style="font-size:17px;font-weight:700;color:#1e4d2b;text-align:right">${escapeHtml(totalDisplay)}</td>
                </tr>
              </table>
            </td></tr>
          </table>

          <p style="font-size:12px;color:#6a7d6e;line-height:1.7;margin:0">
            Questions or need to change something? Just reply to this email or call (226) 751-4566.
          </p>
        </td></tr>
        <tr><td style="background:#f0f5f1;padding:18px 30px;text-align:center;font-size:11px;color:#6a7d6e;border-top:1px solid #d4e2d8">
          Hiraya Spaces · Kitchener, ON · <a href="https://hirayaspaces.ca" style="color:#1e4d2b;text-decoration:none">hirayaspaces.ca</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

      const smtpPortUpd = parseInt(Deno.env.get("SMTP_PORT") || "465");
      const updClient = new SMTPClient({
        connection: {
          hostname: Deno.env.get("SMTP_HOST") || "smtp.gmail.com",
          port: smtpPortUpd, tls: smtpPortUpd === 465,
          auth: { username: Deno.env.get("SMTP_USER")!, password: Deno.env.get("SMTP_PASS")! },
        },
      });
      let updErr: unknown = null;
      try {
        await updClient.send({
          from: Deno.env.get("SMTP_FROM") || Deno.env.get("SMTP_USER")!,
          to: customerEmail,
          subject: `Booking updated - ${idShort}`,
          html: tidyHtml(updatedHtml),
        });
      } catch (e) { console.warn("updated email failed:", e); updErr = e; }
      try { await updClient.close(); } catch (_) {}
      if (updErr) {
        const msg = (updErr as Error)?.message || String(updErr);
        return jsonResponse({ error: "Updated email failed", debug: msg }, 502);
      }
      return jsonResponse({ ok: true, booking_id, mode: "updated" });
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
          <img src="https://hirayaspaces.ca/logo-horizontal-bw.png" alt="Hiraya Spaces" width="320" style="display:block;margin:0 auto;max-width:100%;height:auto">
          ${recurringBanner}
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
          Hiraya Spaces · Kitchener, ON · <a href="https://hirayaspaces.ca" style="color:#1e4d2b;text-decoration:none">hirayaspaces.ca</a>
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
          <img src="https://hirayaspaces.ca/logo-horizontal-bw.png" alt="Hiraya Spaces" width="320" style="display:block;margin:0 auto;max-width:100%;height:auto">
          ${recurringBanner}
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
          Hiraya Spaces · Kitchener, ON · <a href="https://hirayaspaces.ca" style="color:#1e4d2b;text-decoration:none">hirayaspaces.ca</a>
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
              <td valign="middle" width="150">
                <img src="https://hirayaspaces.ca/logo-horizontal-bw.png" alt="Hiraya Spaces" width="130" style="display:block;max-width:100%;height:auto">
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
          <img src="https://hirayaspaces.ca/logo-horizontal-bw.png" alt="Hiraya Spaces" width="320" style="display:block;margin:0 auto;max-width:100%;height:auto">
          ${recurringBanner}
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
          Hiraya Spaces · Kitchener, ON · <a href="https://hirayaspaces.ca" style="color:#1e4d2b;text-decoration:none">hirayaspaces.ca</a>
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
              <td valign="middle" width="150">
                <img src="https://hirayaspaces.ca/logo-horizontal-bw.png" alt="Hiraya Spaces" width="130" style="display:block;max-width:100%;height:auto">
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
              <div style="font-size:10px;font-weight:700;color:#1e4d2b;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Main service</div>
              <div style="font-size:13px;color:#1a2e1e;line-height:1.5;font-weight:600;margin-bottom:12px">${escapeHtml(serviceName)}</div>
              <div style="font-size:10px;font-weight:700;color:#1e4d2b;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;border-top:1px solid #d4e2d8;padding-top:10px">Add-ons</div>
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
