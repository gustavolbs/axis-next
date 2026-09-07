# Axis desktop releases and automatic updates

Axis ships as a rebranded build of the T3 Code desktop app. The repository, dev server, hosted web
app, and every internal identifier keep their upstream names; only the packaged artifact is Axis.
That keeps upstream syncs mechanical (see [the upstream policy](./UPSTREAM.md)).

## What packaging changes

`scripts/lib/axis-brand.ts` is the single place that owns the difference. Packaging applies:

- product name `Axis` (`Axis (Nightly)` on the nightly channel), which also names the app bundle,
  the DMG volume, and the macOS menu;
- bundle identifier `dev.axis.next.desktop`, deliberately distinct from upstream's
  `com.t3tools.t3code` so macOS treats an installed Axis as its own app rather than as another copy
  of T3 Code;
- artifacts named `Axis-<version>-<arch>.<ext>`;
- the [Axis icons](../../assets/axis/README.md) and the bundled client's favicons and title.

Nothing above applies to `vp run dev`, which stays T3 Code.

Application data is deliberately _not_ rebranded. The desktop app pins its Electron user-data
directory to `t3code` in
[DesktopEnvironment](../../apps/desktop/src/app/DesktopEnvironment.ts), and the server keeps using
`~/.t3`, so installing Axis over an existing T3 Code build keeps that build's projects, threads, and
credentials instead of stranding them under a new name.

## How updates reach an installed app

Axis uses T3's existing `electron-updater` integration rather than a second updater. The chain is:

```text
tag v<version>
  -> release-axis-macos.yml builds arm64 + x64
  -> artifacts are signed with the stable self-signed "Axis Code Signing" certificate
  -> the workflow rejects any ad-hoc (cdhash-pinned) signature
  -> the per-arch latest-mac.yml manifests are merged into one
  -> a GitHub Release is published on gustavolbs/axis-next
  -> the installed app, which packages app-update.yml pointing at that repository,
     finds the release, downloads the ZIP, and offers Restart / Later
```

`app-update.yml` only exists in the bundle when electron-builder had a publish target at packaging
time, and the app disables automatic updates without it. The target defaults to
`gustavolbs/axis-next`; set `T3CODE_DESKTOP_UPDATE_REPOSITORY=<owner>/<repo>` to point a build at a
different release feed.

The ZIP is the update payload and the DMG is for first or manual installs. Both must be attached to
the release, along with the blockmaps and `latest-mac.yml`.

## Why the app has to be signed

Squirrel.Mac, which `electron-updater` drives on macOS, validates a downloaded update against the
designated requirement of the running app. An ad-hoc signature pins that requirement to a per-build
cdhash, so each release would reject its successor. A certificate produces a certificate-pinned
requirement that stays stable across releases, and Squirrel does not care whether Apple issued it.

So Axis signs with one stable self-signed certificate. This buys automatic updates, not Gatekeeper
trust: a first install downloaded from a browser still needs the usual right-click -> Open. Removing
that prompt requires a paid Apple Developer ID and notarization.

## One-time signing setup

Run once on a Mac:

```bash
bash scripts/create-macos-signing-cert.sh
```

It writes `~/axis-signing/axis-code-signing.p12` with the common name `Axis Code Signing` and prints
the commands for the two repository secrets the release workflow requires:

```text
MAC_CSC_LINK            # base64 of the .p12
MAC_CSC_KEY_PASSWORD    # the password chosen during creation
```

Back up the `.p12` and its password somewhere durable and private. **Losing or rotating this
certificate breaks automatic updates for every already-installed copy**, which then have to be
reinstalled by hand. No Apple ID, Team ID, or notarization secret is involved.

## Cutting a release

1. Bump `version` in `apps/desktop/package.json`.
2. Merge that to `main`.
3. Tag and push: `git tag v<version> && git push origin v<version>`.

`release-axis-macos.yml` takes it from there. `workflow_dispatch` with an explicit version input
runs the same pipeline without a tag push.

The workflow fails the build rather than publishing when the icons are stale, a signing secret is
missing, the signature is not certificate-pinned, or `latest-mac.yml` is absent — each of those
would produce a release that cannot update.

## Local builds

```bash
vp run dist:desktop:dmg
```

Local artifacts are unsigned by default and land in `release/`. They carry the Axis name and icon
and a valid update feed, but macOS refuses to auto-update an unsigned build, so treat them as
throwaway installs. Add `--signed` with `CSC_LINK` and `CSC_KEY_PASSWORD` set to reproduce the
release signature locally. See
[the desktop artifact prerequisites](../operations/development.md#desktop-artifacts).
