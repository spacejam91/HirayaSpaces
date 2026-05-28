// Daily DB backup — dumps every operational table to CSV and emails the
// attachments to the Hiraya inbox. Cheap insurance against an accidental
// wipe on Free tier (where Supabase doesn't run nightly backups).
//
// Deploy: supabase functions deploy cron-backup --no-verify-jwt
// Schedule: see hiraya-schema.sql / cron snippet in the deploy notes.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET") || "";
const BACKUP_TO = Deno.env.get("BACKUP_TO") || "hirayaspaces@gmail.com";

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

// Convert a row array to a CSV string. JSON-stringifies objects so jsonb
// columns survive a round-trip. Empty input gets a placeholder header so
// the file is still valid + obvious which table is empty.
function rowsToCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "(empty table)\n";
  const headers = Object.keys(rows[0]);
  const escapeCell = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    let s = typeof v === "object" ? JSON.stringify(v) : String(v);
    if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => escapeCell((row as any)[h])).join(","));
  }
  return lines.join("\n") + "\n";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);

  if (CRON_SECRET) {
    const provided = req.headers.get("x-cron-secret") || "";
    if (provided !== CRON_SECRET) {
      return jsonResponse({ error: "forbidden" }, 403);
    }
  }

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Tables backed up. Order doesn't matter for restoration since we use raw
  // dumps (no FK ordering needed when restoring via INSERT…ON CONFLICT or
  // manual import — the data is the point, not the SQL).
  const tables = [
    "bookings",
    "booking_addons",
    "booking_services",
    "invoices",
    "customer_meta",
    "addresses",
    "profiles",
    "blocked_dates",
    "services",
    "addons",
  ];

  const dateStr = new Date().toISOString().slice(0, 10);
  const attachments: Array<{ contentType: string; filename: string; encoding: string; content: Uint8Array }> = [];
  const counts: Record<string, number | string> = {};
  let totalRows = 0;

  for (const t of tables) {
    try {
      const { data, error } = await sb.from(t).select("*");
      if (error) {
        console.warn(`backup ${t} failed:`, error);
        counts[t] = `error: ${error.message}`;
        continue;
      }
      const rows = (data || []) as Record<string, unknown>[];
      const csv = rowsToCsv(rows);
      attachments.push({
        contentType: "text/csv",
        filename: `${t}-${dateStr}.csv`,
        encoding: "binary",
        content: new TextEncoder().encode(csv),
      });
      counts[t] = rows.length;
      totalRows += rows.length;
    } catch (e) {
      console.warn(`backup ${t} threw:`, e);
      counts[t] = `threw: ${(e as Error).message}`;
    }
  }

  // No attachments at all means everything failed — bail loudly.
  if (!attachments.length) {
    return jsonResponse({ error: "No tables backed up", counts }, 500);
  }

  const summaryHtml = `<!DOCTYPE html>
<html><body style="font-family:Helvetica,Arial,sans-serif;color:#1a2e1e;background:#f8faf8;padding:24px">
  <h2 style="font-family:Georgia,serif;font-weight:400;margin:0 0 12px">Hiraya daily backup &mdash; ${dateStr}</h2>
  <p style="font-size:14px;color:#3a4a3e">${attachments.length} table${attachments.length === 1 ? "" : "s"} backed up, ${totalRows} total rows. CSVs attached.</p>
  <table cellpadding="0" cellspacing="0" style="font-size:13px;border-collapse:collapse;margin-top:14px">
    ${Object.entries(counts).map(([t, n]) =>
      `<tr><td style="padding:6px 16px 6px 0;color:#6a7d6e">${t}</td><td style="padding:6px 0"><strong>${n}</strong></td></tr>`
    ).join("")}
  </table>
  <p style="font-size:12px;color:#6a7d6e;margin-top:18px">To restore: open each CSV in the Supabase Table Editor or via psql \\COPY. Triggered by the daily pg_cron job.</p>
</body></html>`;

  const smtpPort = parseInt(Deno.env.get("SMTP_PORT") || "465");
  const client = new SMTPClient({
    connection: {
      hostname: Deno.env.get("SMTP_HOST") || "smtp.gmail.com",
      port: smtpPort,
      tls: smtpPort === 465,
      auth: {
        username: Deno.env.get("SMTP_USER")!,
        password: Deno.env.get("SMTP_PASS")!,
      },
    },
  });

  // BACKUP_TO can be a single email or comma-separated list (e.g. all 3 admins).
  const recipients = BACKUP_TO.split(",").map((s) => s.trim()).filter(Boolean);
  let sendErr: unknown = null;
  try {
    await client.send({
      from: Deno.env.get("SMTP_FROM") || Deno.env.get("SMTP_USER")!,
      to: recipients.length === 1 ? recipients[0] : recipients,
      subject: `Hiraya backup ${dateStr} — ${totalRows} rows across ${attachments.length} tables`,
      html: summaryHtml,
      attachments,
    });
  } catch (e) {
    console.error("backup email failed:", e);
    sendErr = e;
  }
  try { await client.close(); } catch (_) {}

  if (sendErr) {
    return jsonResponse({
      error: "Backup email failed",
      debug: (sendErr as Error)?.message || String(sendErr),
      counts,
      totalRows,
    }, 502);
  }

  return jsonResponse({
    date: dateStr,
    tables_backed_up: attachments.length,
    total_rows: totalRows,
    counts,
    sent_to: BACKUP_TO,
  });
});
