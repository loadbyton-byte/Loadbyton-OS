import { Hono } from "hono";
import { config } from "../config.js";
import { setRfPin } from "../ops/rf-terminal.js";
import { act, appPage, need, PageHead, withT } from "./appkit.js";
import { Csrf, Table } from "./ui.js";
import { formBody, str, type Env } from "./mw.js";

export const rfPins = new Hono<Env>();
const U = "/app/warehouse/rf-pins";
rfPins.get(U, async (c) => {
  need(c, "settings.manage");
  const csrf = c.get("csrf");
  const rows = await withT(c, async (cn) => (await cn.query<any>(`SELECT t.user_id AS id, t.email, t.name, p.set_at, p.locked_until > now() AS locked FROM team_members t LEFT JOIN rf_pins p ON p.user_id=t.user_id WHERE t.active ORDER BY t.email`)).rows);
  return appPage(c, "RF terminal PINs", <>
    <PageHead title="RF terminal PINs" sub="Handheld guns that use the text terminal sign in with the company code, e-mail and a numeric PIN." />
    <div class="alert warn">The text terminal sends everything unencrypted. Reach it only from your private network or through a VPN. {config.rf.port ? `It is listening on port ${config.rf.port}.` : "It is switched off on this installation (RF_PORT is not set)."}</div>
    <Table head={["Person", "PIN", ""]} empty="No people.">
      {rows.map((r: any) => <tr><td>{r.name ?? r.email}<div class="small mute">{r.email}</div></td><td>{r.set_at ? (r.locked ? "locked" : "set") : "none"}</td>
        <td><form method="post" action={U} class="inline-form"><Csrf t={csrf} /><input type="hidden" name="user_id" value={r.id} /><input name="pin" type="password" inputmode="numeric" pattern="[0-9]{6,10}" placeholder="6–10 digits" autocomplete="off" required /><button class="btn ghost sm">Set PIN</button></form></td></tr>)}</Table>
  </>);
});
rfPins.post(U, async (c) => { const b = await formBody(c); return act(c, U, async () => { await withT(c, (cn, ctx) => setRfPin(cn, ctx, str(b.user_id), str(b.pin))); return { to: U, ok: "PIN saved. Any lock is cleared." }; }); });
