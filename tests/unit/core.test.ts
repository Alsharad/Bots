import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePrice, detectCurrency } from "../../lib/price";
import { normalizeAvailability } from "../../lib/availability";
import { analyzeHtml } from "../../lib/detection";
import { isPrivateAddress } from "../../lib/security";
import { renderTemplate } from "../../lib/notifications";
import { detectChanges } from "../../lib/change-detection";
import { Availability } from "@prisma/client";
import { botSchema } from "../../lib/validation";

describe("price parsing", () => {
  it("normalizes common formats into minor units", () => { expect(parsePrice("$12.99")).toBe(1299); expect(parsePrice("$1,299.00")).toBe(129900); expect(parsePrice("€ 1.299,95", "EUR")).toBe(129995); });
  it("detects currency", () => expect(detectCurrency("Only £19.95")).toBe("GBP"));
});
describe("availability", () => {
  it("normalizes schema values", () => { expect(normalizeAvailability("https://schema.org/InStock")).toBe("IN_STOCK"); expect(normalizeAvailability("SoldOut")).toBe("OUT_OF_STOCK"); expect(normalizeAvailability("PreOrder")).toBe("PREORDER"); });
  it("prefers explicit stock statements over pre-order mentions in titles", () => { expect(normalizeAvailability("Pre-Order Sony Bundle PlayStation 5 Pro In Stock")).toBe("IN_STOCK"); expect(normalizeAvailability("Pre-Order Sony Bundle Out of stock online")).toBe("OUT_OF_STOCK"); });
  it("does not read a restock prompt as available", () => expect(normalizeAvailability("Notify me when back in stock")).toBe("OUT_OF_STOCK"));
});
const staticMetaPage = (badge: string) => readFileSync(join(__dirname, "../fixtures/static-meta-product.html"), "utf8").replace("STATUS_BADGE", badge);
describe("availability inference", () => {
  it("ignores stock phrases inside script data blobs", () => expect(analyzeHtml(staticMetaPage("In Stock"), "https://e.test/p")).toMatchObject({ availability: "IN_STOCK", priceMinor: 27890, currency: "KWD", detectionMethod: "META_TAG" }));
  it("lets unambiguous visible text override static InStock metadata", () => expect(analyzeHtml(staticMetaPage("Out of stock online"), "https://e.test/p").availability).toBe("OUT_OF_STOCK"));
  it("handles untranslated server-rendered status keys", () => { expect(analyzeHtml(staticMetaPage("pdp_product_outofstock_label"), "https://e.test/p").availability).toBe("OUT_OF_STOCK"); expect(analyzeHtml(staticMetaPage("pdp_product_inStock_label"), "https://e.test/p").availability).toBe("IN_STOCK"); });
  it("keeps metadata when visible text is ambiguous", () => expect(analyzeHtml(staticMetaPage("In stock. Similar item: Out of stock"), "https://e.test/p").availability).toBe("IN_STOCK"));
  it("honors an availability selector without a price selector", () => expect(analyzeHtml(staticMetaPage("Sold out"), "https://e.test/p", { availability: "span.typography-small" }).availability).toBe("OUT_OF_STOCK"));
  it("honors explicit stock phrases", () => { expect(analyzeHtml(staticMetaPage("Ships in 2 days"), "https://e.test/p", { inStockText: "ships in" }).availability).toBe("IN_STOCK"); expect(analyzeHtml(staticMetaPage("Coming soon"), "https://e.test/p", { outOfStockText: "coming soon" }).availability).toBe("OUT_OF_STOCK"); });
  it("still infers from plain page text when no metadata exists", () => expect(analyzeHtml("<body><h1>Drill</h1><p>Sold out</p></body>", "https://e.test/p").availability).toBe("OUT_OF_STOCK"));
});
describe("structured extraction", () => {
  it("extracts a JSON-LD product", () => { const result = analyzeHtml(`<script type="application/ld+json">{"@type":"Product","name":"Drill","image":"https://e.test/a.jpg","offers":{"@type":"Offer","price":"99.00","priceCurrency":"USD","availability":"https://schema.org/InStock"}}</script>`, "https://e.test/p"); expect(result).toMatchObject({ title: "Drill", priceMinor: 9900, availability: "IN_STOCK", detectionMethod: "JSON_LD" }); });
  it("extracts a numeric price from a nested PriceSpecification", () => {
    const result = analyzeHtml(`<script type="application/ld+json">{"@type":"Product","name":"Cloud Gateway Max NS","offers":{"@type":"Offer","availability":"https://schema.org/InStock","priceSpecification":{"@type":"PriceSpecification","price":199,"priceCurrency":"USD"}}}</script>`, "https://store.ui.com/product");
    expect(result).toMatchObject({ title: "Cloud Gateway Max NS", priceMinor: 19900, currency: "USD", availability: "IN_STOCK", detectionMethod: "JSON_LD" });
  });
  it("selects the priced entry from offer and price-specification arrays", () => {
    const result = analyzeHtml(`<script type="application/ld+json">{"@type":"Product","name":"Router","offers":[{"@type":"Offer","availability":"https://schema.org/OutOfStock"},{"@type":"Offer","availability":"https://schema.org/InStock","priceSpecification":[{"@type":"PriceSpecification"},{"@type":"PriceSpecification","price":"499.00","priceCurrency":"USD"}]}]}</script>`, "https://e.test/router");
    expect(result).toMatchObject({ priceMinor: 49900, currency: "USD", availability: "IN_STOCK" });
  });
});
describe("SSRF guard", () => { it("blocks private ranges", () => { ["127.0.0.1","10.0.0.1","172.16.1.1","192.168.1.1","169.254.1.1","::1"].forEach((ip) => expect(isPrivateAddress(ip)).toBe(true)); expect(isPrivateAddress("8.8.8.8")).toBe(false); }); });
describe("templates", () => { it("renders known variables", () => expect(renderTemplate("{{productName}} is {{availability}}", { productName: "Drill", availability: "available" })).toBe("Drill is available")); });
describe("change alerts", () => {
  const rules = { notifyOnPriceDrop: true, notifyOnTargetPrice: false, targetPriceMinor: null, notifyOnAvailable: true, notifyOnUnavailable: false, notifyOnPriceIncrease: false, notifyOnProductChange: true, minimumChangeMinor: 100, minimumChangePercent: 5 };
  it("honors amount and percentage thresholds", () => expect(detectChanges({ priceMinor: 10000, availability: Availability.IN_STOCK }, { priceMinor: 9000, availability: Availability.IN_STOCK }, rules).map((event) => event.type)).toContain("PRICE_DROP"));
  it("detects variant changes", () => expect(detectChanges({ priceMinor: 10000, availability: Availability.IN_STOCK, variantValue: "Black" }, { priceMinor: 10000, availability: Availability.IN_STOCK, variantValue: "White" }, rules).map((event) => event.type)).toContain("PRODUCT_CHANGED"));
});
describe("uptime monitors", () => {
  it("requires a port for TCP targets", () => {
    const result = botSchema.safeParse({
      name: "Server", url: "tcp://server.example.com", hostname: "server.example.com", monitorKind: "TCP",
      enabled: true, checkIntervalMinutes: 5, browserMode: false, notifyOnPriceDrop: false, notifyOnTargetPrice: false,
      notifyOnAvailable: false, notifyOnUnavailable: false, notifyOnPriceIncrease: false, minimumChangeMinor: 1,
      minimumChangePercent: 0, confirmationCount: 1, notificationCooldownMinutes: 60, pageLoadDelayMs: 0,
    });
    expect(result.success).toBe(false);
  });
  it("accepts an HTTP latency monitor", () => {
    const result = botSchema.safeParse({
      name: "Website", url: "https://example.com", hostname: "example.com", monitorKind: "HTTP",
      latencyThresholdMs: 750, enabled: true, checkIntervalMinutes: 1, browserMode: false, notifyOnPriceDrop: false,
      notifyOnTargetPrice: false, notifyOnAvailable: false, notifyOnUnavailable: false, notifyOnPriceIncrease: false,
      minimumChangeMinor: 1, minimumChangePercent: 0, confirmationCount: 1, notificationCooldownMinutes: 60, pageLoadDelayMs: 0,
    });
    expect(result.success).toBe(true);
  });
});
