import { Availability } from "@prisma/client";

const compact = (value: string): string => value.toLowerCase().replace(/[\s_-]/g, "");
const OUT_OF_STOCK_PHRASES = ["outofstock", "soldout", "discontinued", "unavailable", "backinstock"];
const IN_STOCK_PHRASES = ["instock", "limitedavailability", "onlineonly"];

export type AvailabilitySignals = { outOfStock: boolean; inStock: boolean; preOrder: boolean; backOrder: boolean };

// Which stock phrases a piece of text contains. "back in stock" is stripped before the in-stock
// check so "Notify me when back in stock" does not read as available.
export function availabilitySignals(value: string): AvailabilitySignals {
  const normalized = compact(value);
  const withoutRestock = normalized.replace(/backinstock/g, "");
  return {
    outOfStock: OUT_OF_STOCK_PHRASES.some((phrase) => normalized.includes(phrase)),
    inStock: IN_STOCK_PHRASES.some((phrase) => withoutRestock.includes(phrase)) || normalized === "available",
    preOrder: normalized.includes("preorder"),
    backOrder: normalized.includes("backorder"),
  };
}

// Explicit stock statements outrank pre-order/backorder mentions, which often live in product titles
// ("Pre-Order Sony Bundle…") rather than describing the current status.
export function normalizeAvailability(value?: string | null): Availability {
  if (!value) return Availability.UNKNOWN;
  const signals = availabilitySignals(value);
  if (signals.outOfStock) return Availability.OUT_OF_STOCK;
  if (signals.inStock) return Availability.IN_STOCK;
  if (signals.preOrder) return Availability.PREORDER;
  if (signals.backOrder) return Availability.BACKORDER;
  return Availability.UNKNOWN;
}
