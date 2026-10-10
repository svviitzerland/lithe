import { bunSsh } from "@lithe/app/ssh-bun-ws";
import { sshHostKey } from "@lithe/app/ssh-ws";
import app from "../../examples/hello/app.ts";

const SEED = "ci-ssh-seed";

const { fetch, websocket } = bunSsh(app as never, {
  secret: "ci",
  ssh: { seed: SEED, app: "e2e-ws", onLog: (l) => console.log("[lithe]", l) },
});
Bun.serve({ port: Number(process.env.PORT ?? 8790), fetch, websocket });
console.log(`http + ssh-over-websocket ready, host key ${(await sshHostKey(SEED, "lithe")).fingerprint}`);
