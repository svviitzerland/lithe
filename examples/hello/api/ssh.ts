import { experimental_upgradeWebSocket } from "@vercel/functions";
import { vercelSsh } from "@lithe/app/vercel-ssh";
import app from "../app.ts";

// A complete SSH server, inside a Vercel Function.
export const GET = vercelSsh(app, {
  upgrade: experimental_upgradeWebSocket,
  seed: process.env.LITHE_SSH_SEED ?? "",
  onLog: (line) => console.log("[lithe]", line),
});

export default GET;
