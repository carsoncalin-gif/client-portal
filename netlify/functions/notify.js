/* Emails the people on a transaction when Carson posts a message to them.
 *
 * Why this exists: the portal is static files, so nothing in the browser can
 * send mail without holding a credential that anyone could read by viewing
 * source. This runs on Netlify instead, where the key stays private.
 *
 * Deliberately does NOT use a Supabase service_role key. It forwards Carson's
 * own login token and reads the database as him, which his existing row level
 * security already permits. A service_role key would bypass every rule in the
 * database, so the safest thing is never to create that risk at all.
 *
 * Required environment variables, set in Netlify, never in this repo:
 *   RESEND_API_KEY   a send-capable key from resend.com
 *   NOTIFY_FROM      e.g. "Carson Calin <carson@carsoncalin.com>", at a
 *                    domain verified in Resend
 */

const SUPABASE_URL = "https://vnqicwaslxynefzyvvjo.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_niTtBPiLg9trvKnZXwXGhA_uQ_Ry9lZ";
const ADMIN_EMAIL = "carsoncalin@livindyrealty.com";

const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m])
  );
}

function emailHtml({ title, address, portalUrl }) {
  const where = address ? " on " + esc(address) : "";
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f5f1ea;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f1ea;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border:1px solid #e6ded2;border-radius:18px;padding:30px 28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
        <tr><td>
          <div style="font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#4a5a5d;">Carson's Concierge</div>
          <div style="font-size:21px;font-weight:600;color:#1b2426;line-height:1.3;margin:14px 0 6px;">${esc(title)}</div>
          <div style="font-size:14.5px;color:#4a5a5d;line-height:1.5;">Carson posted an update${where}. Open your portal to read it.</div>
          <div style="margin:24px 0 6px;">
            <a href="${esc(portalUrl)}" style="display:inline-block;background:#1b2426;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 26px;border-radius:11px;">Open your portal</a>
          </div>
          <div style="font-size:12px;color:#4a5a5d;line-height:1.5;margin-top:22px;border-top:1px solid #e6ded2;padding-top:16px;">
            You are getting this because Carson is handling your transaction. You can turn these off anytime under Portal settings.
          </div>
        </td></tr>
      </table>
      <div style="font-size:10.5px;color:#8a9698;letter-spacing:.06em;text-transform:uppercase;margin-top:16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">Brokered by eXp Realty</div>
    </td></tr>
  </table>
</body></html>`;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Use POST" });

  // Auth first, deliberately. Nobody unauthenticated should learn anything
  // about this site's configuration, not even whether email is switched on.
  const auth = event.headers.authorization || event.headers.Authorization || "";
  if (!auth.startsWith("Bearer ")) return json(401, { error: "Not signed in" });

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.NOTIFY_FROM;

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (e) {
    return json(400, { error: "Bad request body" });
  }
  const { client_id, title } = payload;
  if (!client_id || !title) return json(400, { error: "client_id and title are required" });

  const sbHeaders = { apikey: SUPABASE_ANON_KEY, Authorization: auth };

  try {
    // 1. Confirm the caller really is Carson. Anyone can hit this URL.
    const meRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: sbHeaders });
    if (!meRes.ok) return json(401, { error: "Could not verify who you are" });
    const me = await meRes.json();
    if ((me.email || "").toLowerCase() !== ADMIN_EMAIL) {
      return json(403, { error: "Not allowed" });
    }

    // Confirmed it is Carson, so it is safe to report configuration state.
    if (!apiKey || !from) {
      return json(503, { error: "Email is not configured yet", sent: 0 });
    }

    // 2. Read the transaction as Carson. Row level security still applies.
    const cRes = await fetch(
      `${SUPABASE_URL}/rest/v1/clients?id=eq.${encodeURIComponent(client_id)}&select=client_name,email,email2,property_address`,
      { headers: sbHeaders }
    );
    if (!cRes.ok) return json(502, { error: "Could not load that client" });
    const rows = await cRes.json();
    if (!rows.length) return json(404, { error: "Client not found" });
    const client = rows[0];

    const recipients = [client.email, client.email2]
      .map((e) => (e || "").trim().toLowerCase())
      .filter(Boolean);
    if (!recipients.length) {
      return json(200, {
        sent: 0,
        reason:
          "This client has no email address saved. email=" +
          JSON.stringify(client.email) +
          ", email2=" +
          JSON.stringify(client.email2),
      });
    }

    // 3. Drop anyone who has switched these emails off. No preferences row
    //    means they have never changed anything, so they stay opted in.
    const list = recipients.map((e) => `"${e}"`).join(",");
    const pRes = await fetch(
      `${SUPABASE_URL}/rest/v1/preferences?email=in.(${encodeURIComponent(list)})&select=email,notify_email`,
      { headers: sbHeaders }
    );
    const optedOut = new Set();
    let prefLookupFailed = false;
    if (pRes.ok) {
      const prefs = await pRes.json();
      prefs.forEach((p) => {
        if (p.notify_email === false) optedOut.add((p.email || "").trim().toLowerCase());
      });
    } else {
      prefLookupFailed = true;
    }
    const toSend = recipients.filter((e) => !optedOut.has(e));
    if (!toSend.length) {
      return json(200, {
        sent: 0,
        found: recipients,
        reason: "Everyone on this deal turned these emails off: " + [...optedOut].join(", "),
      });
    }

    // 4. Send. Title and a button only, the message itself stays in the portal.
    const portalUrl = process.env.URL || "https://portal.carsoncalin.com";
    const html = emailHtml({ title, address: client.property_address, portalUrl });
    const subject = client.property_address
      ? `Update on ${client.property_address}`
      : "An update from Carson";

    // Keep whatever Resend says when it refuses. Only Carson can reach this
    // endpoint, so surfacing the real reason is safe and saves guessing.
    const results = await Promise.all(
      toSend.map(async (to) => {
        try {
          const r = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              from,
              to,
              subject,
              html,
              text: `Carson posted an update${client.property_address ? " on " + client.property_address : ""}: ${title}\n\nOpen your portal: ${portalUrl}`,
            }),
          });
          if (r.ok) return { ok: true };
          let detail = "HTTP " + r.status;
          try {
            const j = await r.json();
            detail = j.message || j.error || detail;
          } catch (e) {}
          return { ok: false, detail };
        } catch (e) {
          return { ok: false, detail: String((e && e.message) || e) };
        }
      })
    );

    const sent = results.filter((r) => r.ok).length;
    const errors = [...new Set(results.filter((r) => !r.ok).map((r) => r.detail))];
    return json(200, {
      sent,
      attempted: toSend.length,
      found: recipients,
      skipped: [...optedOut],
      prefLookupFailed,
      errors,
      from,
    });
  } catch (e) {
    return json(500, { error: "Something went wrong sending the email" });
  }
};
