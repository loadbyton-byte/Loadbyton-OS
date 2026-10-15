import net from "node:net";
import { config } from "./config.js";
import { openDb, type Db } from "./db/client.js";
import { RfSession } from "./ops/rf-terminal.js";

const IDLE_MS = 120_000, MAX_LINE = 200, MAX_CONN = 200;

/** Remove Telnet option negotiation (IAC sequences) so a standard client can connect; everything else is treated as typed text. */
export function stripTelnet(buf: Buffer): string {
  const out: number[] = [];
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 255) { const c = buf[i + 1]; i += c >= 251 && c <= 254 ? 2 : 1; continue; }
    out.push(buf[i]);
  }
  return Buffer.from(out).toString("latin1");
}

const IAC = 255, WILL = 251, WONT = 252, ECHO = 1;
/** Full-screen text for VT100/VT220 terminal-emulation clients (the mode vendor RF guns use): clear the screen, home the cursor, then the lines. Rows beyond the screen height are cut from the top. */
export function vt100Screen(lines: string[], rows: number): string {
  const shown = lines.slice(-Math.max(2, rows));
  return `\x1b[2J\x1b[H${shown.join("\r\n")}`;
}

export function startRfServer(db: Db, port = config.rf.port, host = config.rf.host, width = config.rf.width, mode: "lines" | "vt100" = config.rf.mode, rows = config.rf.rows) {
  let open = 0;
  const server = net.createServer((sock) => {
    if (open >= MAX_CONN) { sock.end("Busy.\r\n"); return; }
    open++; sock.setTimeout(IDLE_MS); sock.setNoDelay(true);
    const session = new RfSession(db, width); let buf = "", busy = false; const queue: string[] = [];
    let masked = false;
    const send = (lines: string[]) => {
      // a PIN is typed with the client's own echo switched off, so it never shows on the gun's screen
      const wantMask = session.stage === "pin";
      if (wantMask && !masked) { sock.write(Buffer.from([IAC, WILL, ECHO])); masked = true; }
      if (!wantMask && masked) { sock.write(Buffer.from([IAC, WONT, ECHO])); masked = false; }
      sock.write(mode === "vt100" ? vt100Screen(lines, rows) + "\r\n" : lines.join("\r\n") + "\r\n");
    };
    send(session.banner());
    const drain = async () => {
      if (busy) return; busy = true;
      try {
        while (queue.length && !sock.destroyed) {
          const out = await session.feed(queue.shift()!);
          send(out);
          if (session.closed) { sock.end(); return; }
        }
      } catch { sock.destroy(); } finally { busy = false; }
    };
    sock.on("data", (d) => {
      buf += stripTelnet(Buffer.from(d));
      let i: number;
      while ((i = buf.search(/[\r\n]/)) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1).replace(/^[\r\n]/, ""); queue.push(line); }
      if (buf.length > MAX_LINE) { sock.destroy(); return; }
      void drain();
    });
    sock.on("timeout", () => { sock.end("Timed out.\r\n"); });
    sock.on("error", () => { /* closed below */ });
    sock.on("close", () => { open--; });
  });
  server.listen(port, host);
  return server;
}

if (process.argv[1]?.endsWith("rf-server.ts") || process.argv[1]?.endsWith("rf-server.js")) {
  if (!config.rf.port) { console.error("Set RF_PORT to start the RF terminal server."); process.exit(1); }
  const db = await openDb();
  startRfServer(db);
  console.log(`RF terminal server on ${config.rf.host}:${config.rf.port}. This is a cleartext protocol: expose it only on a private network or VPN.`);
}
