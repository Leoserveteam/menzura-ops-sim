import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';

/**
 * Fail-closed network guard for this process. Anything that would leave the
 * machine is blocked and logged unless its host is on the allowlist. In
 * offline mode the allowlist is empty. Local sockets (loopback, unix paths)
 * stay open because the Agent SDK talks to its own subprocess over stdio.
 */
export interface NetworkGuard {
  allowed: Set<string>;
  blocked: number;
}

type Sink = (entry: { at: string; host: string; port?: number | string; via: string; outcome: 'allowed' | 'blocked' }) => void;

let installed: NetworkGuard | null = null;
let sink: Sink = () => {};

const LOCAL = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

export class NetworkBlockedError extends Error {
  constructor(host: string, via: string) {
    super(`Network call to "${host}" blocked by the sim network guard (${via}). Nothing in this simulation may leave the machine.`);
  }
}

export function anthropicHosts(): string[] {
  const hosts = ['api.anthropic.com'];
  const base = process.env.ANTHROPIC_BASE_URL;
  if (base) {
    try {
      hosts.push(new URL(base).hostname);
    } catch {
      /* ignore malformed base url */
    }
  }
  return hosts;
}

export function installNetworkGuard(allowedHosts: string[], logSink: Sink): NetworkGuard {
  sink = logSink;
  if (installed) {
    installed.allowed = new Set(allowedHosts);
    return installed;
  }
  const guard: NetworkGuard = { allowed: new Set(allowedHosts), blocked: 0 };
  installed = guard;

  const check = (host: string | undefined, port: number | string | undefined, via: string): void => {
    const h = (host ?? '').replace(/^\[|\]$/g, '').toLowerCase();
    if (!h || LOCAL.has(h) || h.startsWith('/')) return;
    const ok = guard.allowed.has(h);
    sink({ at: new Date().toISOString(), host: h, port, via, outcome: ok ? 'allowed' : 'blocked' });
    if (!ok) {
      guard.blocked++;
      throw new NetworkBlockedError(h, via);
    }
  };

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    check(url.hostname, url.port, 'fetch');
    return realFetch(input, init);
  }) as typeof fetch;

  for (const mod of [http, https] as any[]) {
    const realRequest = mod.request;
    const realGet = mod.get;
    const hostOf = (args: any[]) => {
      const a = args[0];
      if (typeof a === 'string' || a instanceof URL) return new URL(String(a)).hostname;
      return a?.hostname ?? a?.host;
    };
    mod.request = (...args: any[]) => {
      check(hostOf(args), undefined, mod === https ? 'https.request' : 'http.request');
      return realRequest.apply(mod, args);
    };
    mod.get = (...args: any[]) => {
      check(hostOf(args), undefined, mod === https ? 'https.get' : 'http.get');
      return realGet.apply(mod, args);
    };
  }

  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: any[]) {
    const a = args[0];
    let host: string | undefined;
    let port: number | string | undefined;
    if (Array.isArray(a)) {
      host = a[0]?.host;
    } else if (typeof a === 'object' && a) {
      host = a.path ? `/${a.path}` : (a.host ?? 'localhost');
      port = a.port;
    } else if (typeof a === 'number' || (typeof a === 'string' && /^\d+$/.test(a))) {
      port = a;
      host = typeof args[1] === 'string' ? args[1] : 'localhost';
    } else if (typeof a === 'string') {
      host = `/${a}`; // unix socket path
    }
    check(host, port, 'net.connect');
    return (realConnect as any).apply(this, args);
  } as any;

  syncBuiltinESMExports();
  return guard;
}
