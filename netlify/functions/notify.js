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
 *
 * Optional:
 *   NOTIFY_REPLY_TO  where replies should land. Defaults to Carson's real
 *                    working inbox, because carsoncalin.com has no MX records
 *                    and a reply to a send-only address would bounce.
 */

const SUPABASE_URL = "https://vnqicwaslxynefzyvvjo.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_niTtBPiLg9trvKnZXwXGhA_uQ_Ry9lZ";
const ADMIN_EMAIL = "carsoncalin@livindyrealty.com";
const PORTAL_URL = "https://portal.carsoncalin.com";

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

/* Email HTML is deliberately old fashioned: tables, inline styles, no images,
   no web fonts. Gmail strips much of what a browser accepts, and a broken
   image placeholder in the first email a client ever gets looks careless.
   Fraunces cannot be relied on in mail, so headings use Georgia, the closest
   system serif to the portal's voice that renders everywhere. */
const SERIF = "Georgia,'Times New Roman',Times,serif";
const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const PHONE = "+13179035973";
/* iOS Mail is inconsistent about sms: links carrying a leading plus and
   country code, while tel: handles it fine. Same number, no plus, for SMS. */
const PHONE_SMS = "3179035973";
const PHONE_PRETTY = "(317) 903-5973";

/* The message itself renders in the email, so a client who never taps
   through has still received it. Blank lines become paragraphs, single
   line breaks become breaks, everything escaped first. */
function bodyHtml(body) {
  const text = String(body == null ? "" : body).trim();
  if (!text) return "";
  return text
    .split(/\n\s*\n/)
    .map(
      (p) =>
        `<p style="margin:0 0 15px;font-family:${SANS};font-size:15.5px;line-height:1.62;color:#1b2426;">${esc(p).replace(/\n/g, "<br>")}</p>`
    )
    .join("");
}

/* Bulletproof stacked button. Height and padding are set so the tap target
   clears 48px, and the radius sits on both the cell and the anchor so Gmail
   and Apple Mail agree on the shape. */
function button({ href, label, bg, color, border }) {
  /* target=_blank is only meaningful for web links. On sms: and tel: it asks
     the mail client to hand a non-web scheme to a browser, which is where iOS
     Mail drops the Messages handoff. */
  const target = /^https?:/i.test(href) ? ' target="_blank"' : "";
  return `<tr><td align="center" bgcolor="${bg}" height="52" style="background-color:${bg};border-radius:12px;${border ? "border:2px solid " + border + ";" : ""}">
    <a href="${esc(href)}"${target} style="display:block;padding:16px 18px;font-family:${SANS};font-size:16px;font-weight:bold;line-height:20px;color:${color};text-decoration:none;border-radius:12px;">${esc(label)}</a>
  </td></tr>
  <tr><td height="12" style="height:12px;line-height:12px;font-size:0;">&nbsp;</td></tr>`;
}

/* TEMPORARY DIAGNOSTIC. Apple Mail refuses the sms: link that works fine in
   the portal and in a browser, so this renders every plausible variant to
   find which one Mail actually honours. Triggered only by a message titled
   "SMS TEST", so no client can ever see it. Delete once we know the answer. */
