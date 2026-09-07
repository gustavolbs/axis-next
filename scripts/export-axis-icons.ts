#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Icon rasterization is plain Node file and buffer work.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

import { PNG } from "pngjs";

import { AXIS_BRAND_ASSET_PATHS } from "./lib/axis-brand.ts";
import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

const REPO_ROOT = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const SOURCE_MARK = "assets/axis/axis-mark-source.png";

/**
 * The macOS "pre-Tahoe" safe area: an opaque 824x824 body inset 100px inside a
 * 1024x1024 canvas. Upstream documents the same geometry in assets/README.md.
 */
const MAC_CANVAS = 1024;
const MAC_BODY = 824;
const MAC_INSET = (MAC_CANVAS - MAC_BODY) / 2;

/** Approximates the macOS/iOS squircle closely enough at every shipped size. */
const CORNER_RADIUS_RATIO = 0.2237;

/** 4x4 samples per pixel: enough to keep the corner curve smooth down to 16px. */
const SUPERSAMPLES = 4;

const WEB_FAVICON_ICO_SIZES = [16, 32, 48] as const;

interface Rgba {
  readonly data: Buffer;
  readonly side: number;
}

function readSourceMark(): PNG {
  return PNG.sync.read(NodeFS.readFileSync(NodePath.join(REPO_ROOT, SOURCE_MARK)));
}

function samplePixel(source: PNG, x: number, y: number, channel: number): number {
  const cx = Math.min(Math.max(x, 0), source.width - 1);
  const cy = Math.min(Math.max(y, 0), source.height - 1);
  return source.data[(cy * source.width + cx) * 4 + channel]!;
}

function sampleBilinear(source: PNG, fx: number, fy: number, channel: number): number {
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const top =
    samplePixel(source, x0, y0, channel) * (1 - tx) + samplePixel(source, x0 + 1, y0, channel) * tx;
  const bottom =
    samplePixel(source, x0, y0 + 1, channel) * (1 - tx) +
    samplePixel(source, x0 + 1, y0 + 1, channel) * tx;
  return top * (1 - ty) + bottom * ty;
}

/** Fraction of the pixel that falls inside the rounded square, for antialiasing. */
function roundedSquareCoverage(x: number, y: number, side: number, radius: number): number {
  let inside = 0;
  for (let sampleY = 0; sampleY < SUPERSAMPLES; sampleY++) {
    for (let sampleX = 0; sampleX < SUPERSAMPLES; sampleX++) {
      const px = x + (sampleX + 0.5) / SUPERSAMPLES;
      const py = y + (sampleY + 0.5) / SUPERSAMPLES;
      const cx = Math.min(Math.max(px, radius), side - radius);
      const cy = Math.min(Math.max(py, radius), side - radius);
      const dx = px - cx;
      const dy = py - cy;
      if (dx * dx + dy * dy <= radius * radius) inside++;
    }
  }
  return inside / (SUPERSAMPLES * SUPERSAMPLES);
}

/**
 * Renders the mark as a full-bleed rounded square. The source is a flat, square,
 * corner-less composition precisely so this mask owns the icon silhouette at
 * every size instead of resampling corners that were baked in at one size.
 */
function renderBody(source: PNG, side: number): Rgba {
  const radius = side * CORNER_RADIUS_RATIO;
  const data = Buffer.alloc(side * side * 4);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const coverage = roundedSquareCoverage(x, y, side, radius);
      if (coverage === 0) continue;
      const fx = ((x + 0.5) / side) * (source.width - 1);
      const fy = ((y + 0.5) / side) * (source.height - 1);
      const offset = (y * side + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        data[offset + channel] = Math.round(sampleBilinear(source, fx, fy, channel));
      }
      data[offset + 3] = Math.round(coverage * 255);
    }
  }
  return { data, side };
}

function padToCanvas(body: Rgba, canvasSide: number, inset: number): Rgba {
  const data = Buffer.alloc(canvasSide * canvasSide * 4);
  for (let y = 0; y < body.side; y++) {
    body.data.copy(
      data,
      ((y + inset) * canvasSide + inset) * 4,
      y * body.side * 4,
      (y + 1) * body.side * 4,
    );
  }
  return { data, side: canvasSide };
}

function encode({ data, side }: Rgba): Buffer {
  const png = new PNG({ width: side, height: side });
  data.copy(png.data);
  return PNG.sync.write(png, { deflateLevel: 9 });
}

function main(): void {
  const check = NodeProcess.argv.includes("--check");
  const source = readSourceMark();

  const bodyCache = new Map<number, Rgba>();
  const body = (side: number): Rgba => {
    const cached = bodyCache.get(side);
    if (cached) return cached;
    const rendered = renderBody(source, side);
    bodyCache.set(side, rendered);
    return rendered;
  };

  const outputs: Array<{ readonly relativePath: string; readonly contents: Buffer }> = [
    {
      relativePath: AXIS_BRAND_ASSET_PATHS.macIconPng,
      contents: encode(padToCanvas(body(MAC_BODY), MAC_CANVAS, MAC_INSET)),
    },
    {
      relativePath: AXIS_BRAND_ASSET_PATHS.linuxIconPng,
      contents: encode(body(MAC_CANVAS)),
    },
    {
      relativePath: AXIS_BRAND_ASSET_PATHS.webFavicon16Png,
      contents: encode(body(16)),
    },
    {
      relativePath: AXIS_BRAND_ASSET_PATHS.webFavicon32Png,
      contents: encode(body(32)),
    },
    {
      relativePath: AXIS_BRAND_ASSET_PATHS.webAppleTouchIconPng,
      contents: encode(body(180)),
    },
    {
      relativePath: AXIS_BRAND_ASSET_PATHS.windowsIconIco,
      contents: encodePngIco(
        WINDOWS_ICON_SIZES.map((size) => ({ size, contents: encode(body(size)) })),
      ),
    },
    {
      relativePath: AXIS_BRAND_ASSET_PATHS.webFaviconIco,
      contents: encodePngIco(
        WEB_FAVICON_ICO_SIZES.map((size) => ({ size, contents: encode(body(size)) })),
      ),
    },
  ];

  const stale: string[] = [];
  for (const output of outputs) {
    const absolutePath = NodePath.join(REPO_ROOT, output.relativePath);
    if (check) {
      const current = NodeFS.existsSync(absolutePath) ? NodeFS.readFileSync(absolutePath) : null;
      if (!current || !current.equals(output.contents)) stale.push(output.relativePath);
      continue;
    }
    NodeFS.mkdirSync(NodePath.dirname(absolutePath), { recursive: true });
    NodeFS.writeFileSync(absolutePath, output.contents);
    NodeProcess.stdout.write(`wrote ${output.relativePath}\n`);
  }

  if (check && stale.length > 0) {
    NodeProcess.stderr.write(
      `Axis icons are out of date with ${SOURCE_MARK}. Run \`vp run icons:export:axis\`:\n${stale
        .map((path) => `  ${path}`)
        .join("\n")}\n`,
    );
    NodeProcess.exit(1);
  }
  if (check) NodeProcess.stdout.write("Axis icons match their source mark.\n");
}

main();
