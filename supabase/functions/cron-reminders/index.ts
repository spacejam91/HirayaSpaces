// Daily cron — fires the 24-hour reminder email to every customer whose
// confirmed booking is scheduled for "tomorrow" in Eastern (America/Toronto)
// time. Invoked once a day by pg_cron + pg_net.
//
// Deploy:
//   supabase functions deploy cron-reminders
// Set the shared secret (used as a defense-in-depth check on top of JWT):
//   supabase secrets set CRON_SECRET=<random-hex-string>
// Schedule (SQL editor, Role: postgres) — see ../../../docs/cron-setup.sql

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET") || "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info, x-cron-secret",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);

  // Defense-in-depth: require the shared CRON_SECRET in addition to the JWT.
  // pg_cron sends it as the x-cron-secret header.
  if (CRON_SECRET) {
    const provided = req.headers.get("x-cron-secret") || "";
    if (provided !== CRON_SECRET) {
      return jsonResponse({ error: "forbidden" }, 403);
    }
  }

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Compute tomorrow's date in the business's timezone (America/Toronto).
  // pg_cron runs in UTC, so we explicitly convert.
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const tomorrowStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(tomorrow);

  // Find every confirmed booking scheduled for that date.
  const { data: bookings, error: queryErr } = await sb
    .from("bookings")
    .select("id, status, preferred_date")
    .eq("status", "confirmed")
    .eq("preferred_date", tomorrowStr);

  if (queryErr) {
    console.error("cron-reminders query failed:", queryErr);
    return jsonResponse({ error: queryErr.message }, 500);
  }

  if (!bookings || !bookings.length) {
    return jsonResponse({ date: tomorrowStr, total: 0, succeeded: 0, failed: 0 });
  }

  // Fire reminder emails in parallel by calling the existing send-booking-email
  // function. The function handles email building + anti-abuse + delivery.
  const results = await Promise.allSettled(bookings.map(async (b) => {
    const resp = await fetch(`${SUPABASE_URL}/functions/v1/send-booking-email`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
        "apikey": SERVICE_ROLE_KEY,
      },
      body: JSON.stringify({ booking_id: b.id, mode: "reminder" }),
    });
    const text = await resp.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch (_) { /* keep raw */ }
    if (!resp.ok) {
      throw new Error(`status ${resp.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
    }
    return { booking_id: b.id, result: body };
  }));

  const succeeded = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.length - succeeded;
  const details = results.map((r, i) => ({
    booking_id: bookings[i].id,
    ok: r.status === "fulfilled",
    error: r.status === "rejected" ? String((r as PromiseRejectedResult).reason) : null,
  }));

  return jsonResponse({
    date: tomorrowStr,
    total: bookings.length,
    succeeded,
    failed,
    details,
  });
});
