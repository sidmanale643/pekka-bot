// Builds the Apple Silicon DMG in desktop/dist. Signs with a Developer ID when one is
// available (CSC_LINK or CSC_NAME, or one in the keychain), and electron-builder then
// notarizes when APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID are set.
// Otherwise the app is signed ad hoc: it runs on this Mac, and on another once its
// owner chooses Open Anyway in System Settings → Privacy & Security.
// Usage: node scripts/dist.mjs
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const desktop = join(import.meta.dirname, "..");
execFileSync(process.execPath, [join(import.meta.dirname, "stage-server.mjs")], { stdio: "inherit" });

const identities = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" });
const developerId = Boolean(process.env.CSC_LINK || process.env.CSC_NAME) || identities.includes("Developer ID Application");
if (!developerId) console.log("No Developer ID certificate found. Signing ad hoc.");
execFileSync(join(desktop, "node_modules/.bin/electron-builder"), ["--mac", "dmg", "--arm64", ...(developerId ? [] : ["-c.mac.identity=-"])], {
  cwd: desktop,
  stdio: "inherit",
});
