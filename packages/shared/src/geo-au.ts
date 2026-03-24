/** Infer Australian state/territory code from a free-text address (pickup/dropoff). */
export function inferAuStateFromLocationText(text: string | null | undefined): string | null {
  if (!text || typeof text !== "string") return null;
  const t = text.toUpperCase();
  const pairs: [RegExp, string][] = [
    [/\b(NSW|NEW SOUTH WALES)\b/, "NSW"],
    [/\b(VIC|VICTORIA)\b/, "VIC"],
    [/\b(QLD|QUEENSLAND)\b/, "QLD"],
    [/\b(WA|WESTERN AUSTRALIA)\b/, "WA"],
    [/\b(SA|SOUTH AUSTRALIA)\b/, "SA"],
    [/\b(TAS|TASMANIA)\b/, "TAS"],
    [/\b(NT|NORTHERN TERRITORY)\b/, "NT"],
    [/\b(ACT|AUSTRALIAN CAPITAL TERRITORY)\b/, "ACT"],
  ];
  for (const [re, code] of pairs) {
    if (re.test(t)) return code;
  }
  return null;
}
