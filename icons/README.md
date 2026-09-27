# YouTube Auto HD icon

A relaxed wizard in sunglasses watches TV from his couch, framed by a rounded midnight-blue badge.

## Assets

- `icon-source.png`: original high-resolution artwork with transparency.
- `icon-16.png`, `icon-32.png`, `icon-48.png`, `icon-128.png`: PNG exports referenced by `../manifest.json`.

The source artwork was generated with the built-in image generation tool. Exports were resized with macOS `sips`; transparency was preserved. Manifest paths, dimensions, and RGBA format were checked. The wizard's silhouette remains recognizable at 16px; the full scene is clearer at 48px and above.

## Generation prompt

Create a square browser-extension icon: a cool, friendly wizard wearing black sunglasses, lounging comfortably on his couch while watching a television. Playful polished 2D cartoon mascot, chunky shapes, thick clean dark outlines, very limited cel shading, no tiny details. Three-quarter view: the wizard's face, oversized pointed purple wizard hat, white beard, and unmistakable black sunglasses are prominent; his relaxed body sits on a cozy warm-colored couch. A compact TV in the lower-right foreground faces him, with a simple luminous cyan screen angled so the viewer also sees it. His head is turned toward the TV. Make the wizard, couch, and TV a tightly composed, cohesive scene that fills a rounded-square midnight-blue badge, with a narrow transparent margin outside the badge. Prioritize a large readable wizard face and hat; keep the couch and TV simple enough to recognize at 48px. Friendly, relaxed, a little cheeky. No lettering, no HD text, no logos, no watermark, no extra props, no room clutter. Deliver one finished icon, not a mockup or a grid.

## Recreate exports

Run from the repository root:

```sh
for size in 16 32 48 128; do
  sips -z "$size" "$size" icons/icon-source.png --out "icons/icon-$size.png"
done
```

## Reload

Open Chrome's extensions page and click Reload on YouTube Auto HD to display the new icon.
