import { readFileSync } from "node:fs";
import { readJpegDimensions, checkInstagramAspect } from "../src/lib/jpeg.js";
import { writeFixtures } from "./fixtures.js";

const SP = writeFixtures();
const expect: Record<string, [number, number] | null> = {
  "square_1080.jpg": [1080, 1080],
  "portrait_1080x1350.jpg": [1080, 1350],
  "landscape_1080x566.jpg": [1080, 566],
  "too_tall_1080x1920.jpg": [1080, 1920],
  "too_wide_1920x600.jpg": [1920, 600],
  "progressive.jpg": [800, 800],
  "notajpeg.png": null,
};

let fail = 0;
for (const [file, want] of Object.entries(expect)) {
  const dim = readJpegDimensions(readFileSync(`${SP}/${file}`));
  const got = dim ? `${dim.width}x${dim.height}` : "null";
  const wanted = want ? `${want[0]}x${want[1]}` : "null";
  const ok = got === wanted;
  if (!ok) fail++;
  const aspect = dim ? checkInstagramAspect(dim) : null;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${file.padEnd(24)} dims=${got.padEnd(10)} want=${wanted.padEnd(10)}` +
      (aspect ? `  ig=${aspect.ok ? "accept" : "reject"} ratio=${aspect.ratio.toFixed(4)}` : ""),
  );
  if (aspect && !aspect.ok) console.log(`      hint: ${aspect.hint}`);
}
console.log(fail ? `\n${fail} failure(s)` : "\nall dimension tests passed");
process.exitCode = fail ? 1 : 0;
