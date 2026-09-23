// Real email + SMS senders. Email goes through Resend, SMS through Termii
// (good delivery for Nigerian numbers; swap sendSms's body for Africa's
// Talking or another provider if you prefer — everything else in the app
// only cares that this returns { ok, providerResponse }).
//
// Required secrets (set with `supabase secrets set ...`, see README):
//   RESEND_API_KEY, RESEND_FROM      — e.g. RESEND_FROM="Stallionking Tracker <tracking@yourdomain.com>"
//   TERMII_API_KEY, TERMII_SENDER_ID — Termii sender IDs must be registered/approved in the Termii dashboard first

export async function sendEmail(opts: {
  to: string;
  subject: string;
  body: string;
}): Promise<{ ok: boolean; providerResponse: unknown }> {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("RESEND_FROM");
  if (!apiKey || !from) {
    return {
      ok: false,
      providerResponse: { error: "RESEND_API_KEY / RESEND_FROM not configured" },
    };
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      signal: AbortSignal.timeout(10000),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [opts.to],
        subject: opts.subject,
        text: opts.body,
      }),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, providerResponse: data };
  } catch (err) {
    return { ok: false, providerResponse: { error: String(err) } };
  }
}

export async function sendSms(opts: {
  to: string;
  body: string;
}): Promise<{ ok: boolean; providerResponse: unknown }> {
  const apiKey = Deno.env.get("TERMII_API_KEY");
  const senderId = Deno.env.get("TERMII_SENDER_ID");
  if (!apiKey || !senderId) {
    return {
      ok: false,
      providerResponse: { error: "TERMII_API_KEY / TERMII_SENDER_ID not configured" },
    };
  }

  try {
    const res = await fetch("https://api.ng.termii.com/api/sms/send", {
      method: "POST",
      signal: AbortSignal.timeout(10000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: normalizeNigerianPhone(opts.to),
        from: senderId,
        sms: opts.body,
        type: "plain",
        channel: "generic",
        api_key: apiKey,
      }),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, providerResponse: data };
  } catch (err) {
    return { ok: false, providerResponse: { error: String(err) } };
  }
}

// Best-effort normalization of Nigerian numbers written as "080..." or
// "+234..." or "234..." into the 234XXXXXXXXXX shape most local SMS
// providers expect. Leaves anything that doesn't look Nigerian alone.
function normalizeNigerianPhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+234")) return digits.slice(1);
  if (digits.startsWith("234")) return digits;
  if (digits.startsWith("0") && digits.length === 11) return "234" + digits.slice(1);
  return digits;
}
