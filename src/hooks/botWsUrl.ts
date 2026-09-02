/**
 * Shared helpers for connecting to the bot status WebSocket.
 *
 * Token resolution order: URL query param (persisted to localStorage) →
 * localStorage → VITE_BOT_STATUS_TOKEN / VITE_BOT_CONTROL_TOKEN env.
 */

export function getBotStatusToken() {
  try {
    const params = new URLSearchParams(window.location.search);
    const tokenFromUrl = params.get('botStatusToken') || params.get('botToken') || params.get('statusToken');
    if (tokenFromUrl) {
      localStorage.setItem('botStatusToken', tokenFromUrl);
      return tokenFromUrl;
    }
    const tokenFromStorage = localStorage.getItem('botStatusToken');
    if (tokenFromStorage) return tokenFromStorage;
  } catch (_e) { /* ignore storage/query failures */ }

  return (
    import.meta.env.VITE_BOT_STATUS_TOKEN ||
    import.meta.env.VITE_BOT_CONTROL_TOKEN ||
    ''
  ).trim();
}

export function buildBotWsUrl() {
  const configuredUrl = (import.meta.env.VITE_BOT_WS_URL || '').trim();
  const baseUrl = configuredUrl || (import.meta.env.DEV ? `ws://${window.location.hostname}:3099` : '/ws');
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const resolvedUrl = baseUrl.startsWith('/')
    ? new URL(baseUrl, `${wsProtocol}//${window.location.host}`).toString()
    : baseUrl;
  const token = getBotStatusToken();
  if (!token) return resolvedUrl;

  try {
    const url = new URL(resolvedUrl);
    url.searchParams.set('token', token);
    return url.toString();
  } catch (_e) {
    return resolvedUrl;
  }
}
