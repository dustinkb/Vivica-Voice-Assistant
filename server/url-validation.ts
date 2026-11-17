import net from 'node:net';

const BLOCKED_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.goog',
  '169.254.169.254',
  '0.0.0.0',
  '::',
]);

function isPrivateOrLoopbackIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = parts;
  // Loopback: 127.0.0.0/8
  if (a === 127) return true;
  // Link-local / cloud metadata: 169.254.0.0/16 -> explicitly blocked
  if (a === 169 && b === 254) return false;
  // Private RFC1918: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function isLoopbackOrLocalHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (
    lower === 'localhost' ||
    lower === '127.0.0.1' ||
    lower === '::1' ||
    lower === '[::1]' ||
    lower === 'host.docker.internal' ||
    lower.endsWith('.local')
  ) {
    return true;
  }

  const unbracketed = lower.startsWith('[') && lower.endsWith(']')
    ? lower.slice(1, -1)
    : lower;

  if (net.isIPv4(unbracketed)) {
    return isPrivateOrLoopbackIPv4(unbracketed);
  }
  if (net.isIPv6(unbracketed)) {
    // Only allow IPv6 loopback ::1
    return unbracketed === '::1' || unbracketed === '0:0:0:0:0:0:0:1';
  }

  return false;
}

function getExplicitlyAllowedHosts(): Set<string> {
  const allowed = new Set<string>();
  const envSources = [
    process.env.OLLAMA_HOST,
    process.env.LOCAL_STT_URL,
    process.env.LOCAL_TTS_URL,
    process.env.KOKORO_URL,
  ];
  for (const raw of envSources) {
    if (!raw) continue;
    try {
      const parsed = new URL(raw.includes('://') ? raw : `http://${raw}`);
      allowed.add(parsed.hostname.toLowerCase());
    } catch {
      // Ignore malformed env entries
    }
  }
  const listRaw = process.env.ALLOWED_LOCAL_HOSTS || '';
  for (const item of listRaw.split(',')) {
    const trimmed = item.trim().toLowerCase();
    if (trimmed) allowed.add(trimmed);
  }
  return allowed;
}

export interface UrlValidationResult {
  valid: boolean;
  normalizedUrl?: string;
  error?: string;
}

/**
 * Validates configurable local/LAN provider URLs (e.g., Ollama host) to prevent SSRF.
 * Rejects non-HTTP(S) schemes, credentials, paths/queries, cloud metadata IPs, and arbitrary public hosts.
 */
export function validateLocalProviderUrl(
  rawUrl: string | undefined,
  label = 'Provider URL',
): UrlValidationResult {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) {
    return { valid: false, error: `${label} is empty.` };
  }

  const withScheme = trimmed.includes('://') ? trimmed : `http://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { valid: false, error: `${label} is not a valid URL.` };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, error: `${label} must use http or https.` };
  }

  if (parsed.username || parsed.password) {
    return { valid: false, error: `${label} must not contain credentials.` };
  }

  if (parsed.search || parsed.hash) {
    return { valid: false, error: `${label} must not contain query parameters or fragments.` };
  }

  if (parsed.pathname && parsed.pathname !== '/') {
    return { valid: false, error: `${label} must be a base host URL without a custom path.` };
  }

  const hostname = parsed.hostname.toLowerCase();
  const unbracketed = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;

  if (BLOCKED_HOSTNAMES.has(unbracketed) || unbracketed.startsWith('169.254.') || unbracketed.startsWith('fe80:')) {
    return { valid: false, error: `${label} targets a restricted network address.` };
  }

  const explicitAllowed = getExplicitlyAllowedHosts();
  if (!isLoopbackOrLocalHostname(hostname) && !explicitAllowed.has(unbracketed)) {
    return {
      valid: false,
      error: `${label} host "${hostname}" is not a permitted local/LAN address. Configure ALLOWED_LOCAL_HOSTS on the server if using a custom remote host.`,
    };
  }

  return {
    valid: true,
    normalizedUrl: `${parsed.protocol}//${parsed.host}`,
  };
}
