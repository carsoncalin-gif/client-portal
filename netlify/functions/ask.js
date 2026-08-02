/* Sends Carson a question a client wrote in their portal.
 *
 * Mirrors notify.js, but the other direction and with the opposite audience:
 * notify.js is Carson only, this one is for any signed-in client. It still
 * verifies the caller against Supabase rather than trusting the browser, and
 * it reads the client's own row as them, so row level security decides what
 * they are allowed to reference.
 *
 * Uses the same RESEND_API_KEY and NOTIFY_FROM already set in Netlify.
 */

const SUPABASE_URL = "https://vnqicwaslxynefzyvvjo.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_niTtBPiLg9trvKnZXwXGhA_uQ_Ry9lZ";
const ADMIN_EMAIL = "carsoncalin@livindyrealty.com";
const MAX_MESSAGE = 4000;

const TOPICS = {
  question: "A question about my transaction",
  showing: "Request a showing",
  document: "Request a document",
  other: "Something else",
};

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

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Use POST" });

  const auth = event.headers.authorization || event.headers.Authorization || "";
  if (!auth.startsWith("Bearer ")) return json(401, { error: "Not signed in" });

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (e) {
    return json(400, { error: "Bad request body" });
  }
  const topicKey = String(payload.topic || "other");
  const topic = TOPICS[topicKey] || TOPICS.other;
  const message = String(payload.message || "").trim().slice(0, MAX_MESSAGE);
  if (!message) return json(400, { error: "Please write a message first" });

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.NOTIFY_FROM;
  const sbHeaders = { apikey: SUPABASE_ANON_KEY, Authorization: auth };

  try {
    // Who is actually asking. Never trust an email sent from the browser.
    const meRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: sbHeaders });
    if (!meRes.ok) return json(401, { error: "Could not verify who you are" });
    const me = await meRes.json();
    const asker = (me.email || "").toLowerCase();
    if (!asker) return json(401, { error: "Could not verify who you are" });

    if (!apiKey || !from) return json(503, { error: "Messaging is not switched on yet" });

    // Read their own deal as them, so RLS decides what they may reference.
    let who = asker;
    let where = "";
    try {
      const cRes = await fetch(
        `${SUPABASE_URL}/rest/v1/clients?select=client_name,property_address&or=(email.ilike.${encodeURIComponent(asker)},email2.ilike.${encodeURIComponent(asker)})`,
        { headers: sbHeaders }
      );
      if (cRes.ok) {
        const rows = await cRes.json();
        if (rows.length) {
          if (rows[0].client_name) who = rows[0].client_name + " (" + asker + ")";
          if (rows[0].property_address) where = rows[0].property_address;
        }
      }
    } catch (e) {}

    const subject = where ? `${topic}, ${where}` : `${topic} from ${asker}`;
    const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1b2426;">
      <p style="margin:0 0 4px;"><b>From:</b> ${esc(who)}</p>
      ${where ? `<p style="margin:0 0 4px;"><b>Property:</b> ${esc(where)}</p>` : ""}
      <p style="margin:0 0 16px;"><b>Topic:</b> ${esc(topic)}</p>
      <div style="border-left:3px solid #0e9fb0;padding-left:14px;white-space:pre-wrap;">${esc(message)}</div>
      <p style="margin:18px 0 0;font-size:13px;color:#4a5a5d;">Sent from Carson's Concierge. Reply to this email to answer them directly.</p>
    </div>`;

    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: ADMIN_EMAIL,
        reply_to: asker,
        subject,
        html,
        text: `From: ${who}\n${where ? "Property: " + where + "\n" : ""}Topic: ${topic}\n\n${message}\n\nReply to this email to answer them directly.`,
      }),
    });
    if (!r.ok) {
      let detail = "HTTP " + r.status;
      try {
        const j = await r.json();
        detail = j.message || j.error || detail;
      } catch (e) {}
      return json(502, { error: "Could not send that", detail });
    }
    return json(200, { sent: true });
  } catch (e) {
    return json(500, { error: "Something went wrong sending that" });
  }
};
