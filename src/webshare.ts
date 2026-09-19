/**
 * Authorises the machine's current public IP with Webshare, so the residential
 * proxy accepts it without credentials.
 *
 * A GitHub runner gets a fresh IP every run, so this has to happen at the start
 * of each job. Webshare caps how many authorisations an account may hold, so
 * stale runner IPs are pruned rather than accumulated until the API refuses.
 *
 *   WEBSHARE_API_KEY  required
 *   npm run webshare:whitelist            # add this machine's IP
 *   npm run webshare:whitelist -- --list  # show current authorisations
 */
import { log } from "./lib/logger.js";

const API = "https://proxy.webshare.io/api/v2";

interface IpAuthorization {
  id: number;
  ip_address: string;
  created_at: string;
  last_used_at: string | null;
}

function key(): string {
  const k = process.env.WEBSHARE_API_KEY?.trim();
  if (!k) throw new Error("WEBSHARE_API_KEY is not set.");
  return k;
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Token ${key()}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    throw new Error(`Webshare ${init.method ?? "GET"} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return body as T;
}

/** Whatever the outside world sees as this machine's address. */
export async function publicIp(): Promise<string> {
  for (const url of ["https://api.ipify.org", "https://ifconfig.me/ip", "https://icanhazip.com"]) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      const ip = (await res.text()).trim();
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip;
    } catch {
      /* try the next one */
    }
  }
  throw new Error("Could not determine this machine's public IP.");
}

export async function list(): Promise<IpAuthorization[]> {
  const res = await api<{ results: IpAuthorization[] }>("/proxy/ipauthorization/");
  return res.results ?? [];
}

export async function authorize(ip: string): Promise<IpAuthorization | null> {
  const existing = await list();
  const already = existing.find((a) => a.ip_address === ip);
  if (already) {
    log.info(`${ip} is already authorised (id ${already.id})`);
    return already;
  }

  try {
    const created = await api<IpAuthorization>("/proxy/ipauthorization/", {
      method: "POST",
      body: JSON.stringify({ ip_address: ip }),
    });
    log.info(`Authorised ${ip} (id ${created.id})`);
    return created;
  } catch (err) {
    // The account has a cap; free the oldest slot and retry once.
    if (!/limit|maximum|already/i.test((err as Error).message)) throw err;
    const oldest = [...existing].sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
    if (!oldest) throw err;
    log.warn(`Authorisation limit reached — removing the oldest entry ${oldest.ip_address}`);
    await remove(oldest.id);
    const created = await api<IpAuthorization>("/proxy/ipauthorization/", {
      method: "POST",
      body: JSON.stringify({ ip_address: ip }),
    });
    log.info(`Authorised ${ip} (id ${created.id})`);
    return created;
  }
}

export async function remove(id: number): Promise<void> {
  await api(`/proxy/ipauthorization/${id}/`, { method: "DELETE" });
  log.info(`Removed authorisation ${id}`);
}

async function main(): Promise<void> {
  if (process.argv.includes("--list")) {
    const all = await list();
    console.log(`${all.length} authorisation(s):`);
    for (const a of all) {
      console.log(`  ${a.id}  ${a.ip_address}  created ${a.created_at.slice(0, 19)}  last used ${a.last_used_at?.slice(0, 19) ?? "never"}`);
    }
    return;
  }

  const ip = process.env.WEBSHARE_IP?.trim() || (await publicIp());
  log.info(`This machine's public IP: ${ip}`);
  await authorize(ip);

  const all = await list();
  console.log(`\nAuthorised IPs (${all.length}):`);
  for (const a of all) console.log(`  ${a.ip_address}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`\nFailed: ${(err as Error).message}`);
    process.exitCode = 1;
  });
}
