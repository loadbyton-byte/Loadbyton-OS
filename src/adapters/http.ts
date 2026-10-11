/** Bounded provider requests. Error messages deliberately exclude credentials and response payloads. */
export type Fetcher = typeof fetch;
export async function providerJson(name: string, url: string, init: RequestInit = {}, fetcher: Fetcher = fetch): Promise<any> {
  const res = await fetcher(url, { ...init, signal: init.signal ?? AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${name} request failed (HTTP ${res.status})`);
  return res.json();
}
