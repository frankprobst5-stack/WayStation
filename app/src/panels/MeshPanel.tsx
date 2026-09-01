import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  IconBroadcast,
  IconClock,
  IconHash,
  IconLocate,
  IconRefresh,
  IconSend,
  IconSettings,
  IconSignal,
  IconStar,
  IconTrash,
  IconUsers,
} from "../components/icons";

interface MeshNode {
  node_num: number;
  user_id: string | null;
  long_name: string | null;
  short_name: string | null;
  hw_model: string | null;
  snr: number | null;
  last_heard: number | null;
  battery_pct: number | null;
  is_favorite: boolean;
  updated_at: string;
  latitude: number | null;
  longitude: number | null;
  position_updated_at: number | null;
}

function formatLatLon(lat: number, lon: number): string {
  return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
}

interface MeshMessage {
  id: number;
  from_node: number;
  to_node: number;
  channel: number;
  text: string;
  rx_time: number;
  received_at: string;
  outbound: boolean;
  status: string;
  fail_reason: string | null;
}

interface MeshStatus {
  connected: boolean;
  my_node_num: number | null;
  target: string;
}

const BROADCAST_NODE = 4294967295; // 0xFFFFFFFF
const CHANNELS = [0, 1, 2, 3, 4, 5, 6, 7];
const STATUS_POLL_MS = 5000;
const ONLINE_WINDOW_SECONDS = 900; // 15 minutes since last heard
// A routing response on a live mesh normally lands within seconds. Past
// this window with no ack, "awaiting confirmation" is no longer an honest
// description -- the node likely never heard it, not "still in flight."
const STALE_ACK_SECONDS = 120;

