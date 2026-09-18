"use client"; import { useState } from "react";
const fields: Record<string, [string,string][]> = { DISCORD: [["webhookUrl","Webhook URL"]], GOTIFY: [["serverUrl","Server URL"],["token","Application token"],["priority","Priority"]], PUSHOVER: [["userKey","User key"],["token","Application token"],["priority","Priority (-2 to 2)"],["sound","Sound (optional)"]], TELEGRAM: [["botToken","Bot token"],["chatId","Chat ID"]], SMTP: [["host","SMTP hostname"],["port","SMTP port"],["username","Username"],["password","Password"],["from","From address"],["to","Recipient address"]], WEBHOOK: [["url","URL"],["method","HTTP method"],["bodyTemplate","JSON body template"]] };
type Channel = { id: string; name: string; type: string; enabled: boolean };
export function NotificationSettings({ initial }: { initial: Channel[] }) {
  const [channels, setChannels] = useState(initial);
  const [type, setType] = useState("DISCORD");
  const [editing, setEditing] = useState<Channel | null>(null);
  const [message, setMessage] = useState("");
  const activeType = editing?.type ?? type;
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const configuration = Object.fromEntries(fields[activeType].map(([key]) => [key, f.get(key) ?? ""]));
    const response = await fetch(editing ? `/api/notification-channels/${editing.id}` : "/api/notification-channels", {
      method: editing ? "PUT" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: f.get("name"), type: activeType, enabled: f.get("enabled") === "on", configuration }),
    });
    const body = await response.json();
    if (!response.ok) return setMessage(body.error?.message ?? "Could not save channel.");
    const saved = body.channel as Channel;
    setChannels((current) => editing ? current.map((channel) => channel.id === saved.id ? saved : channel) : [...current, saved]);
    setEditing(null);
    form.reset();
    setMessage(editing ? "Channel updated. Blank secrets were kept unchanged." : "Channel saved. Secrets are encrypted.");
  };
  const remove = async (channel: Channel) => {
    if (!window.confirm(`Remove “${channel.name}”? Bots using it will stop sending to this channel.`)) return;
    const response = await fetch(`/api/notification-channels/${channel.id}`, { method: "DELETE" });
    const body = await response.json();
    if (!response.ok) return setMessage(body.error?.message ?? "Could not remove channel.");
    setChannels((current) => current.filter(({ id }) => id !== channel.id));
    if (editing?.id === channel.id) setEditing(null);
    setMessage("Channel removed.");
  };
  return <div className="settingsSplit">
    <section className="formCard"><h2>Notification channels</h2><p className="help">Bots can send one combined alert to every selected channel.</p>{channels.length ? <div className="channelList">{channels.map((c) => <div className="channel" key={c.id}><span className="channelIcon">↗</span><div><b>{c.name}</b><small>{c.type}</small></div><span className={`badge ${c.enabled ? "healthy" : "muted"}`}>{c.enabled ? "Enabled" : "Disabled"}</span><button className="button tiny" onClick={() => setEditing(c)}>Edit</button><button className="button tiny" onClick={() => remove(c)}>Remove</button><button className="button tiny" onClick={async () => { const r = await fetch(`/api/notification-channels/${c.id}/test`, { method: "POST" }); const b = await r.json(); setMessage(r.ok ? "Test sent successfully." : b.error?.message); }}>Test</button></div>)}</div> : <div className="miniEmpty">No channels configured yet.</div>}</section>
    <form className="formCard" onSubmit={submit} key={editing?.id ?? "new"}><h2>{editing ? `Edit ${editing.name}` : "Add a channel"}</h2><label>Provider<select value={activeType} disabled={Boolean(editing)} onChange={(e) => setType(e.target.value)}>{Object.keys(fields).map((value) => <option value={value} key={value}>{value}</option>)}</select></label><label>Channel name<input name="name" required defaultValue={editing?.name} placeholder={`My ${activeType.toLowerCase()}`} /></label><label className="check"><input name="enabled" type="checkbox" defaultChecked={editing?.enabled ?? true} /> Enabled</label>{editing && <p className="help">Enter only the settings you want to replace. Leave a password or token blank to keep it unchanged.</p>}{fields[activeType].map(([key,label]) => <label key={key}>{label}<input required={!editing && !["priority","sound","bodyTemplate","username","password"].includes(key)} name={key} type={key.toLowerCase().includes("token") || key === "password" ? "password" : "text"} placeholder={editing ? "Leave blank to keep current value" : undefined} /></label>)}<button className="button primary">{editing ? "Save changes" : "Save channel"}</button>{editing && <button className="button" type="button" onClick={() => setEditing(null)}>Cancel</button>}{message && <p className="saved">{message}</p>}</form>
  </div>;
}
