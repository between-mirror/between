// Between Mirror — demo mode: the real application, reading frozen answers.
//
// The browser demo runs the SAME React app as the installed product. The only difference is this
// file: every `/api/*` read is answered from a static JSON file captured off the real server
// (`npm run demo:export`), and every write is refused.
//
// It is a fetch shim rather than a swapped-out API client on purpose. The client is not the only
// thing that can reach the network — a stray fetch anywhere in the app, now or later, would escape a
// client-level mock and silently try to talk to an origin that does not exist. Patching `fetch`
// itself means there is exactly one door, and this file is standing in it. Anything not in the
// manifest fails closed and loudly.
//
// The demo therefore makes no request to anything but its own origin, which is asserted in CI rather
// than promised here.

export interface DemoManifest { [urlKey: string]: string }

/** Path→file lookup key: sorted query string, so ?a=1&b=2 and ?b=2&a=1 are one entry. */
export function urlKey(url: string): string {
  const [path, qs] = url.split('?');
  if (!qs) return path;
  const sorted = [...new URLSearchParams(qs).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  return sorted ? `${path}?${sorted}` : path;
}

/** The demo's honest refusal for anything that would change state. Voice: plain, never cute. */
const READ_ONLY_BODY = {
  error: 'This is the demo, so nothing here can be changed.',
  detail:
    'The demo reads a frozen copy of a fictional archive. Importing, labelling, freezing a reading, '
    + 'exporting and deleting all work in the real application, on your own machine — they are turned '
    + 'off here because there is nothing of yours to change.',
};

/** Reads the demo cannot answer. Distinct from a write: this is a gap, and it says so. */
const NOT_CAPTURED_BODY = {
  error: 'That part of the demo was not captured.',
  detail: 'The demo holds a fixed set of pre-computed views. This one is not among them.',
};

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

export interface InstallOptions {
  /** Where the captured JSON lives, relative to the page. */
  dataBase: string;
  manifest: DemoManifest;
  /**
   * The handful of POSTs the demo can answer, keyed `POST <path> <exact JSON body>`.
   *
   * Only Ask's planner, and only for the questions captured off the real route. Everything else that
   * posts is still refused — this is a narrow exception for the one read-shaped POST in the API, not
   * a general write path. A body that differs by even a filter is not in the map and is refused,
   * which is why the demo offers fixed questions rather than a text box.
   */
  posts?: DemoManifest;
  /** Injected for testing; defaults to the real global fetch. */
  baseFetch?: typeof fetch;
}

/**
 * Install the shim. Returns the previous fetch so a test can restore it.
 */
export function installDemoFetch(opts: InstallOptions): typeof fetch {
  const original = opts.baseFetch ?? globalThis.fetch.bind(globalThis);

  const shim: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input
      : input instanceof URL ? input.toString()
      : (input as Request).url;
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();

    // Anything that is not our API — the app's own assets, chiefly — is none of this shim's business.
    const apiAt = url.indexOf('/api/');
    if (apiAt === -1) return original(input as RequestInfo, init);

    if (method !== 'GET' && method !== 'HEAD') {
      // Ask's planner is a POST that only reads. If this exact question was captured off the real
      // route, answer it; otherwise fall through to the refusal below.
      const body = init?.body ?? (input instanceof Request ? undefined : undefined);
      if (typeof body === 'string' && opts.posts) {
        const postKey = `${method} ${url.slice(apiAt)} ${body}`;
        const file = opts.posts[postKey];
        if (file) {
          const res = await original(`${opts.dataBase}/${file}`, { headers: { accept: 'application/json' } });
          if (res.ok) {
            return new Response(await res.text(), { status: 200, headers: { 'content-type': 'application/json' } });
          }
        }
      }
      // A write in the demo is not an error to be hidden; it is a thing the demo genuinely cannot do,
      // and the app renders this message. 405 rather than 403: the route exists, the verb does not.
      return json(READ_ONLY_BODY, 405);
    }

    const key = urlKey(url.slice(apiAt));
    const file = opts.manifest[key];
    if (!file) return json({ ...NOT_CAPTURED_BODY, requested: key }, 501);

    // Same-origin, relative. This is the only network call the demo ever makes.
    const res = await original(`${opts.dataBase}/${file}`, { headers: { accept: 'application/json' } });
    if (!res.ok) return json({ ...NOT_CAPTURED_BODY, requested: key }, 502);
    return new Response(await res.text(), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  globalThis.fetch = shim;
  return original;
}
