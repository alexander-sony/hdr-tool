# Preview images

Viewable PNGs of unpacked raw frames. These are display previews, not a linear record of exposure.

## Source

Headerless uint16 little-endian, row-major. Read width, height, bit depth, and Bayer pattern from the filename.

`image-short_w2064_h1552_12b_RGGB_unpacked.raw`

- 2064×1552
- 12-bit values, right-aligned in the 16-bit word (0..4095)
- RGGB, phase at pixel (0, 0)
- Black level 240. Leave it in the raw file. Subtract it only for the preview.

## Processing

1. Subtract black level 240 and clip at 0.
2. Bilinear-demosaic the Bayer pattern.
3. Gray-world white balance.
4. Stretch so the 99.5th percentile is white. Stretch each frame on its own.
5. Apply gamma 2.2 and write 8-bit RGB.

## Output

- Same directory as the raw file.
- Same filename with `_preview` before `.png`.

`image-short_w2064_h1552_12b_RGGB_unpacked_preview.png`

The width and height in the name describe the raw frame, not the PNG.

- Full-color RGB. Do not quantize to a palette.
- Each file must be under 100KB. Downscale with Lanczos, as large as possible within that limit. 340×256 meets it for these frames.
- Use Pillow from `.venv` (`uv add pillow` if it is missing).
