// Tracking emails are sent through Resend. Required server secrets:
// RESEND_API_KEY and RESEND_FROM.

export async function sendEmail(opts: {
  to: string;
  subject: string;
  body: string;
}): Promise<{ ok: boolean; providerResponse: unknown; error?: string }> {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("RESEND_FROM");
  if (!apiKey || !from) {
    return {
      ok: false,
      error: "Email is not configured on the server. Set RESEND_API_KEY and RESEND_FROM in Supabase secrets; a local .env file is not uploaded automatically.",
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
    return { ok: res.ok, providerResponse: data, ...(res.ok ? {} : {error: emailFailure(res.status, data)}) };
  } catch (err) {
    return { ok: false, error: "Could not reach the email provider or the request timed out. Check provider logs before retrying.", providerResponse: { error: String(err) } };
  }
}

// Return actionable descriptions rather than raw provider payloads or credentials.
function emailFailure(status: number, data: Record<string, unknown>): string {
  const message=String(data.message || data.error || '').toLowerCase();
  if(message.includes('testing emails') || message.includes('own email address')) return 'Resend test sending is restricted to your account email. Verify a sender domain in Resend to email other recipients.';
  if(message.includes('domain') && (message.includes('verif') || message.includes('not found'))) return 'The sending domain is not verified in Resend. Verify the domain and set RESEND_FROM to an address on that domain.';
  if(status===401 || message.includes('api key') || message.includes('api_key')) return 'Resend rejected the API key. Update RESEND_API_KEY in Supabase secrets with an active sending key.';
  if(status===429) return 'Resend rate or sending limit reached. Check your Resend usage before retrying.';
  if(status===422 || status===400) return 'Resend rejected the email details. Check RESEND_FROM and the recipient email address.';
  if(status===403) return 'Resend denied sending. Check API key permissions, sender verification and recipient restrictions in Resend.';
  return `Email provider rejected the request (HTTP ${status}). Check the Resend logs for details.`;
}
