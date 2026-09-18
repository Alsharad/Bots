import { prisma } from "./prisma";
import { fetchProduct } from "./fetch-product";
import { detectChanges } from "./change-detection";
import { sendNotification } from "./notifications";
import { Availability, DetectionMethod, EventType, MonitorKind } from "@prisma/client";
import { checkHttp, checkTcp, getCertificateExpiry, resolveAddresses } from "./uptime";

function nextCheckAt(bot: { monitorKind: MonitorKind; checkIntervalMinutes: number; checkIntervalSeconds: number }) {
  const delayMs = bot.monitorKind === MonitorKind.PRODUCT ? bot.checkIntervalMinutes * 60_000 : bot.checkIntervalSeconds * 1_000;
  return new Date(Date.now() + delayMs);
}

async function deliverEvents(botId: string, stateId: string, target: string) {
  const createdEvents = await prisma.notificationEvent.findMany({ where: { currentStateId: stateId } });
  if (!createdEvents.length) return;
  const channels = await prisma.botNotificationChannel.findMany({ where: { botId, notificationChannel: { enabled: true } }, include: { notificationChannel: true } });
  for (const event of createdEvents) {
    for (const link of channels) {
      try {
        const delivery = await sendNotification(link.notificationChannel.type, link.notificationChannel.configurationEncrypted, `${event.message}\n\nOpen target: ${target}`);
        await prisma.notificationDelivery.create({ data: { notificationEventId: event.id, notificationChannelId: link.notificationChannelId, successful: true, responseStatus: delivery.status, responseBody: delivery.responseBody } });
      } catch (deliveryError) {
        await prisma.notificationDelivery.create({ data: { notificationEventId: event.id, notificationChannelId: link.notificationChannelId, successful: false, error: deliveryError instanceof Error ? deliveryError.message : "Delivery failed." } });
      }
    }
  }
}

