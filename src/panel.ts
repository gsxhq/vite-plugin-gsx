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

  cmdMiddleware(req: any, res: any): void {
    res.setHeader("x-gsx", "1"); // respawn-verification handshake for gsx dev
    if (req.method !== "GET") {
      res.statusCode = 405;
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
