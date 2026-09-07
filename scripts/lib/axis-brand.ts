import type { IconOverride } from "./brand-assets.ts";

/**
 * Axis-owned desktop branding, applied only while packaging a desktop artifact.
 *
 * The repository, dev server, hosted web app, and every internal identifier keep
 * their upstream T3 Code names so upstream syncs stay mechanical
 * (see docs/axis/UPSTREAM.md). Only the shipped bundle is branded as Axis.
 */

/**
 * Distinct from upstream's `com.t3tools.t3code` so macOS treats Axis as its own
 * app. It does not move application data: the desktop app pins its user-data
 * directory to `t3code` independently of the bundle identity.
 */
export const AXIS_DESKTOP_APP_ID = "dev.axis.next.desktop";

export const AXIS_PRODUCT_NAME = "Axis";
export const AXIS_NIGHTLY_PRODUCT_NAME = "Axis (Nightly)";

export const AXIS_ARTIFACT_NAME = "Axis-${version}-${arch}.${ext}";

/**
 * Default electron-builder GitHub publish target. It is what puts `app-update.yml`
 * into the packaged app, which is what enables automatic updates at runtime.
 * `T3CODE_DESKTOP_UPDATE_REPOSITORY` still overrides it for forks and test feeds.
 */
export const AXIS_UPDATE_REPOSITORY = "gustavolbs/axis-next";

export const AXIS_BRAND_ASSET_PATHS = {
  macIconPng: "assets/axis/axis-macos-1024.png",
  linuxIconPng: "assets/axis/axis-universal-1024.png",
  windowsIconIco: "assets/axis/axis-windows.ico",
  webFaviconIco: "assets/axis/axis-web-favicon.ico",
  webFavicon16Png: "assets/axis/axis-web-favicon-16x16.png",
  webFavicon32Png: "assets/axis/axis-web-favicon-32x32.png",
  webAppleTouchIconPng: "assets/axis/axis-web-apple-touch-180.png",
} as const;

export function resolveAxisProductName(channel: "latest" | "nightly"): string {
  return channel === "nightly" ? AXIS_NIGHTLY_PRODUCT_NAME : AXIS_PRODUCT_NAME;
}

/**
 * Axis has a single mark, so both channels ship it. The nightly build stays
 * distinguishable through its product name and version.
 */
export function resolveAxisDesktopIconAssets() {
  return {
    macIconPng: AXIS_BRAND_ASSET_PATHS.macIconPng,
    linuxIconPng: AXIS_BRAND_ASSET_PATHS.linuxIconPng,
    windowsIconIco: AXIS_BRAND_ASSET_PATHS.windowsIconIco,
  };
}

/** Overrides the upstream favicons already copied into a packaged web client. */
export function resolveAxisWebIconOverrides(targetDirectory: string): ReadonlyArray<IconOverride> {
  return [
    {
      sourceRelativePath: AXIS_BRAND_ASSET_PATHS.webFaviconIco,
      targetRelativePath: `${targetDirectory}/favicon.ico`,
    },
    {
      sourceRelativePath: AXIS_BRAND_ASSET_PATHS.webFavicon16Png,
      targetRelativePath: `${targetDirectory}/favicon-16x16.png`,
    },
    {
      sourceRelativePath: AXIS_BRAND_ASSET_PATHS.webFavicon32Png,
      targetRelativePath: `${targetDirectory}/favicon-32x32.png`,
    },
    {
      sourceRelativePath: AXIS_BRAND_ASSET_PATHS.webAppleTouchIconPng,
      targetRelativePath: `${targetDirectory}/apple-touch-icon.png`,
    },
  ];
}

const TITLE_PATTERN = /<title>[^<]*<\/title>/u;

/**
 * Rewrites the bundled client's document title. The desktop window reads it
 * before the app sets its own title, so an unbranded title flashes without this.
 */
export function applyAxisDocumentTitle(html: string, productName: string): string {
  return html.replace(TITLE_PATTERN, `<title>${productName}</title>`);
}
