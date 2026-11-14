/**
 * Client address for partner rate limits.
 *
 * Behind the selfhost gateway every request's socket peer is the gateway,
 * so keying limits on it makes one global bucket. The gateway already
 * computes the real client ($client_key: Cloudflare's connecting IP when the
 * request came through Cloudflare, else the peer after real_ip handling) and
 * OVERWRITES `X-Real-IP` with it (infra/selfhost/gateway/nginx.conf). The
 * API trusts that header only when the socket peer is inside
 * PARTNER_TRUSTED_PROXY_CIDRS; from anyone else it is ignored, so a client
 * cannot choose its own bucket.
 *
 * Hosting must: set PARTNER_TRUSTED_PROXY_CIDRS to the gateway's address
 * only (the selfhost stack pins it on the app network), keep the http-level
 * `proxy_set_header X-Real-IP $client_key` in effect on the partner host
 * block (no proxy_set_header of its own), and keep the API port unpublished
 * so nothing else can reach it.
 *
 * Without the trusted range every client would share the gateway's bucket,
 * so one client could lock real caseworkers out of sign-in. The realm is
 * therefore refused, not mounted, when it is unset (partnerRealmRefusal).
 */
import { BlockList, isIP } from 'node:net';

import type { FastifyRequest } from 'fastify';

export const PARTNER_CLIENT_ADDRESS_HEADER = 'x-real-ip';

/** Parses "10.0.0.0/8, 172.18.0.0/16, fd00::/8". Returns null for empty; throws on invalid. */
export function parseTrustedProxyCidrs(value: string | undefined): BlockList | null {
  const entries = (value ?? '').split(',').map(entry => entry.trim()).filter(Boolean);
  if (entries.length === 0) return null;
  const list = new BlockList();
  for (const entry of entries) {
    const [address, prefixText] = entry.split('/');
    const family = isIP(address);
    const prefix = Number(prefixText);
    const maxPrefix = family === 6 ? 128 : 32;
    if (!family || prefixText === undefined || !Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) {
      throw new Error(`Invalid trusted proxy CIDR: ${entry}`);
    }
    list.addSubnet(address, prefix, family === 6 ? 'ipv6' : 'ipv4');
  }
  return list;
}

function normalizeAddress(address: string): { address: string; family: 'ipv4' | 'ipv6' } | null {
  const unmapped = address.startsWith('::ffff:') && isIP(address.slice(7)) === 4 ? address.slice(7) : address;
  const family = isIP(unmapped);
  if (family === 4) return { address: unmapped, family: 'ipv4' };
  if (family === 6) return { address: unmapped, family: 'ipv6' };
  return null;
}

/** The real client address: the gateway's X-Real-IP from a trusted peer, else the socket peer. */
export function partnerClientAddress(request: FastifyRequest, trustedProxies: BlockList | null): string {
  const peer = normalizeAddress(request.socket?.remoteAddress ?? request.ip ?? '');
  if (trustedProxies && peer && trustedProxies.check(peer.address, peer.family)) {
    const header = request.headers[PARTNER_CLIENT_ADDRESS_HEADER];
    const forwarded = typeof header === 'string' ? normalizeAddress(header.trim()) : null;
    if (forwarded) return forwarded.address;
  }
  return peer?.address ?? 'unknown';
}

/** The eight 16-bit groups of a valid IPv6 address (an embedded IPv4 tail becomes two groups). */
function ipv6Groups(address: string): number[] | null {
  if (isIP(address) !== 6) return null;
  let text = address.toLowerCase().split('%')[0];
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.includes('::') ? text.split('::') : [text, undefined];
  const parse = (part: string | undefined) => (part ? part.split(':').map(group => parseInt(group, 16)) : []);
  const front = parse(head);
  const back = parse(tail);
  const groups = tail === undefined ? front : [...front, ...Array(8 - front.length - back.length).fill(0), ...back];
  return groups.length === 8 && groups.every(group => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : null;
}

/**
 * The key partner rate limits use for a client address: an IPv4 address
 * (including an IPv4-mapped IPv6 one) as IPv4, an IPv6 address by its /64. One subscriber or device gets a whole /64,
 * so keying the full IPv6 address would let a single client rotate through
 * 2^64 fresh buckets. The gateway keys its partner zones the same way.
 */
export function partnerClientNetwork(address: string): string {
  const groups = ipv6Groups(address);
  if (!groups) return address;
  // IPv4-mapped (::ffff:a.b.c.d, also written ::ffff:hhhh:hhhh): the IPv4
  // client itself, never the /64 that every mapped address shares.
  if (groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff) {
    return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.');
  }
  return `${groups.slice(0, 4).map(group => group.toString(16)).join(':')}::/64`;
}

/**
 * Why the partner realm must stay off, or null when it may be mounted (all
 * three settings present) or was not asked for (none present). A partial
 * configuration is refused rather than run with weaker protection.
 */
export function partnerRealmRefusal(settings: {
  publicOrigin: string | undefined;
  totpKey: Buffer | null;
  trustedProxies: BlockList | null;
}): string | null {
  const missing = [
    settings.publicOrigin ? null : 'PARTNER_PUBLIC_ORIGIN',
    settings.totpKey ? null : 'PARTNER_TOTP_KEY',
    settings.trustedProxies ? null : 'PARTNER_TRUSTED_PROXY_CIDRS',
  ].filter((name): name is string => name !== null);
  if (missing.length === 0 || missing.length === 3) return null;
  const why = settings.trustedProxies
    ? ''
    : ': without the gateway range every client shares one rate-limit bucket and could lock caseworkers out';
  return `Partner realm refused and left off; missing or invalid ${missing.join(', ')}${why}`;
}
