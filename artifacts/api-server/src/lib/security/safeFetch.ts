import { lookup } from "dns/promises";
import { isIP } from "net";
import { Agent } from "undici";
import { logger } from "../logger.js";

/**
 * SSRF-safe fetch.
 *
 * The agentic provider features let admins paste a base_url which the server
 * then calls. Without guards, an attacker (or compromised admin account)
 * could pivot to internal services — RFC1918 ranges, link-local
 * (169.254.169.254 cloud metadata), loopback, IPv6 ULA, etc.
 *
 * This wrapper:
 *   1. Enforces http/https schemes only
 *   2. Resolves the hostname via DNS and rejects forbidden IP ranges
 *   3. Disables redirect following (prevents redirect-to-private bypass)
 *   4. Enforces a hard timeout
 *
 * `allowLocalhost` carves out the legitimate Ollama-on-localhost case.
 * Default is false; provider-agent enables it only for the ollama provider.
 */

const PRIVATE_IPV4_RANGES: Array<[string, number]> = [
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["169.254.0.0", 16], // link-local + AWS/GCP/Azure metadata 169.254.169.254
  ["100.64.0.0", 10], // CGNAT
  ["192.0.0.0", 24], // IETF protocol assignments
  ["198.18.0.0", 15], // benchmarking
  ["0.0.0.0", 8], // current network
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved
];

const LOOPBACK_IPV4 = "127.0.0.0";
const LOOPBACK_IPV4_PREFIX = 8;

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return -1;
  }
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function inRange(ip: string, base: string, prefixLen: number): boolean {
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(base);
  if (ipInt < 0 || baseInt < 0) return false;
  const mask = prefixLen === 0 ? 0 : (0xffffffff << (32 - prefixLen)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

function isPrivateIPv4(ip: string, allowLoopback: boolean): boolean {
  if (inRange(ip, LOOPBACK_IPV4, LOOPBACK_IPV4_PREFIX)) {
    return !allowLoopback;
  }
  return PRIVATE_IPV4_RANGES.some(([base, prefix]) => inRange(ip, base, prefix));
}

function isPrivateIPv6(ip: string, allowLoopback: boolean): boolean {
  // Normalize lower-case
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "0:0:0:0:0:0:0:1") return !allowLoopback;
  if (lower.startsWith("::ffff:")) {
    // IPv4-mapped — extract IPv4 portion
    const v4 = lower.slice(7);
    if (isIP(v4) === 4) return isPrivateIPv4(v4, allowLoopback);
  }
  // fc00::/7 Unique Local Addresses
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;
  // fe80::/10 link-local
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;
  // ::/128 unspecified
  if (lower === "::" || lower === "0:0:0:0:0:0:0:0") return true;
  return false;
}

function isPrivateIp(ip: string, allowLoopback: boolean): boolean {
  const v = isIP(ip);
  if (v === 4) return isPrivateIPv4(ip, allowLoopback);
  if (v === 6) return isPrivateIPv6(ip, allowLoopback);
  return true; // unknown → block
}

export type SafeFetchOptions = RequestInit & {
  allowLocalhost?: boolean;
  timeoutMs?: number;
};

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<Response> {
  const { allowLocalhost = false, timeoutMs = 15000, ...init } = opts;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError("Invalid URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SsrfBlockedError(`Disallowed protocol: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname;
  // Reject userinfo (e.g. http://user:pass@evil/)
  if (parsed.username || parsed.password) {
    throw new SsrfBlockedError("URL credentials are not allowed");
  }

  // Resolve and validate. If the hostname is an IP literal, "resolution" is
  // just that IP. Otherwise we DNS-resolve, validate every record, and pin
  // the connect() to the first validated address — closing the DNS-rebinding
  // TOCTOU window between validation and the actual TCP connect.
  let pinnedAddress: string;
  let pinnedFamily: 4 | 6;

  if (isIP(hostname)) {
    if (isPrivateIp(hostname, allowLocalhost)) {
      throw new SsrfBlockedError(`Blocked private/internal IP: ${hostname}`);
    }
    pinnedAddress = hostname;
    pinnedFamily = isIP(hostname) === 6 ? 6 : 4;
  } else {
    let resolved: Array<{ address: string; family: number }>;
    try {
      resolved = await lookup(hostname, { all: true });
    } catch (err) {
      logger.warn({ err, hostname }, "DNS lookup failed in safeFetch");
      throw new SsrfBlockedError(`DNS resolution failed for ${hostname}`);
    }
    if (resolved.length === 0) {
      throw new SsrfBlockedError(`No DNS records for ${hostname}`);
    }
    for (const { address } of resolved) {
      if (isPrivateIp(address, allowLocalhost)) {
        throw new SsrfBlockedError(
          `Hostname ${hostname} resolves to blocked address ${address}`,
        );
      }
    }
    const first = resolved[0]!;
    pinnedAddress = first.address;
    pinnedFamily = first.family === 6 ? 6 : 4;
  }

  // Custom undici Agent that hijacks DNS lookup to return the pre-validated
  // IP. The TLS SNI / Host header still come from the original URL hostname,
  // so virtual-hosted HTTPS keeps working.
  const dispatcher = new Agent({
    connect: {
      lookup: (
        _hostname: string,
        _options: unknown,
        callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
      ) => {
        callback(null, pinnedAddress, pinnedFamily);
      },
    },
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(rawUrl, {
      ...init,
      redirect: "manual", // prevent redirect-to-private bypass
      signal: init.signal ?? controller.signal,
      // @ts-expect-error: dispatcher is undici-specific extension to fetch
      dispatcher,
    });
    return response;
  } finally {
    clearTimeout(timer);
    // Close the agent so we don't leak sockets between calls.
    void dispatcher.close().catch(() => {});
  }
}
