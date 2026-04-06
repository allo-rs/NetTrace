// ─────────────────────────────────────────────────────────────────
// Shared API helpers & utility functions for NetTrace
// ─────────────────────────────────────────────────────────────────

/** The DNS probe domain – injected by Go template in index.html */
export function getDomain(): string {
  const d = (window as any).__NETTRACE_DOMAIN__;
  if (d && typeof d === 'string' && !d.startsWith('{{')) return d;
  return location.hostname;
}

// ── Constants ────────────────────────────────────────────────────
export const DNS_TIMEOUT_MS = 6000;
export const POLL_INTERVAL_MS = 800;
export const LEAK_PROBE_COUNT = 5;
export const LEAK_TIMEOUT_MS = 10000;

// ── Types ────────────────────────────────────────────────────────

export interface GeoInfo {
  city?: string;
  regionName?: string;
  country?: string;
  isp?: string;
  org?: string;
  lat?: number;
  lon?: number;
}

export interface TagItem {
  cls: string;
  text: string;
}

// ── Utility functions ────────────────────────────────────────────

/** Generate random lowercase alphanumeric token */
export function randToken(len = 12): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)]!;
  return s;
}

/** Sleep for ms milliseconds */
export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** Convert GeoInfo to tag array */
export function geoToTags(geo: GeoInfo | null | undefined): TagItem[] {
  if (!geo) return [];
  const tags: TagItem[] = [];
  const loc = [geo.city, geo.regionName].filter(Boolean).join(' · ');
  if (loc) tags.push({ cls: 'loc', text: loc });
  if (geo.country) tags.push({ cls: 'cty', text: geo.country });
  const isp = geo.isp || geo.org;
  if (isp) tags.push({ cls: 'isp', text: isp });
  return tags;
}

/** Check if IP is a private/reserved address */
export function isPrivateIP(ip: string): boolean {
  return /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|::1$|fe80|fc[0-9a-f]{2}:|fd)/i.test(ip);
}

/** Check if IP is a public address */
export function isPublicIP(ip: string): boolean {
  if (!ip) return false;
  if (ip.includes(':'))
    return !ip.startsWith('fe80') && !ip.startsWith('fc') && !ip.startsWith('fd') && ip !== '::1';
  const parts = ip.split('.').map(Number);
  if (parts[0] === 10) return false;
  if (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) return false;
  if (parts[0] === 192 && parts[1] === 168) return false;
  if (parts[0] === 127) return false;
  return true;
}

/** Escape HTML entities */
export function escapeHTML(s: string | undefined | null): string {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

/** Simple hash function for fingerprint strings */
export function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const chr = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}


