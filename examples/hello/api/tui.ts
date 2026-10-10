import { experimental_upgradeWebSocket } from "@vercel/functions";
import { vercelSsh } from "@lithe/app/vercel-ssh";
import app from "../app.ts";

// One function, both doors: an SSH session on an Upgrade request, the manifest
// and the stateless frame protocol otherwise.
const handler = vercelSsh(app, { upgrade: experimental_upgradeWebSocket });

export const GET = handler;
export const POST = handler;
export default handler;