export async function checkBot(id: string) {
  const bot = await prisma.bot.findUnique({ where: { id }, include: { states: { where: { successful: true }, orderBy: { checkedAt: "desc" }, take: 10 } } });
  if (!bot) throw new Error("Bot not found.");
  if (bot.monitorKind === MonitorKind.VALUE) throw new Error("Webpage value monitors are no longer supported.");
  if (bot.monitorKind !== MonitorKind.PRODUCT) {
    const result = bot.monitorKind === MonitorKind.HTTP
      ? await checkHttp(bot.url, bot.expectedContent)
      : await checkTcp(bot.hostname, bot.tcpPort ?? 80);
    const prior = bot.states[0] ?? null;
    let dnsAddresses: string[] | null = null;
    let sslExpiresAt: Date | null = null;
    const diagnostics: string[] = [];
    if (bot.dnsMonitoring) {
      try { dnsAddresses = await resolveAddresses(bot.hostname); } catch (error) { diagnostics.push(`DNS check failed: ${error instanceof Error ? error.message : "unknown error"}`); }
    }
    if (bot.sslMonitoring && bot.monitorKind === MonitorKind.HTTP && new URL(bot.url).protocol === "https:") {
      try { sslExpiresAt = await getCertificateExpiry(bot.hostname, Number(new URL(bot.url).port || 443)); } catch (error) { diagnostics.push(`SSL check failed: ${error instanceof Error ? error.message : "unknown error"}`); }
    }
    const failureCount = result.reachable ? 0 : bot.consecutiveErrors + 1;
    const confirmed = result.reachable || failureCount >= bot.failureConfirmationCount;
    const state = await prisma.productState.create({ data: {
      botId: id,
      availability: result.reachable ? Availability.IN_STOCK : Availability.OUT_OF_STOCK,
      detectionMethod: bot.monitorKind === MonitorKind.HTTP ? DetectionMethod.UPTIME_HTTP : DetectionMethod.UPTIME_TCP,
      successful: true,
      confirmed,
      reachable: result.reachable,
      responseTimeMs: result.responseTimeMs,
      dnsAddressesJson: dnsAddresses ? JSON.stringify(dnsAddresses) : null,
      sslExpiresAt,
      contentMatched: result.contentMatched,
      warning: [result.error, ...diagnostics].filter(Boolean).join(" ") || null,
      title: bot.name,
    } });
    let events: { type: EventType; description: string }[] = [];
    if (!result.reachable && confirmed && bot.notifyOnDown && failureCount === bot.failureConfirmationCount) events.push({ type: result.contentMatched === false ? EventType.CONTENT_MISMATCH : EventType.ENDPOINT_DOWN, description: result.contentMatched === false ? `Expected page content is missing` : `Endpoint unreachable${result.error ? ` (${result.error})` : ""}` });
    if (result.reachable && bot.notifyOnRecovery && bot.consecutiveErrors >= bot.failureConfirmationCount) events.push({ type: EventType.ENDPOINT_RECOVERED, description: `Endpoint recovered in ${result.responseTimeMs} ms` });
    if (result.reachable && bot.notifyOnHighLatency && result.responseTimeMs > bot.latencyThresholdMs && (prior?.responseTimeMs == null || prior.responseTimeMs <= bot.latencyThresholdMs)) {
      events.push({ type: EventType.HIGH_LATENCY, description: `High latency: ${result.responseTimeMs} ms (threshold ${bot.latencyThresholdMs} ms)` });
    }
    if (bot.dnsMonitoring && dnsAddresses && prior?.dnsAddressesJson) {
      const previousAddresses = JSON.parse(prior.dnsAddressesJson) as string[];
      if (JSON.stringify(previousAddresses) !== JSON.stringify(dnsAddresses)) events.push({ type: EventType.DNS_CHANGED, description: `DNS changed from ${previousAddresses.join(", ")} to ${dnsAddresses.join(", ")}` });
    }
    if (sslExpiresAt && sslExpiresAt.getTime() - Date.now() <= bot.sslExpiryWarningDays * 86_400_000) {
      events.push({ type: EventType.SSL_EXPIRING, description: `SSL certificate expires ${sslExpiresAt.toLocaleDateString()}` });
    }
    if (!result.reachable && confirmed && bot.reminderIntervalMinutes > 0 && failureCount > bot.failureConfirmationCount) {
      const lastOfflineAlert = await prisma.notificationEvent.findFirst({ where: { botId: id, eventType: { in: [EventType.ENDPOINT_DOWN, EventType.CONTENT_MISMATCH, EventType.ENDPOINT_STILL_DOWN] } }, orderBy: { createdAt: "desc" } });
      if (!lastOfflineAlert || Date.now() - lastOfflineAlert.createdAt.getTime() >= bot.reminderIntervalMinutes * 60_000) events.push({ type: EventType.ENDPOINT_STILL_DOWN, description: `Endpoint is still unreachable${result.error ? ` (${result.error})` : ""}` });
    }
    if (events.length && bot.notificationCooldownMinutes > 0) {
      const recent = await prisma.notificationEvent.findMany({ where: { botId: id, createdAt: { gte: new Date(Date.now() - bot.notificationCooldownMinutes * 60_000) } }, select: { eventType: true } });
      const coolingDown = new Set(recent.map((event) => event.eventType));
      events = events.filter((event) => event.type === EventType.ENDPOINT_STILL_DOWN || !coolingDown.has(event.type));
    }
    await prisma.$transaction([
      prisma.bot.update({ where: { id }, data: { lastCheckAt: new Date(), lastSuccessfulCheckAt: new Date(), lastError: result.reachable ? null : result.error ?? "Endpoint unreachable.", consecutiveErrors: result.reachable ? 0 : { increment: 1 }, nextCheckAt: nextCheckAt(bot), lockedAt: null } }),
      ...events.map((event) => prisma.notificationEvent.create({ data: { botId: id, eventType: event.type, previousStateId: prior?.id, currentStateId: state.id, message: `${event.description}: ${bot.name}` } })),
    ]);
    await deliverEvents(id, state.id, bot.url);
    return { state, events, confirmed, warnings: [result.error, ...diagnostics].filter(Boolean) as string[] };
  }
  try {
    const result = await fetchProduct(bot.url, { browserMode: bot.browserMode, waitForSelector: bot.waitForSelector ?? undefined, pageLoadDelayMs: bot.pageLoadDelayMs,
      selectors: { price: bot.priceSelector ?? undefined, regularPrice: bot.regularPriceSelector ?? undefined, availability: bot.availabilitySelector ?? undefined, title: bot.titleSelector ?? undefined, image: bot.imageSelector ?? undefined, variant: bot.variantSelector ?? undefined, inStockText: bot.inStockText ?? undefined, outOfStockText: bot.outOfStockText ?? undefined } });
    const prior = bot.states[0] ?? null;
    const matching = await prisma.productState.count({ where: { botId: id, successful: true, confirmed: false, priceMinor: result.priceMinor, availability: result.availability } });
    const changed = Boolean(prior && (prior.priceMinor !== (result.priceMinor ?? null) || prior.availability !== result.availability));
    const confirmed = !changed || matching + 1 >= bot.confirmationCount;
    const state = await prisma.productState.create({ data: { botId: id, priceMinor: result.priceMinor, regularPriceMinor: result.regularPriceMinor, currency: result.currency,
      availability: result.availability, title: result.title, imageUrl: result.imageUrl, variantValue: result.variantValue ?? bot.variantValue, detectionMethod: result.detectionMethod, detectedPricesJson: JSON.stringify(result.detectedPrices),
      warning: result.warnings.join(" ") || null, successful: true, confirmed } });
    let events = confirmed ? detectChanges(prior, state, bot) : [];
    if (confirmed && bot.notifyOnHistoricalLow && state.priceMinor != null) {
      const historical = await prisma.productState.aggregate({ where: { botId: id, confirmed: true, successful: true, id: { not: state.id }, priceMinor: { not: null } }, _min: { priceMinor: true } });
      if (historical._min.priceMinor != null && state.priceMinor < historical._min.priceMinor) events.push({ type: EventType.HISTORICAL_LOW, description: "New historical low price" });
    }
    if (events.length && bot.notificationCooldownMinutes > 0) {
      const recent = await prisma.notificationEvent.findMany({ where: { botId: id, createdAt: { gte: new Date(Date.now() - bot.notificationCooldownMinutes * 60000) } }, select: { eventType: true } });
      const coolingDown = new Set(recent.map((event) => event.eventType));
      events = events.filter((event) => !coolingDown.has(event.type));
    }
    await prisma.$transaction([
      prisma.bot.update({ where: { id }, data: { name: result.title ?? bot.name, imageUrl: result.imageUrl ?? bot.imageUrl, lastCheckAt: new Date(), lastSuccessfulCheckAt: new Date(), lastError: null, consecutiveErrors: 0, nextCheckAt: nextCheckAt(bot), lockedAt: null } }),
      ...events.map((event) => prisma.notificationEvent.create({ data: { botId: id, eventType: event.type, previousStateId: prior?.id, currentStateId: state.id, message: `${event.description}: ${result.title ?? bot.name}` } })),
    ]);
    await deliverEvents(id, state.id, bot.url);
    return { state, events, confirmed, warnings: result.warnings };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Monitoring failed.";
    await prisma.bot.update({ where: { id }, data: { lastCheckAt: new Date(), lastError: message, consecutiveErrors: { increment: 1 }, nextCheckAt: nextCheckAt(bot), lockedAt: null } });
    throw error;
  }
}
