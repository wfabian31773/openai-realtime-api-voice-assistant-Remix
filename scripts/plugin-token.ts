/**
 * Mint a plugin API token. Prints the plaintext once. Stores only the hash.
 * Does not apply migrations/add_plugin_api.sql — fails closed if the table
 * is missing.
 *
 *   npx tsx scripts/plugin-token.ts --label si-assistant-bot --scopes fleet:read,contacts:prepare,contacts:commit
 */
import { dbReady, pool } from "../server/db";
import { generateTokenParts, hashSecret } from "../src/plugin/tokens";
import { mintScopesCompatible, parseScopes } from "../src/plugin/scopes";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || !process.argv[i + 1]) return fallback;
  return process.argv[i + 1];
}

async function main(): Promise<void> {
  const label = arg("label", "plugin");
  const scopes = parseScopes(arg("scopes", "fleet:read").split(",").map((s) => s.trim()));
  const allowed = mintScopesCompatible(scopes);
  if (!allowed.ok) {
    console.error(`[plugin-token] ${allowed.error}`);
    process.exit(1);
  }
  if (scopes.includes("contacts:approve")) {
    console.warn("[plugin-token] contacts:approve is for the Support Center page, not the bot.");
  }
  await dbReady;
  const parts = generateTokenParts();
  await pool.query(
    "INSERT INTO api_tokens (jti, hashed_secret, label, scopes) VALUES ($1, $2, $3, $4)",
    [parts.jti, hashSecret(parts.secret), label, scopes],
  );
  console.log("Plaintext (shown once):");
  console.log(parts.plaintext);
  console.log(`jti=${parts.jti} label=${label} scopes=${scopes.join(",")}`);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error("[plugin-token] failed:", message);
  console.error("If the relation api_tokens is missing, apply migrations/add_plugin_api.sql first.");
  process.exit(1);
});
