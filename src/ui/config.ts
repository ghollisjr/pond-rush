// ============================================================================
// ui/config.ts
//
// Where the game server lives, if there is one.
//
// Online play is an addition, never a requirement. With no server reachable
// the page still works exactly as it did — hot seat, and a game carried in a
// link — which is what the GitHub Pages build is and what makes the demo
// usable offline, on a plane, or if the server is ever taken down.
//
// A URL in the page's query string wins, so a different server can be tried
// without a rebuild: ?server=http://localhost:8787
// ============================================================================

const DEFAULT_SERVER = "https://pond-rush.ghollisjr.deno.net";

export function serverUrl(): string {
  try {
    const override = new URLSearchParams(location.search).get("server");
    if (override) return override.replace(/\/+$/, "");
  } catch {
    // No location, or a malformed query. Fall through to the default.
  }
  return DEFAULT_SERVER;
}
