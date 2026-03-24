const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;

export type SendSmsResult = { ok: true } | { ok: false; error: string };

export async function sendSms(to: string, body: string): Promise<SendSmsResult> {
  const normalized = to.replace(/\D/g, "");
  const toE164 = normalized.startsWith("61") ? `+${normalized}` : `+61${normalized}`;

  if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_PHONE_NUMBER) {
    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          To: toE164,
          From: TWILIO_PHONE_NUMBER,
          Body: body,
        }),
      },
    );
    if (res.ok) return { ok: true };
    const errText = await res.text();
    console.error("[sms] Twilio API error:", res.status, errText.slice(0, 500));
    return { ok: false, error: errText || `HTTP ${res.status}` };
  }
  console.warn("[sms] Twilio not configured (missing TWILIO_* in env); SMS not sent:", { to: toE164 });
  if (process.env.NODE_ENV === "production") {
    return {
      ok: false,
      error:
        "SMS not configured (set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER in backend .env)",
    };
  }
  console.log("[DEV] SMS (no Twilio):", { to: toE164, body });
  return { ok: true };
}
