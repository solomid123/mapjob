/**
 * Where the backend is.
 *
 * This was the same eleven lines copy-pasted into nine files, which was
 * harmless while the answer was always localhost and became a liability the
 * moment the app could be served from somewhere the API is not. One
 * definition now, and the rule is:
 *
 *   1. `VITE_API_BASE_URL`, if the build was given one. A deployed build
 *      must be: the SPA on Cloudflare Pages and the API on a tunnel are two
 *      different hostnames and nothing can guess the second from the first.
 *   2. Otherwise, same host, port 8000 -- which is the desk, and also the
 *      phone on the same wi-fi opening the dev server by IP.
 *
 * The one case worth spelling out: a page served over https that falls
 * through to rule 2 would ask for `http://host:8000`, and the browser blocks
 * that as mixed content before it leaves the page. So under https with no
 * configured base we use the page's own origin, on the assumption that
 * something in front is routing /api onwards -- wrong, perhaps, but wrong in
 * a way that produces a 404 you can read instead of a silence you cannot.
 *
 * The exception to the exception is the iOS shell, which Capacitor serves
 * from `https://localhost` with no server behind it. There, https is a
 * detail of how the bundle is loaded and not a claim about where the API is,
 * so localhost keeps meaning port 8000 -- and browsers treat localhost as
 * trustworthy, so nothing is blocked.
 */

function resolveBase(): string {
  const configured = import.meta.env.VITE_API_BASE_URL;
  if (configured) return String(configured).replace(/\/+$/, '');

  if (typeof window === 'undefined') return 'http://localhost:8000';

  const { protocol, hostname, origin } = window.location;
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  if (protocol === 'https:' && !isLocal) return origin.replace(/\/+$/, '');
  return `http://${hostname || 'localhost'}:8000`;
}

/** The API's address, with no trailing slash. */
export const API_BASE = resolveBase();

/** The same address for websockets: `http` becomes `ws`, `https` becomes `wss`. */
export const API_WS_BASE = API_BASE.replace(/^http/, 'ws');

export default API_BASE;

