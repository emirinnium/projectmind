/** Normalize WHATWG URL hostnames before comparing host identities. */
export function normalizeHostname(hostname: string): string {
  return hostname.trim().replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
}
