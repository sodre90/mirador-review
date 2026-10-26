import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";

/** Mirador's checkout, whose test host and helpers the specs use; by default it sits next to this one. */
export const miradorDir = process.env.MIRADOR_DIR ?? join(import.meta.dirname, "..", "..", "visualized-claude-sessions");
/** The plugin as the specs install it: scripts/e2e.sh builds a copy, so the owner's own Mirador never runs a test's build. */
const pluginDir = process.env.REVIEW_PLUGIN_DIR ?? join(import.meta.dirname, "..");

type Helpers = typeof import("../../visualized-claude-sessions/e2e/helpers.ts");
type TestHostModule = typeof import("../../visualized-claude-sessions/e2e/test-host.ts");
export type TestHost = InstanceType<TestHostModule["TestHost"]>;

export const helpers = (await import(join(miradorDir, "e2e", "helpers.ts"))) as Helpers;
export const testHost = (await import(join(miradorDir, "e2e", "test-host.ts"))) as TestHostModule;

/** Puts this plugin in `host`'s plugins folder, as installing it would; call it before the host starts. */
export function installThisPlugin(host: TestHost) {
  mkdirSync(join(host.dataDir, "plugins"), { recursive: true });
  symlinkSync(pluginDir, join(host.dataDir, "plugins", "review"));
}
