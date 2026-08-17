const DISPLAY_INTERVAL_MS = 5 * 60 * 1000;

const exactFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Berlin",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

const roundedFormatter = new Intl.DateTimeFormat("de-DE", {
  timeZone: "Europe/Berlin",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function formatExactMealTime(isoTimestamp: string | null): string {
  if (!isoTimestamp) return "";
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.valueOf())) return "";
  const parts = Object.fromEntries(exactFormatter.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.hour}:${parts.minute}:${parts.second}`;
}

export function formatRoundedMealTime(isoTimestamp: string | null): string {
  if (!isoTimestamp) return "";
  const value = new Date(isoTimestamp).valueOf();
  if (Number.isNaN(value)) return "";
  const rounded = new Date(Math.round(value / DISPLAY_INTERVAL_MS) * DISPLAY_INTERVAL_MS);
  return `${roundedFormatter.format(rounded)} Uhr`;
}

export function formatElapsedSinceMeal(isoTimestamp: string | null, now = Date.now()): string {
  if (!isoTimestamp) return "";
  const mealTime = new Date(isoTimestamp).valueOf();
  if (Number.isNaN(mealTime)) return "";

  const totalMinutes = Math.max(0, Math.floor((now - mealTime) / 60_000));
  if (totalMinutes < 1) return "Gerade eben";

  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];

  if (days > 0) parts.push(`${days} ${days === 1 ? "Tag" : "Tage"}`);
  if (hours > 0) parts.push(`${hours} Std.`);
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes} Min.`);

  return parts.join(" ");
}
