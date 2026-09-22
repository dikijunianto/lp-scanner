export const number = (v: number | null | undefined, digits = 2) =>
  v == null ? "—" : new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(v);
export const usd = (v: number | null | undefined) =>
  v == null
    ? "—"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        notation: Math.abs(v) >= 10000 ? "compact" : "standard",
        maximumFractionDigits: 2,
      }).format(v);
export const percent = (v: number | null | undefined) =>
  v == null ? "—" : `${v > 0 ? "+" : ""}${number(v)}%`;
export const efficiency = (v: number | null | undefined) =>
  v == null ? "—" : `${number(v * 100, 4)}%`;
export const multiple = (v: number | null | undefined) => (v == null ? "—" : `${number(v)}×`);
export const price = (v: number | null | undefined) =>
  v == null
    ? "—"
    : v === 0
      ? "0"
      : new Intl.NumberFormat("en-US", { maximumSignificantDigits: 6 }).format(v);
export const age = (hours: number | null) =>
  hours == null ? "Unknown" : hours < 48 ? `${number(hours, 1)}h` : `${number(hours / 24, 1)}d`;
