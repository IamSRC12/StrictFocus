/**
 * blocker/dnsResolver.js
 * Resolves whitelisted domains (and common subdomains) to their IP addresses.
 * Returns a flat Set<string> of IPv4 addresses.
 */

const dns = require('dns');
const { promisify } = require('util');

const resolve4 = promisify(dns.resolve4);

const COMMON_PREFIXES = [
  '', 'www', 'static', 'cdn', 'api', 'video', 'media',
  'assets', 'player', 'live', 'stream', 'app', 'auth',
  'img', 'images', 'upload', 'download', 'files'
];

/**
 * Resolves all IPs for a single domain (tries multiple subdomain prefixes).
 * @param {string} baseDomain
 * @returns {Promise<Set<string>>}
 */
async function resolveOneDomain(baseDomain) {
  const ips = new Set();
  const toTry = COMMON_PREFIXES.map(p => p ? `${p}.${baseDomain}` : baseDomain);

  await Promise.allSettled(
    toTry.map(async (hostname) => {
      try {
        const addrs = await resolve4(hostname);
        addrs.forEach(ip => ips.add(ip));
      } catch { /* ignore NXDOMAIN / ENOTFOUND */ }
    })
  );
  return ips;
}

/**
 * Resolves all whitelisted domains and returns a flat Set of IPs.
 * @param {string[]} domains
 * @param {function} onProgress - called with (resolvedDomain, ipCount) as each resolves
 * @returns {Promise<Set<string>>}
 */
async function resolveWhitelist(domains, onProgress) {
  const allIps = new Set();

  for (const domain of domains) {
    const ips = await resolveOneDomain(domain);
    ips.forEach(ip => allIps.add(ip));
    if (onProgress) onProgress(domain, ips.size);
  }

  return allIps;
}

module.exports = { resolveWhitelist, resolveOneDomain };
