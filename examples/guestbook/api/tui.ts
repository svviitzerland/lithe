import { vercel } from "@lithe/app/vercel";
import app from "../app.ts";

const handler = vercel(app);
export const GET = handler;
export const POST = handler;
export default handler;