function relativeTime(unixSeconds: number | null): string {
  if (!unixSeconds) return "never";
  const ms = Date.now() - unixSeconds * 1000;
  if (ms < 0) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function signalBars(snr: number | null): string {
  // Rough SNR -> bar-count mapping. Meshtastic SNR is usually -20..10 dB;
  // above 5 is a strong link, below -10 is barely hanging on.
  if (snr === null) return "▁▁▁▁";
  if (snr >= 5) return "▂▄▆█";
  if (snr >= 0) return "▂▄▆▁";
  if (snr >= -10) return "▂▄▁▁";
  return "▂▁▁▁";
}

function isOnline(n: MeshNode | null | undefined): boolean {
  return !!n?.last_heard && Date.now() / 1000 - n.last_heard < ONLINE_WINDOW_SECONDS;
}

function linkQuality(nodes: MeshNode[]): { label: string; tier: "good" | "fair" | "poor" | "unknown" } {
  const heard = nodes.filter((n) => n.snr !== null);
  if (heard.length === 0) return { label: "Unknown", tier: "unknown" };
  const avg = heard.reduce((sum, n) => sum + (n.snr ?? 0), 0) / heard.length;
  if (avg >= 0) return { label: "Good", tier: "good" };
  if (avg >= -10) return { label: "Fair", tier: "fair" };
  return { label: "Poor", tier: "poor" };
}

function MeshPanel() {
  const [status, setStatus] = useState<MeshStatus | null>(null);
  const [nodes, setNodes] = useState<MeshNode[]>([]);
  const [messages, setMessages] = useState<MeshMessage[]>([]);
  const [text, setText] = useState("");
  const [channel, setChannel] = useState(0);
  const [toNode, setToNode] = useState<number | null>(null);
  const [requireAck, setRequireAck] = useState(true);
  const [sendError, setSendError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);

  async function refreshNodes() {
    setNodes(await invoke<MeshNode[]>("get_mesh_nodes"));
  }

  async function refreshMessages() {
    setMessages(await invoke<MeshMessage[]>("get_mesh_messages"));
  }

  async function refreshStatus() {
    setStatus(await invoke<MeshStatus>("get_mesh_status"));
  }

  useEffect(() => {
    refreshNodes();
    refreshMessages();
    refreshStatus();

    const unlisteners: (() => void)[] = [];
    listen("mesh-nodes-changed", refreshNodes).then((fn) => unlisteners.push(fn));
    listen("mesh-messages-changed", refreshMessages).then((fn) => unlisteners.push(fn));
    listen("mesh-config-complete", refreshNodes).then((fn) => unlisteners.push(fn));

    const interval = setInterval(refreshStatus, STATUS_POLL_MS);
    return () => {
      unlisteners.forEach((fn) => fn());
      clearInterval(interval);
    };
  }, []);

  function nodeLabel(nodeNum: number): string {
    if (nodeNum === BROADCAST_NODE) return "All";
    const node = nodes.find((n) => n.node_num === nodeNum);
    if (!node) return `!${nodeNum.toString(16)}`;
    return node.long_name || node.short_name || node.user_id || `!${nodeNum.toString(16)}`;
  }

  const channelMessages = useMemo(
    () => messages.filter((m) => toNode === null && m.channel === channel && m.to_node === BROADCAST_NODE),
    [messages, channel, toNode],
  );
  const directMessages = useMemo(
    () =>
      toNode === null
        ? []
        : messages.filter(
            (m) =>
              (m.from_node === toNode && m.outbound === false) ||
              (m.to_node === toNode && m.outbound === true) ||
              (m.from_node === toNode && m.to_node === status?.my_node_num),
          ),
    [messages, toNode, status],
  );
  const activeThread = toNode === null ? channelMessages : directMessages;

  const unreadByChannel = useMemo(() => {
    const counts = new Map<number, number>();
    for (const m of messages) {
      if (m.to_node !== BROADCAST_NODE || m.outbound) continue;
      counts.set(m.channel, (counts.get(m.channel) ?? 0) + 1);
    }
    return counts;
  }, [messages]);

  const participants = useMemo(() => {
    const list: { key: string; name: string; isMe: boolean; node: MeshNode | null }[] = [];
    if (status?.my_node_num !== null && status?.my_node_num !== undefined) {
      list.push({
        key: "me",
        name: `You (!${status.my_node_num.toString(16)})`,
        isMe: true,
        node: nodes.find((n) => n.node_num === status.my_node_num) ?? null,
      });
    }
    for (const n of nodes) {
      if (n.node_num === status?.my_node_num) continue;
      list.push({ key: String(n.node_num), name: n.long_name || n.short_name || `!${n.node_num.toString(16)}`, isMe: false, node: n });
    }
    return list;
  }, [nodes, status]);

  const quality = linkQuality(nodes);
  const mostRecentHeard = nodes.reduce<number | null>(
    (latest, n) => (n.last_heard !== null && (latest === null || n.last_heard > latest) ? n.last_heard : latest),
    null,
  );
  const avgSnr = (() => {
    const heard = nodes.filter((n) => n.snr !== null);
    if (heard.length === 0) return null;
    return heard.reduce((sum, n) => sum + (n.snr ?? 0), 0) / heard.length;
  })();

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setSendError(null);
    try {
      await invoke("send_mesh_text", { text, toNode, channel, wantAck: requireAck });
      setText("");
      refreshMessages();
    } catch (err) {
      setSendError(String(err));
    }
  }

  async function sendPosition() {
    setActionError(null);
    try {
      await invoke("send_mesh_position", { toNode });
    } catch (err) {
      setActionError(String(err));
    }
  }

  async function requestPosition() {
    setActionError(null);
    try {
      await invoke("request_mesh_position", { toNode });
    } catch (err) {
      setActionError(String(err));
    }
  }

  async function clearChat() {
    setActionError(null);
    try {
      await invoke("clear_mesh_messages");
      refreshMessages();
    } catch (err) {
      setActionError(String(err));
    }
  }

  async function deleteMessage(id: number) {
    setActionError(null);
    try {
      await invoke("delete_mesh_message", { id });
      refreshMessages();
    } catch (err) {
      setActionError(String(err));
    }
  }

  async function reconnect() {
    setReconnecting(true);
    await invoke("reconnect_mesh");
    // The poller drops the socket, then retries within about a second.
    // Give it a beat before reporting whatever state it landed in, rather
    // than showing a stale "Connected" from the link just torn down.
    setTimeout(async () => {
      await refreshStatus();
      setReconnecting(false);
    }, 2500);
  }

  return (
    <div className="panel-mesh">
      <div className="mesh-topbar">
        <span className={`mesh-dot ${status?.connected ? "up" : "down"}`} />
        <span className="mesh-topbar-label">{status?.connected ? "Connected" : "Disconnected"}</span>
        {status && <span className="resource-chip">{status.target}</span>}
        {status?.connected && (
          <span className="resource-chip">
            Node !{status.my_node_num !== null ? status.my_node_num.toString(16) : "?"}
          </span>
        )}
        <button type="button" className="mesh-pill mesh-reconnect" onClick={reconnect} disabled={reconnecting}>
          {reconnecting ? "Reconnecting..." : "Reconnect"}
        </button>
      </div>
      {status?.connected && nodes.length === 0 && (
        <p className="field-hint">
          "Connected" means the link to your own node is up — it doesn't mean anyone else is in
          range yet. No other nodes have been heard, so a broadcast right now may not reach anyone.
        </p>
      )}

      <div className="mesh-shell">
        <div className="mesh-rail">
          <div className="mesh-rail-section">
            <div className="mesh-section-label-row">
              <span className="sw-label">Nodes ({nodes.length})</span>
              <span className="mesh-label-icons">
                <button type="button" className="mesh-icon-button" onClick={refreshNodes} title="Refresh nodes">
                  <IconRefresh />
                </button>
                <IconSettings className="mesh-icon-decorative" />
              </span>
            </div>
            {nodes.length === 0 ? (
              <div className="panel-alerts-empty">No nodes heard yet.</div>
            ) : (
              <div className="mesh-node-list">
                {nodes.map((n) => (
                  <button
                    type="button"
                    key={n.node_num}
                    className={`mesh-node-card ${toNode === n.node_num ? "active" : ""}`}
                    onClick={() => setToNode(toNode === n.node_num ? null : n.node_num)}
                  >
                    <div className="resource-header">
                      <span className="resource-label">
                        <span className={`mesh-presence-dot mesh-presence-dot-inline ${isOnline(n) ? "up" : ""}`} />
                        {n.is_favorite && <IconStar className="mesh-inline-icon" />}
                        {n.long_name || n.short_name || `!${n.node_num.toString(16)}`}
                      </span>
                      <span>{relativeTime(n.last_heard)}</span>
                    </div>
                    <div className="resource-tokens">
                      {n.short_name && <span className="resource-chip">{n.short_name}</span>}
                      <span className="resource-chip mesh-signal">{signalBars(n.snr)}</span>
                      {n.battery_pct !== null && <span className="resource-chip">{n.battery_pct}%</span>}
                      {n.latitude !== null && n.longitude !== null && (
                        <span className="resource-chip" title={relativeTime(n.position_updated_at)}>
                          <IconLocate className="mesh-inline-icon" />
                          {formatLatLon(n.latitude, n.longitude)}
                        </span>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="mesh-rail-section">
            <div className="sw-label">Network Overview</div>
            <div className="mesh-stat-row">
              <div className="mesh-stat-tile">
                <span className="mesh-stat-value">{nodes.length}</span>
                <span className="mesh-stat-label">Nodes</span>
              </div>
              <div className="mesh-stat-tile">
                <span className="mesh-stat-value">{nodes.filter((n) => isOnline(n)).length}</span>
                <span className="mesh-stat-label">Online</span>
              </div>
              <div className="mesh-stat-tile">
                <span className="mesh-stat-value">{avgSnr !== null ? `${avgSnr.toFixed(0)}dB` : "—"}</span>
                <span className="mesh-stat-label">Avg SNR</span>
              </div>
            </div>
          </div>

          <div className="mesh-rail-section">
            <div className="sw-label">Channels</div>
            <div className="mesh-channel-list">
              <button
                type="button"
                className={`mesh-channel-row ${toNode === null ? "active" : ""}`}
                onClick={() => setToNode(null)}
              >
                <span className="mesh-channel-row-label">
                  <IconBroadcast className="mesh-inline-icon" />
                  All (Broadcast)
                </span>
              </button>
              {CHANNELS.map((c) => (
                <button
                  type="button"
                  key={c}
                  className={`mesh-channel-row ${toNode === null && channel === c ? "active" : ""}`}
                  onClick={() => {
                    setToNode(null);
                    setChannel(c);
                  }}
                >
                  <span className="mesh-channel-row-label">
                    <IconHash className="mesh-inline-icon" />
                    Channel {c}
                  </span>
                  {unreadByChannel.get(c) ? <span className="mesh-unread-badge">{unreadByChannel.get(c)}</span> : null}
                </button>
              ))}
            </div>
          </div>

          <div className="mesh-rail-section">
            <div className="sw-label">Quick Actions</div>
            <div className="mesh-quick-actions">
              <button type="button" className="mesh-pill mesh-action-button" onClick={sendPosition} disabled={!status?.connected}>
                <IconSend className="mesh-inline-icon" />
                Send Position
              </button>
              <button type="button" className="mesh-pill mesh-action-button" onClick={requestPosition} disabled={!status?.connected}>
                <IconLocate className="mesh-inline-icon" />
                Request Position
              </button>
              <button type="button" className="mesh-pill mesh-action-button" onClick={clearChat}>
                <IconTrash className="mesh-inline-icon" />
                Clear Chat
              </button>
            </div>
            {actionError && <div className="panel-alerts-empty">{actionError}</div>}
          </div>
        </div>

        <div className="mesh-chat">
          <div className="mesh-chat-header">
            {toNode === null ? (
              <select
                className="mesh-chat-title-select"
                value={channel}
                onChange={(e) => setChannel(Number(e.currentTarget.value))}
              >
                {CHANNELS.map((c) => (
                  <option key={c} value={c}>
                    All (Broadcast) · ch{c}
                  </option>
                ))}
              </select>
            ) : (
              <span className="mesh-chat-title">{nodeLabel(toNode)}</span>
            )}
            <span className="resource-chip mesh-participant-chip">
              <IconUsers className="mesh-inline-icon" />
              {participants.length}
            </span>
          </div>

          <div className="mesh-channel-details">
            <IconBroadcast className="mesh-inline-icon" />
            <div>
              <div className="mesh-channel-details-title">
                {toNode === null ? `All (Broadcast) · ch${channel}` : nodeLabel(toNode)}
              </div>
              <div className="mesh-channel-details-desc">
                {toNode === null ? "Broadcast to all nodes on this channel" : "Direct message"}
              </div>
            </div>
          </div>

          <div className="mesh-messages">
            {activeThread.length === 0 ? (
              <div className="panel-alerts-empty">No messages yet.</div>
            ) : (
              activeThread.map((m) => {
                const sender = !m.outbound ? nodes.find((n) => n.node_num === m.from_node) : null;
                return (
                  <div key={m.id} className={`mesh-message ${m.outbound ? "outbound" : ""} status-${m.status}`}>
                    <div className="mesh-message-meta">
                      <span>
                        {sender?.is_favorite && <IconStar className="mesh-inline-icon" />}
                        {m.outbound ? "You" : nodeLabel(m.from_node)}
                      </span>
                      <span>{relativeTime(m.rx_time)}</span>
                      <button
                        type="button"
                        className="mesh-message-delete"
                        title="Delete this message"
                        onClick={() => deleteMessage(m.id)}
                      >
                        ✕
                      </button>
                    </div>
                    <div className="mesh-message-text">{m.text}</div>
                    {sender && (sender.short_name || sender.snr !== null) && (
                      <div className="mesh-message-sender-chip">
                        {sender.short_name && <span>{sender.short_name}</span>}
                        {sender.snr !== null && <span>{sender.snr.toFixed(0)} dB SNR</span>}
                      </div>
                    )}
                    {m.outbound && (
                      <div className="mesh-message-status">
                        {m.status === "sent" &&
                          (Date.now() / 1000 - m.rx_time > STALE_ACK_SECONDS
                            ? "○ no response — likely out of range"
                            : "○ sent, awaiting confirmation")}
                        {m.status === "delivered" && "✓ delivered"}
                        {m.status === "failed" && `✗ failed — ${m.fail_reason ?? "unknown reason"}`}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>

          <form className="mesh-compose" onSubmit={send}>
            <input
              value={text}
              onChange={(e) => setText(e.currentTarget.value)}
              placeholder={toNode === null ? "Message to everyone..." : "Direct message"}
              disabled={!status?.connected}
            />
            <select value={channel} onChange={(e) => setChannel(Number(e.currentTarget.value))} disabled={toNode !== null}>
              {CHANNELS.map((c) => (
                <option key={c} value={c}>
                  ch{c}
                </option>
              ))}
            </select>
            <label className="mesh-ack-toggle">
              <input type="checkbox" checked={requireAck} onChange={(e) => setRequireAck(e.currentTarget.checked)} />
              Require Ack
            </label>
            <button type="submit" className="mesh-pill" disabled={!status?.connected}>
              Send
            </button>
          </form>
          {sendError && <div className="panel-alerts-empty">{sendError}</div>}
        </div>

        <div className="mesh-rail mesh-rail-right">
          <div className="mesh-rail-section">
            <div className="sw-label">Participants ({participants.length})</div>
            {participants.length === 0 ? (
              <div className="panel-alerts-empty">No participants yet.</div>
            ) : (
              <div className="mesh-participant-list">
                {participants.map((p) => (
                  <div key={p.key} className="mesh-participant-row">
                    <span className={`mesh-presence-dot ${p.isMe || isOnline(p.node) ? "up" : ""}`} />
                    <div className="mesh-participant-body">
                      <div className="mesh-participant-name-row">
                        <span className="resource-label">{p.name}</span>
                        {p.isMe && (
                          <span className="mesh-owner-badge">
                            <IconStar className="mesh-inline-icon" />
                            Owner
                          </span>
                        )}
                      </div>
                      <div className="resource-tokens">
                        {p.node?.short_name && <span className="resource-chip">{p.node.short_name}</span>}
                        {p.node?.battery_pct !== null && p.node?.battery_pct !== undefined && (
                          <span className="resource-chip">{p.node.battery_pct}%</span>
                        )}
                        <span className="resource-chip">{relativeTime(p.node?.last_heard ?? null)}</span>
                        {p.node?.latitude !== null && p.node?.latitude !== undefined && p.node?.longitude !== null && p.node?.longitude !== undefined && (
                          <span className="resource-chip" title={relativeTime(p.node.position_updated_at)}>
                            <IconLocate className="mesh-inline-icon" />
                            {formatLatLon(p.node.latitude, p.node.longitude)}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="mesh-rail-section">
            <div className="sw-label">Network Health</div>
            <div className="mesh-health-row">
              <span className="mesh-health-label">
                <IconSignal className="mesh-inline-icon" />
                Link Quality
              </span>
              <span className={`diag-badge diag-badge-${quality.tier === "good" ? "healthy" : quality.tier === "poor" ? "down" : "degraded"}`}>
                {quality.label}
              </span>
            </div>
            <div className="mesh-health-row">
              <span className="mesh-health-label">
                <IconSignal className="mesh-inline-icon" />
                Avg SNR
              </span>
              <span>{avgSnr !== null ? `${avgSnr.toFixed(1)} dB` : "—"}</span>
            </div>
            <div className="mesh-health-row">
              <span className="mesh-health-label">
                <IconClock className="mesh-inline-icon" />
                Last Heard
              </span>
              <span>{relativeTime(mostRecentHeard)}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="mesh-footer">Meshtastic · Waystation</div>
    </div>
  );
}

export default MeshPanel;
