import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface Message {
  id: number;
  precedence: string;
  date_time: string;
  to_station: string | null;
  to_name: string | null;
  from_station: string | null;
  from_name: string | null;
  subject: string | null;
  message_text: string;
  content_hash: string | null;
  dispatch_status: string;
  dispatched_via: string | null;
}

const PRECEDENCES = ["routine", "priority", "immediate", "emergency"];

function formatIcs309(messages: Message[]): string {
  const header = `ICS-309 COMMUNICATIONS LOG\nGenerated ${new Date().toISOString()}\n${"=".repeat(60)}`;
  const lines = messages.map(
    (m) =>
      `#${m.id}  ${m.date_time}  [${m.precedence.toUpperCase()}]\n` +
      `  FROM: ${m.from_station ?? "?"} ${m.from_name ?? ""}  TO: ${m.to_station ?? "?"} ${m.to_name ?? ""}\n` +
      `  SUBJECT: ${m.subject ?? "(none)"}\n` +
      `  ${m.message_text}`,
  );
  return [header, ...lines].join("\n\n");
}

function MessageRow({ m, onRedispatch }: { m: Message; onRedispatch?: (id: number) => void }) {
  return (
    <div className={`message-row precedence-${m.precedence}`}>
      <div className="message-header">
        <span>#{m.id}</span>
        <span>{m.precedence.toUpperCase()}</span>
        <span>
          {m.from_station ?? "?"} &rarr; {m.to_station ?? "?"}
        </span>
      </div>
      {m.subject && <div className="message-subject">{m.subject}</div>}
      <div className="message-text">{m.message_text}</div>
      {onRedispatch && (
        <div className="message-dispatch">
          {m.dispatch_status === "dispatched" ? (
            <span className="message-dispatch-status dispatched">&#10003; sent via {m.dispatched_via}</span>
          ) : (
            <>
              <span className="message-dispatch-status queued">&#9675; queued — no route yet</span>
              <button type="button" onClick={() => onRedispatch(m.id)}>
                Retry Dispatch
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function MessagesPanel() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [ownCallsign, setOwnCallsign] = useState<string | null>(null);
  const [precedence, setPrecedence] = useState("routine");
  const [toStation, setToStation] = useState("");
  const [toName, setToName] = useState("");
  const [fromStation, setFromStation] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [exportText, setExportText] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");

  async function refresh() {
    setMessages(await invoke<Message[]>("get_messages"));
  }

  useEffect(() => {
    refresh();
    invoke<{ callsign: string | null }>("get_station_profile").then((p) => {
      if (p.callsign) {
        setFromStation(p.callsign);
        setOwnCallsign(p.callsign);
      }
    });
  }, []);

  // "Outgoing" vs "incoming" isn't stored -- messages only have from/to
  // text fields, no direction flag. Inferred instead from whether
  // from_station matches this station's own callsign, which the form
  // already pre-fills, so it's a real signal, not a guess. A message
  // with no from_station at all (or logged before a callsign was set)
  // can't be classified either way and is shown separately rather than
  // guessed into one column.
  const outgoing = messages.filter((m) => ownCallsign && m.from_station === ownCallsign);
  const incoming = messages.filter((m) => ownCallsign && m.from_station && m.from_station !== ownCallsign);
  const unclassified = messages.filter((m) => !ownCallsign || !m.from_station);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    const created = await invoke<Message>("create_message", {
      precedence,
      toStation: toStation || null,
      toName: toName || null,
      fromStation: fromStation || null,
      fromName: null,
      subject: subject || null,
      messageText: body,
    });
    setToStation("");
    setToName("");
    setSubject("");
    setBody("");
    // Try to actually send it right away -- if nothing can reach the
    // recipient yet it just stays queued, redispatch_queued picks it up
    // automatically the next time a transport reconnects.
    await invoke("dispatch_message", { messageId: created.id });
    refresh();
  }

  async function redispatch(id: number) {
    await invoke("dispatch_message", { messageId: id });
    refresh();
  }

  function exportLog() {
    const text = formatIcs309(messages);
    setExportText(text);
    setCopyState("idle");
  }

  async function copyExport() {
    if (!exportText) return;
    try {
      await navigator.clipboard.writeText(exportText);
      setCopyState("copied");
    } catch {
      // Clipboard API can be unavailable; the visible textarea is the fallback — select-all still works.
    }
  }

  return (
    <div className="panel-messages">
      <form className="ics213-form" onSubmit={send}>
        <div className="ics213-row">
          <select value={precedence} onChange={(e) => setPrecedence(e.currentTarget.value)}>
            {PRECEDENCES.map((p) => (
              <option key={p} value={p}>
                {p.toUpperCase()}
              </option>
            ))}
          </select>
          <input value={fromStation} onChange={(e) => setFromStation(e.currentTarget.value.toUpperCase())} placeholder="From" />
          <input value={toStation} onChange={(e) => setToStation(e.currentTarget.value.toUpperCase())} placeholder="To" />
        </div>
        <input value={toName} onChange={(e) => setToName(e.currentTarget.value)} placeholder="To name (optional)" />
        <input value={subject} onChange={(e) => setSubject(e.currentTarget.value)} placeholder="Subject" />
        <textarea value={body} onChange={(e) => setBody(e.currentTarget.value)} placeholder="Message text" rows={3} />
        <button type="submit">Log Message (ICS-213)</button>
      </form>

      {messages.length === 0 ? (
        <div className="panel-alerts-empty">No messages logged yet.</div>
      ) : (
        <div className="ics309-columns">
          <div className="ics309-column">
            <div className="sw-label">Incoming</div>
            <div className="ics309-log">
              {incoming.length === 0 ? (
                <div className="panel-alerts-empty">None.</div>
              ) : (
                incoming
                  .slice()
                  .reverse()
                  .map((m) => <MessageRow key={m.id} m={m} />)
              )}
            </div>
          </div>
          <div className="ics309-column">
            <div className="sw-label">Outgoing</div>
            <div className="ics309-log">
              {outgoing.length === 0 ? (
                <div className="panel-alerts-empty">None.</div>
              ) : (
                outgoing
                  .slice()
                  .reverse()
                  .map((m) => <MessageRow key={m.id} m={m} onRedispatch={redispatch} />)
              )}
            </div>
          </div>
          {unclassified.length > 0 && (
            <div className="ics309-column ics309-column-full">
              <div className="sw-label">Unclassified (set your callsign in Settings to sort these)</div>
              <div className="ics309-log">
                {unclassified
                  .slice()
                  .reverse()
                  .map((m) => <MessageRow key={m.id} m={m} />)}
              </div>
            </div>
          )}
        </div>
      )}

      {messages.length > 0 && (
        <div className="ics309-export">
          <button type="button" onClick={exportLog}>
            Export ICS-309 (text)
          </button>
          {exportText && (
            <>
              <textarea readOnly value={exportText} rows={6} onClick={(e) => e.currentTarget.select()} />
              <button type="button" onClick={copyExport}>
                {copyState === "copied" ? "Copied" : "Copy to clipboard"}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default MessagesPanel;
