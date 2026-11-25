import { describe, expect, it } from 'vitest';

import { parseTrustedProxyCidrs, partnerClientNetwork, partnerRealmRefusal } from '../partnerNetwork.js';

const origin = 'https://partners.example.invalid';
const totpKey = Buffer.alloc(32, 7);
const trustedProxies = parseTrustedProxyCidrs('192.0.2.10/32');

describe('partnerRealmRefusal', () => {
  it('allows the realm only with the origin, TOTP key and trusted gateway range', () => {
    expect(partnerRealmRefusal({ publicOrigin: origin, totpKey, trustedProxies })).toBeNull();
  });

  it('stays quiet when no partner setting is present (realm not asked for)', () => {
    expect(partnerRealmRefusal({ publicOrigin: undefined, totpKey: null, trustedProxies: null })).toBeNull();
  });

  it('refuses the realm when PARTNER_TRUSTED_PROXY_CIDRS is unset, naming the lockout risk', () => {
    const refusal = partnerRealmRefusal({ publicOrigin: origin, totpKey, trustedProxies: parseTrustedProxyCidrs(undefined) });
    expect(refusal).toMatch(/PARTNER_TRUSTED_PROXY_CIDRS/);
    expect(refusal).toMatch(/lock caseworkers out/);
    expect(refusal).not.toMatch(/PARTNER_TOTP_KEY|PARTNER_PUBLIC_ORIGIN/);
  });

  it('refuses any other partial configuration and names what is missing', () => {
    expect(partnerRealmRefusal({ publicOrigin: origin, totpKey: null, trustedProxies })).toMatch(/PARTNER_TOTP_KEY/);
    expect(partnerRealmRefusal({ publicOrigin: undefined, totpKey, trustedProxies })).toMatch(/PARTNER_PUBLIC_ORIGIN/);
    expect(partnerRealmRefusal({ publicOrigin: undefined, totpKey: null, trustedProxies })).toMatch(
      /PARTNER_PUBLIC_ORIGIN, PARTNER_TOTP_KEY$/,
    );
  });

  it('never echoes a setting value in the refusal', () => {
    const refusal = partnerRealmRefusal({ publicOrigin: origin, totpKey: null, trustedProxies: null }) ?? '';
    expect(refusal).not.toContain(origin);
  });
});

describe('partnerClientNetwork', () => {
  it('keys IPv4 clients by address and IPv6 clients by their /64, whatever the spelling', () => {
    expect(partnerClientNetwork('203.0.113.7')).toBe('203.0.113.7');
    const sameSubnet = ['2001:db8:a:b::1', '2001:db8:a:b:ffff:ffff:ffff:fffe', '2001:DB8:A:B:0:0:0:9', '2001:db8:a:b:1::'];
    expect(new Set(sameSubnet.map(partnerClientNetwork))).toEqual(new Set(['2001:db8:a:b::/64']));
    expect(partnerClientNetwork('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(partnerClientNetwork('2001:db8:0:0:a::')).toBe('2001:db8:0:0::/64');
    expect(partnerClientNetwork('2001:db8:a:c::1')).toBe('2001:db8:a:c::/64');
    expect(partnerClientNetwork('64:ff9b::198.51.100.4')).toBe('64:ff9b:0:0::/64');
    expect(partnerClientNetwork('::1')).toBe('0:0:0:0::/64');
  });

  it('keys IPv4-mapped IPv6 clients as their IPv4 address, dotted or hex', () => {
    expect(partnerClientNetwork('::ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(partnerClientNetwork('::ffff:0102:0304')).toBe('1.2.3.4');
    expect(partnerClientNetwork('::FFFF:102:304')).toBe('1.2.3.4');
    expect(partnerClientNetwork('0:0:0:0:0:ffff:cb00:7107')).toBe('203.0.113.7');
    // Two mapped clients never share a key.
    expect(partnerClientNetwork('::ffff:198.51.100.4')).not.toBe(partnerClientNetwork('::ffff:198.51.100.5'));
    expect(partnerClientNetwork('unknown')).toBe('unknown');
  });
});
