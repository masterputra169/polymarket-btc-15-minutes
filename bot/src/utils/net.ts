/**
 * Small network helpers shared by the status WS server and the report API.
 */

/** True when the bind host only accepts connections from this machine. */
export function isLocalBindHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}
