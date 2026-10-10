import { cloudflare } from "@lithe/app/cloudflare";
import app from "./app.ts";

export default cloudflare(app);
