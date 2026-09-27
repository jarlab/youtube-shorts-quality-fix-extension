# YouTube Auto HD icon

A red tile with a white HD monogram; the D contains a play triangle.

## Assets

- `icon-source.png`: original 1254 × 1254 artwork with transparency.
- `icon-16.png`, `icon-32.png`, `icon-48.png`, `icon-128.png`: PNG exports referenced by `../manifest.json`.

The source artwork was generated with the built-in image generation tool. Exports were resized with macOS `sips`; transparency was preserved. Manifest paths, dimensions, and RGBA format were checked, and the 16px and 128px exports were visually reviewed.

## Generation prompt

Create a production-ready square Chrome extension icon for YouTube Auto HD: a saturated YouTube-red rounded square containing a large, bold, white HD monogram. The counter inside the D is a clean right-pointing play triangle. Flat vector-like graphic, thick balanced strokes, strongly legible at 16px. Center the tile with 6% transparent padding on each side and a corner radius of 20%. Only text: HD. No shadows, gradients, outlines, shine, mockup, watermark, or extra elements. Transparent outside the tile. Perfectly straight-on.

## Recreate exports

Run from the repository root:

```sh
for size in 16 32 48 128; do
  sips -z "$size" "$size" icons/icon-source.png --out "icons/icon-$size.png"
done
```

## Reload

Open Chrome's extensions page and click Reload on YouTube Auto HD to display the new icon.
