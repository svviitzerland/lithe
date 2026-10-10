import { cloudflareSsh } from "@lithe/app/cloudflare-ssh";
import app from "./app.ts";

// One Worker, two front doors:
//   HTTP  — the manifest and the stateless frame protocol, for relay access
//   WSS   — a complete SSH session, terminated right here
export default cloudflareSsh(app);
