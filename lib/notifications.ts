import type { ChannelType } from "@prisma/client";
import nodemailer from "nodemailer";
import { decrypt } from "./crypto";
type Config = Record<string, string | number | boolean>;
export function renderTemplate(template: string, values: Record<string, string | number | null | undefined>): string { return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(values[key] ?? "")); }
export async function sendNotification(type: ChannelType, encrypted: string, message: string) {
  const config = await decrypt<Config>(encrypted); let url = ""; const init: RequestInit = { method: "POST", headers: { "content-type": "application/json" } };
  if (type === "DISCORD") { url = String(config.webhookUrl); init.body = JSON.stringify({ content: message }); }
  else if (type === "GOTIFY") { url = `${String(config.serverUrl).replace(/\/$/, "")}/message?token=${encodeURIComponent(String(config.token))}`; init.body = JSON.stringify({ title: "Bots Alert", message, priority: Number(config.priority ?? 5) }); }
  else if (type === "PUSHOVER") {
    url = "https://api.pushover.net/1/messages.json"; init.headers = { "content-type": "application/x-www-form-urlencoded" };
    const params = new URLSearchParams({ token: String(config.token), user: String(config.userKey), title: "Bots Alert", message });
    const priority = Math.max(-2, Math.min(2, Math.trunc(Number(config.priority) || 0)));
    params.set("priority", String(priority));
    // Emergency priority must carry retry/expire or Pushover rejects the message.
    if (priority === 2) { params.set("retry", "60"); params.set("expire", "3600"); }
    const sound = String(config.sound ?? "").trim();
    if (sound) params.set("sound", sound);
    init.body = params.toString();
  }
  else if (type === "TELEGRAM") { url = `https://api.telegram.org/bot${String(config.botToken)}/sendMessage`; init.body = JSON.stringify({ chat_id: config.chatId, text: message }); }
  else if (type === "WEBHOOK") { url = String(config.url); init.method = String(config.method ?? "POST"); init.body = renderTemplate(String(config.bodyTemplate ?? '{"message":"{{message}}"}'), { message }); }
  else if (type === "SMTP") {
    const port = Number(config.port);
    if (!String(config.host ?? "").trim() || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("SMTP hostname or port is invalid.");
    if (!String(config.from ?? "").trim() || !String(config.to ?? "").trim()) throw new Error("SMTP sender and recipient addresses are required.");
    const username = String(config.username ?? "").trim();
    const transport = nodemailer.createTransport({
      host: String(config.host).trim(),
      port,
      secure: port === 465,
      auth: username ? { user: username, pass: String(config.password ?? "") } : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
    const result = await transport.sendMail({
      from: String(config.from).trim(),
      to: String(config.to).trim(),
      subject: "Bots test and monitoring alert",
      text: message,
    });
    return { status: 250, responseBody: result.response || `Accepted as ${result.messageId}` };
  } else throw new Error("Unsupported notification provider.");
  const response = await fetch(url, init); const responseBody = (await response.text()).slice(0, 2000);
  if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}.`);
  return { status: response.status, responseBody };
}
