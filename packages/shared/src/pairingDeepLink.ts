/**
 * Pairing deep-link helpers.
 *
 * Desktop pairing surfaces hand users a QR code. The QR can encode either a
 * web pairing URL (`https://host:port/pair#token=...`) or a `t3code://` mobile
 * deep link that opens the T3 mobile app directly. Mobile clients prefer the
 * deep link; web/desktop clients fall back to the web URL. Both representations
 * carry the same pairing URL, so the mobile app can unwrap either.
 */

export type MobilePairingScheme = "t3code" | "t3code-dev" | "t3code-preview";

const DEFAULT_SCHEME: MobilePairingScheme = "t3code";

/**
 * Encode a web pairing URL inside a `t3code://pair?pairingUrl=...` deep link
 * that the mobile app intercepts. Returns the web URL unchanged when the
 * caller does not want a deep link (e.g. a desktop-only endpoint).
 */
export function buildMobilePairingDeepLink(
  webPairingUrl: string,
  scheme: MobilePairingScheme = DEFAULT_SCHEME,
): string {
  const trimmed = webPairingUrl.trim();
  if (trimmed.length === 0) {
    return "";
  }
  return `${scheme}://pair?pairingUrl=${encodeURIComponent(trimmed)}`;
}

/**
 * True when the payload is a `t3code://` family deep link carrying a pairing
 * URL. The mobile app uses this to distinguish deep links from raw web URLs
 * before handing them to the regular pairing URL parser.
 */
export function isMobilePairingDeepLink(payload: string): boolean {
  if (!payload) return false;
  try {
    const url = new URL(payload.trim());
    return (
      url.protocol === "t3code:" ||
      url.protocol === "t3code-dev:" ||
      url.protocol === "t3code-preview:"
    );
  } catch {
    return false;
  }
}

/** Extract the web pairing URL from a mobile deep link, or pass it through. */
export function unwrapMobilePairingDeepLink(payload: string): string {
  const trimmed = payload.trim();
  if (!trimmed) return trimmed;
  try {
    const url = new URL(trimmed);
    if (
      url.protocol === "t3code:" ||
      url.protocol === "t3code-dev:" ||
      url.protocol === "t3code-preview:"
    ) {
      const inner = url.searchParams.get("pairingUrl");
      if (inner) return inner;
    }
  } catch {
    // fall through to raw
  }
  return trimmed;
}
