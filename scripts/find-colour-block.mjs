/**
 * Look for a coloured block in an image and report where it is.
 *
 * The capture checks count the pixels of the distinctive colours of the
 * test page. A widget that is hidden leaves a few anti-aliased edge pixels
 * behind, so a block of pixels is only a real problem when the block is
 * bigger than the edges of the original shape.
 *
 * This finds the blocks, so a stray edge can be told apart from a widget
 * that was really captured.
 *
 * Usage:
 *   node scripts/find-colour-block.mjs <image> <r> <g> <b> [tolerance]
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const [, , imagePath, redArg, greenArg, blueArg, toleranceArg] = process.argv;

if (!imagePath) {
  console.error("usage: node scripts/find-colour-block.mjs <image> <r> <g> <b> [tolerance]");
  process.exit(2);
}

const red = Number(redArg);
const green = Number(greenArg);
const blue = Number(blueArg);
const tolerance = Number(toleranceArg ?? 24);

const bytes = readFileSync(resolve(imagePath));
console.log(`image: ${imagePath} (${bytes.length} bytes)`);
console.log(`looking for rgb(${red}, ${green}, ${blue}) with a tolerance of ${tolerance}\n`);

// The file is a PNG, so the pixels have to be decoded. The check scripts
// already decode the image in the browser, so the counting is done here with
// the same approach: the image is passed through a tiny PNG decoder.
const { inflateSync } = await import("node:zlib");

/**
 * Decode a PNG into raw pixels.
 *
 * @param {Buffer} buffer
 * @returns {{width: number, height: number, data: Buffer}}
 */
function decodePng(buffer) {
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }

    offset += 12 + length;
  }

  const raw = inflateSync(Buffer.concat(idat));
  const channels = 4;
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);

  // Undo the per-row filters.
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const rowStart = y * (stride + 1) + 1;
    const outStart = y * stride;
    const prevStart = outStart - stride;

    for (let x = 0; x < stride; x += 1) {
      const value = raw[rowStart + x];
      const left = x >= channels ? pixels[outStart + x - channels] : 0;
      const up = y > 0 ? pixels[prevStart + x] : 0;
      const upLeft = y > 0 && x >= channels ? pixels[prevStart + x - channels] : 0;

      let restored;
      switch (filter) {
        case 0:
          restored = value;
          break;
        case 1:
          restored = value + left;
          break;
        case 2:
          restored = value + up;
          break;
        case 3:
          restored = value + Math.floor((left + up) / 2);
          break;
        case 4: {
          const estimate = left + up - upLeft;
          const distanceLeft = Math.abs(estimate - left);
          const distanceUp = Math.abs(estimate - up);
          const distanceUpLeft = Math.abs(estimate - upLeft);
          if (distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft) {
            restored = value + left;
          } else if (distanceUp <= distanceUpLeft) {
            restored = value + up;
          } else {
            restored = value + upLeft;
          }
          break;
        }
        default:
          restored = value;
      }
      pixels[outStart + x] = restored & 0xff;
    }
  }

  return { width, height, data: pixels };
}

const image = decodePng(bytes);
console.log(`decoded: ${image.width} x ${image.height}\n`);

// Group the matching pixels into rows, so a block can be told apart from
// scattered edge pixels.
const rowCounts = new Map();
let total = 0;

for (let y = 0; y < image.height; y += 1) {
  let inRow = 0;
  for (let x = 0; x < image.width; x += 1) {
    const index = (y * image.width + x) * 4;
    const r = image.data[index];
    const g = image.data[index + 1];
    const b = image.data[index + 2];

    if (Math.abs(r - red) <= tolerance && Math.abs(g - green) <= tolerance && Math.abs(b - blue) <= tolerance) {
      inRow += 1;
      total += 1;
    }
  }
  if (inRow > 0) rowCounts.set(y, inRow);
}

console.log(`matching pixels: ${total}`);

const rows = [...rowCounts.entries()].sort((left, right) => left[0] - right[0]);
if (rows.length > 0) {
  // Report the contiguous bands.
  let bandStart = rows[0][0];
  let bandEnd = rows[0][0];
  let bandPixels = rows[0][1];

  const bands = [];
  for (let index = 1; index < rows.length; index += 1) {
    const [y, count] = rows[index];
    if (y === bandEnd + 1) {
      bandEnd = y;
      bandPixels += count;
      continue;
    }
    bands.push({ from: bandStart, to: bandEnd, pixels: bandPixels });
    bandStart = y;
    bandEnd = y;
    bandPixels = count;
  }
  bands.push({ from: bandStart, to: bandEnd, pixels: bandPixels });

  console.log(`\ncontiguous bands: ${bands.length}`);
  for (const band of bands.slice(0, 12)) {
    console.log(
      `  y ${String(band.from).padStart(6)}..${String(band.to).padEnd(6)} ` +
        `(${String(band.to - band.from + 1).padStart(5)} rows, ${String(band.pixels).padStart(8)} pixels)`,
    );
  }
}
