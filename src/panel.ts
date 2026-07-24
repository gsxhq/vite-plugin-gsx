// PanelChannel: server side of the dev panel. Commands arrive from the panel
// over vite's HMR ws (intake), queue in the mailbox, and leave via the
// /__gsx/cmd long-poll (cmdMiddleware — gsx dev is the consumer). Status
// events from gsx dev are cached for replay and broadcast as gsx:status.
import { CommandMailbox } from "./mailbox.js";

const VALID_CMDS = new Set(["rebuild", "restart-server"]);
const MAX_WAIT_SEC = 30;

export class PanelChannel {
  private mailbox = new CommandMailbox();
  private currentStatus: unknown = null;

  constructor(
    private logger: { warn(msg: string, opts?: unknown): void },
    private broadcast: (payload: unknown) => void,
    // GSX_DEV_TOKEN, when the gsx dev that spawned this vite passed one.
    // Present ⇒ /__gsx/cmd requires the matching request header before
    // releasing anything from the mailbox, and echoes this token (rather
    // than "1") so gsx dev's respawn verification can confirm THIS is the
    // vite it spawned, not some other gsx project's vite that raced onto the
    // same freed port. Absent ⇒ exactly today's behavior (externally-run
    // vite, --no-web, or a gsx dev predating this pairing).
    private token?: string,
  ) {
    this.cmdMiddleware = this.cmdMiddleware.bind(this);
  }

  intake(raw: unknown): void {
    const cmd = String((raw as { cmd?: unknown } | null)?.cmd ?? "");
    if (!VALID_CMDS.has(cmd)) {
      this.logger.warn(`[gsx] ignoring unknown panel command: ${JSON.stringify(cmd)}`, { timestamp: true });
      return;
    }
    this.mailbox.push(cmd);
  }

  applyStatus(ev: unknown): boolean {
    if ((ev as { event?: unknown } | null)?.event !== "status") return false;
    this.currentStatus = ev;
    this.broadcast({ type: "custom", event: "gsx:status", data: ev });
    return true;
  }

  replayPayload(): string | null {
    if (this.currentStatus === null) return null;
    return JSON.stringify({ type: "custom", event: "gsx:status", data: this.currentStatus });
  }

  // Answers a panel's `gsx:status-request` pull (sent right after it
  // registers its `gsx:status` listener — see client.ts init()). Targeted at
  // the requesting client rather than broadcast: the connection-time replay
  // in index.ts's `ws.on("connection", ...)` already covers every client
  // once, so echoing to everyone here would double-deliver to clients that
  // didn't ask. A no-op (nothing sent) before any status has ever arrived —
  // same "nothing to replay yet" behavior as replayPayload/connection-time.
  //
  // `client` here is vite's WRAPPED per-client channel (what a *custom*
  // event listener — anything not in vite's wsServerEvents allowlist, which
  // "gsx:status-request" isn't — receives), NOT the raw WebSocket socket
  // index.ts's `ws.on("connection", ...)` gets ("connection" IS in that
  // allowlist). The two shapes are NOT interchangeable:
  //   - raw socket (connection handler): `.send(string)` writes that exact
  //     string as the wire frame — replayPayload()'s pre-stringified JSON is
  //     the correct argument there.
  //   - wrapped client (here): `.send` is overloaded — `.send(payload:
  //     HotPayload)` (a full `{type,event,data}` object) OR `.send(event:
  //     string, data?)` (vite builds the `{type:"custom",event,data}`
  //     envelope for you). Passing a *string* hits the second overload as
  //     the event NAME, not a raw frame — `client.send(replayPayload())`
  //     silently shipped `{type:"custom",event:"<the whole JSON blob>"}` and
  //     the browser's `hot.on("gsx:status")` never fired. Use the two-arg
  //     event+data form with the actual status object (not the
  //     pre-stringified replayPayload()).
  handleStatusRequest(client: { send(event: string, data?: unknown): void }): void {
    if (this.currentStatus === null) return;
    client.send("gsx:status", this.currentStatus);
  }

  cmdMiddleware(req: any, res: any): void {
    // Respawn-verification handshake for gsx dev: echo the token when one is
    // configured (so its verify only matches ITS OWN vite), else the plain
    // "1" every plugin has always sent. Stamped unconditionally — even a
    // 403/405 response carries it, so a foreign gsx dev's own verification
    // still correctly fails against us instead of hanging/erroring.
    res.setHeader("x-gsx", this.token ?? "1");
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.end();
      return;
    }
    if (this.token !== undefined && req.headers["x-gsx-token"] !== this.token) {
      // Reject before touching the mailbox: a rejected request must not
      // drain or displace a queued command or an already-hanging poller.
      res.statusCode = 403;
      res.end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://internal");
    const waitSec = Math.min(MAX_WAIT_SEC, Math.max(0, parseFloat(url.searchParams.get("wait") ?? "25") || 0));
    void this.mailbox.waitTake(waitSec * 1000).then((cmds) => {
      if (cmds.length === 0) {
        res.statusCode = 204;
        res.end();
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ cmds }));
    });
  }
}
