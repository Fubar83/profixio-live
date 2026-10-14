// Live push from Profixio: the public Reverb websocket (Pusher protocol) that Profixio's own
// match page listens to, channel `emp.<matchId>`. The browser connects to it directly; it is
// not behind our relay. Any event on the channel (goal, card, suspension, correction, clock)
// is passed to onEvent; the app then refetches, so this only has to say "something happened".

const PING_MS = 20_000; // server asks for activity every 30 s
const RETRY_MS = [1_000, 3_000, 10_000, 30_000];

export function connectMatch(config, matchId, { onEvent, onStatus }) {
  let ws = null;
  let pingTimer = null;
  let retryTimer = null;
  let attempts = 0;
  let closed = false;

  const status = (s) => onStatus?.(s);

  function open() {
    if (closed) return;
    status('connecting');
    try {
      ws = new WebSocket(`${config.url}?protocol=7&client=js&version=8.4.0&flash=false`);
    } catch {
      return retry();
    }

    ws.onmessage = (message) => {
      let msg;
      try { msg = JSON.parse(message.data); } catch { return; }
      if (msg.event === 'pusher:connection_established') {
        ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { channel: `emp.${matchId}` } }));
      } else if (msg.event === 'pusher_internal:subscription_succeeded') {
        attempts = 0;
        status('connected');
      } else if (msg.event === 'pusher:ping') {
        ws.send(JSON.stringify({ event: 'pusher:pong', data: {} }));
      } else if (msg.channel && !msg.event.startsWith('pusher')) {
        let data = msg.data;
        try { data = typeof data === 'string' ? JSON.parse(data) : data; } catch { /* keep raw */ }
        onEvent?.(msg.event, data);
      }
    };
    ws.onclose = () => {
      clearInterval(pingTimer);
      if (!closed) retry();
    };
    ws.onerror = () => { /* onclose follows and schedules the retry */ };
    pingTimer = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event: 'pusher:ping', data: {} }));
    }, PING_MS);
  }

  function retry() {
    status('disconnected');
    clearTimeout(retryTimer);
    retryTimer = setTimeout(open, RETRY_MS[Math.min(attempts++, RETRY_MS.length - 1)]);
  }

  open();

  return {
    close() {
      closed = true;
      clearInterval(pingTimer);
      clearTimeout(retryTimer);
      try { ws?.close(); } catch { /* already closed */ }
      status('off');
    },
    // After the page was hidden the socket may be dead without a close event yet.
    ensure() {
      if (!closed && (!ws || ws.readyState > WebSocket.OPEN)) {
        clearTimeout(retryTimer);
        attempts = 0;
        open();
      }
    },
  };
}
