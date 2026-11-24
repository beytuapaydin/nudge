const encoder = new TextEncoder();

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function createSignedActionUrl(
  baseUrl: string,
  secret: string,
  itemId: string,
  action: 'done' | 'snooze',
  ttlSeconds = 60 * 60 * 24 * 14
): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `${itemId}:${action}:${exp}`;
  const key = await importHmacKey(secret);
  const sigBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  const sig = toBase64Url(new Uint8Array(sigBuffer));

  const url = new URL(baseUrl);
  url.searchParams.set('id', itemId);
  url.searchParams.set('action', action);
  url.searchParams.set('exp', String(exp));
  url.searchParams.set('sig', sig);
  return url.toString();
}

export async function verifySignedAction(
  secret: string,
  itemId: string,
  action: string,
  expStr: string,
  sigStr: string
): Promise<boolean> {
  if (!itemId || (action !== 'done' && action !== 'snooze')) return false;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;

  try {
    const payload = `${itemId}:${action}:${exp}`;
    const key = await importHmacKey(secret);
    const sigBytes = fromBase64Url(sigStr);
    return await crypto.subtle.verify('HMAC', key, sigBytes, encoder.encode(payload));
  } catch {
    return false;
  }
}

/**
 * Returns local calendar date (YYYY-MM-DD) and local hour (0..23) for an IANA timezone.
 */
export function getLocalClock(timeZone: string, date: Date = new Date()): {
  localDateISO: string;
  localHour: number;
} {
  let validTz = timeZone || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: validTz }).format(date);
  } catch {
    validTz = 'UTC';
  }

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: validTz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return {
    localDateISO: `${map.year}-${map.month}-${map.day}`,
    localHour: Number(map.hour),
  };
}
