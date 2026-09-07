# Axis brand icons

`axis-mark-source.png` is the source of truth for the Axis mark: a flat, square, full-bleed
composition with no rounded corners, no shadow, and no perspective. Every other file here is
generated from it:

```sh
vp run icons:export:axis   # regenerate
vp run icons:check:axis    # verify the tracked files match the source
```

Do not edit the generated PNG or ICO files directly. Replace `axis-mark-source.png` and rerun the
export instead.

The exporter owns the icon silhouette: it masks the source with a rounded square and emits the macOS
icon inside the classic safe area (an 824x824 body inset 100px in a 1024x1024 canvas). Keep the
source flat — a mark that already carries its own corners, shadow, or 3D perspective will have those
resampled into every size. These assets are applied only while packaging a desktop artifact; the
hosted web app and the dev server keep upstream's T3 Code icons. See
[the Axis release guide](../../docs/axis/RELEASE.md).
