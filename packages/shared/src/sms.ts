import "dotenv/config";

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;

export async function sendSms(to: string, body: string): Promise<boolean> {
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
    return res.ok;
  }
  console.log("[DEV] SMS (no Twilio):", { to: toE164, body });
  return true;
}