function smsTestHtml() {
  const variants = [
    ["A", "sms:3179035973", "no plus, ten digits"],
    ["B", "sms:+13179035973", "plus and country code"],
    ["C", "sms://3179035973", "double slash"],
    ["D", "sms:/3179035973", "single slash"],
    ["E", "sms:+1-317-903-5973", "dashes in the number"],
    ["F", "sms:3179035973?body=Hi%20Carson", "with a prefilled body"],
  ];
  const rows = variants
    .map(
      ([k, href, note]) =>
        `<tr><td align="center" bgcolor="#1b2426" height="52" style="background-color:#1b2426;border-radius:12px;">
          <a href="${href}" style="display:block;padding:15px 18px;font-family:${SANS};font-size:15px;font-weight:bold;line-height:20px;color:#ffffff;text-decoration:none;border-radius:12px;">${k}. ${esc(note)}</a>
        </td></tr>
        <tr><td height="10" style="height:10px;line-height:10px;font-size:0;">&nbsp;</td></tr>`
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>
    <p style="margin:6px 0 0;font-family:${SANS};font-size:15px;line-height:1.6;color:#1b2426;text-align:center;">G. plain text, no link: <b>${PHONE_PRETTY}</b></p>
    <p style="margin:14px 0 0;font-family:${SANS};font-size:13px;line-height:1.6;color:#4a5a5d;">Tap each one and tell me which letters open Messages.</p>`;
}

function emailHtml({ title, body, address, portalUrl }) {
  const smsTest = /^sms\s*test$/i.test(String(title || "").trim());
  const where = address ? " on " + esc(address) : "";
  const plain = String(body == null ? "" : body).replace(/\s+/g, " ").trim();
  const preheader = plain
    ? plain.length > 140
      ? plain.slice(0, 140).replace(/\s+\S*$/, "")
      : plain
    : "Carson posted an update" + where + ".";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>${esc(title)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f5f1ea;-webkit-text-size-adjust:100%;">
  <div style="display:none;font-size:1px;color:#f5f1ea;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${esc(preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f5f1ea;">
    <tr><td align="center" style="padding:28px 14px 34px;">

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;">

        <tr><td style="padding:0 4px 14px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
            <td width="30" height="30" align="center" valign="middle" bgcolor="#0e9fb0" style="border-radius:9px;font-family:${SERIF};font-size:15px;font-weight:bold;color:#04282c;">C</td>
            <td style="padding-left:10px;font-family:${SANS};font-size:11px;font-weight:bold;letter-spacing:1.4px;text-transform:uppercase;color:#4a5a5d;">Carson's Concierge</td>
          </tr></table>
        </td></tr>

        <tr><td bgcolor="#ffffff" style="background-color:#ffffff;border:1px solid #e6ded2;border-radius:18px;padding:28px 26px 30px;">

          <p style="margin:0 0 12px;font-family:${SANS};font-size:11px;font-weight:bold;letter-spacing:1.2px;text-transform:uppercase;color:#0a7a87;">New update</p>

          <h1 style="margin:0 0 14px;font-family:${SERIF};font-size:23px;font-weight:normal;line-height:1.3;color:#1b2426;">${esc(title)}</h1>

          ${bodyHtml(body)}

          <p style="margin:22px 0 20px;padding-top:18px;border-top:1px solid #e6ded2;font-family:${SANS};font-size:13.5px;line-height:1.55;color:#4a5a5d;">Your full timeline, documents and dates are in Carson's Concierge, the app on your home screen. Or just reach me directly, whichever is easier.</p>

          ${smsTest ? smsTestHtml() : `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            ${button({ href: "sms:" + PHONE_SMS, label: "Text Carson", bg: "#1b2426", color: "#ffffff" })}
            ${button({ href: "tel:" + PHONE, label: "Call Carson", bg: "#ffffff", color: "#1b2426", border: "#1b2426" })}
          </table>`}

          <p style="margin:2px 0 20px;font-family:${SANS};font-size:15px;line-height:1.6;color:#1b2426;text-align:center;">Or text or call me anytime at <b>${PHONE_PRETTY}</b></p>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
            <td bgcolor="#f5f1ea" style="background-color:#f5f1ea;border-radius:12px;padding:16px 18px;">
              <p style="margin:0 0 8px;font-family:${SANS};font-size:11px;font-weight:bold;letter-spacing:1.2px;text-transform:uppercase;color:#0a7a87;">Not saved to your phone yet?</p>
              <p style="margin:0 0 10px;font-family:${SANS};font-size:13px;line-height:1.6;color:#4a5a5d;">Set it up once and your portal lives on your home screen like an app, so you never hunt for a link again.</p>
              <p style="margin:0 0 6px;font-family:${SANS};font-size:13px;line-height:1.6;color:#1b2426;"><b>On an iPhone</b>, open <a href="${esc(portalUrl)}" style="color:#0a7a87;text-decoration:underline;">portal.carsoncalin.com</a> in Safari, tap the Share icon in the bar at the bottom of your screen, then tap Add to Home Screen.</p>
              <p style="margin:0;font-family:${SANS};font-size:13px;line-height:1.6;color:#1b2426;"><b>On an Android phone</b>, open that same address, then your browser menu, the three dots in the corner, and tap Install app.</p>
            </td>
          </tr></table>

          <p style="margin:20px 0 0;font-family:${SANS};font-size:12px;line-height:1.55;color:#4a5a5d;">You are receiving this because Carson is handling your transaction. You can turn these emails off anytime under Portal settings.</p>

        </td></tr>

        <tr><td align="center" style="padding:18px 4px 0;font-family:${SANS};font-size:10px;letter-spacing:1.1px;text-transform:uppercase;color:#94a0a2;">
          Carson Calin, REALTOR<span style="font-size:8px;vertical-align:super;">&reg;</span> &nbsp;&middot;&nbsp; Brokered by eXp Realty
        </td></tr>

      </table>

    </td></tr>
  </table>
</body>
</html>`;
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
  const { client_id, title, body } = payload;
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
    const portalUrl = PORTAL_URL;
    const html = emailHtml({ title, body, address: client.property_address, portalUrl });
    const subject = client.property_address
      ? `New update on ${client.property_address}`
      : "New update from Carson Calin";

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
              reply_to: process.env.NOTIFY_REPLY_TO || ADMIN_EMAIL,
              subject,
              html,
              text: `${title}\n\n${String(body || "").trim()}\n\nYour full timeline, documents and dates are in Carson's Concierge, the app on your home screen.\n\nOr reach me directly. Text or call ${PHONE_PRETTY}.\n\nNOT SAVED TO YOUR PHONE YET?\nSet it up once and your portal lives on your home screen like an app. On an iPhone, open ${portalUrl} in Safari, tap the Share icon at the bottom of your screen, then tap Add to Home Screen. On an Android phone, open that same address, then your browser menu, and tap Install app.\n\nYou can turn these emails off anytime under Portal settings.\nCarson Calin, REALTOR. Brokered by eXp Realty.`,
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
