import { listenSsh } from "@lithe/app/ssh-bun";
import app from "../../examples/hello/app.ts";

const { fingerprint } = await listenSsh(app as never, {
  port: Number(process.env.PORT ?? 2200),
  hostname: "127.0.0.1",
  seed: "ci-ssh-seed",
  app: "e2e-tcp",
  onLog: (l) => console.log("[lithe]", l),
});
console.log(`ssh server ready, host key ${fingerprint}`);
