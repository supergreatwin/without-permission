import { readFile } from "node:fs/promises";

const origin = new URL(process.env.WP_CLOUDFLARE_SITE_URL);
const secret = process.env.WP_CLOUDFLARE_DEPLOY_HOOK;
if (!URL.canParse(secret)) throw new Error("Cloudflare Pages deploy hook is missing or invalid");
const hook = new URL(secret);
if (origin.protocol !== "https:" || origin.href !== `${origin.origin}/`
    || hook.origin !== "https://api.cloudflare.com" || !hook.pathname.startsWith("/client/v4/pages/webhooks/deploy_hooks/")) {
  throw new Error("Invalid Cloudflare Pages origin or deploy hook configuration");
}

if (process.env.WP_CLOUDFLARE_FORCE_REBUILD !== "true") {
  const { version } = JSON.parse(await readFile(new URL("../dist/editorial-version.json", import.meta.url), "utf8"));
  const live = await fetch(new URL("editorial-version.json", origin), { cache: "no-store", signal: AbortSignal.timeout(15000) });
  if (!live.ok && live.status !== 404) throw new Error(`Cloudflare version check failed (${live.status})`);
  if (live.ok && (await live.json()).version === version) {
    console.log("Cloudflare Pages already has the current editorial snapshot.");
    process.exit(0);
  }
}

let deployment;
try {
  deployment = await fetch(hook, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15000) });
} catch {
  throw new Error("Cloudflare deployment request could not be sent");
}
if (!deployment.ok) throw new Error(`Cloudflare deployment request failed (${deployment.status})`);
console.log("Queued a Cloudflare Pages deployment.");
