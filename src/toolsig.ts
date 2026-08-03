/**
 * When to tell a client its tool list went stale.
 *
 * Kept out of index.ts so it can be tested without the Workers runtime: the
 * decision matters more than the plumbing. Announcing when nothing changed is
 * noise; failing to announce leaves a connected client using a tool list from
 * before the last deploy, which is how a new tool stays invisible until
 * someone reconnects by hand.
 */

/** What the visible tool list depends on: the server's set, and this grant's scopes. */
export function toolSignature(version: number, scopes: string[]): string {
  return `${version}:${[...scopes].sort().join(",")}`;
}

/**
 * Announce only on a real change. A first-ever session has nothing to
 * re-read, so silence is correct there — the client just listed the tools.
 */
export function shouldAnnounce(previous: string | undefined, current: string): boolean {
  return !!previous && previous !== current;
}
