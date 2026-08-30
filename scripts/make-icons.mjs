/**
 * Generates the Groups app icon and iOS splash screens as real PNGs —
 * no image libraries, just zlib and the PNG spec.
 *
 *   npm run icons
 *
 * The mark: three dots in a ring on a golden-hour gradient. A group, a shutter,
 * and a horizon at once (see DESIGN.md §9).
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'icons');
fs.mkdirSync(OUT, { recursive: true });

/* ----------------------------------------------------------- PNG encoder -- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** @param {Uint8Array} rgba row-major RGBA, width*height*4 */
function encodePng(rgba, width, height) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride)
      .copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------- tiny paint -- */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const smooth = (edge0, edge1, x) => {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

// Golden Hour ramp, top to bottom.
const STOPS = [
  [0.00, [18, 14, 44]],
  [0.30, [58, 26, 84]],
  [0.55, [122, 38, 104]],
  [0.78, [206, 68, 86]],
  [1.00, [255, 158, 58]],
];

function ramp(t) {
  for (let i = 1; i < STOPS.length; i++) {
    if (t <= STOPS[i][0]) {
      const [t0, c0] = STOPS[i - 1];
      const [t1, c1] = STOPS[i];
      return mix(c0, c1, (t - t0) / (t1 - t0));
    }
  }
  return STOPS[STOPS.length - 1][1];
}

/**
 * Paint one frame. `markScale` sets how much of the canvas the mark occupies,
 * so the same routine draws both a 1024px icon and a 2778px splash.
 */
/** The vertical gradient, baked once into a lookup table. */
function rampTable(steps = 2048) {
  const table = new Float64Array(steps * 3);
  for (let i = 0; i < steps; i++) {
    const [r, g, b] = ramp(i / (steps - 1));
    table[i * 3] = r;
    table[i * 3 + 1] = g;
    table[i * 3 + 2] = b;
  }
  return table;
}

const RAMP = rampTable();
const RAMP_MAX = RAMP.length / 3 - 1;

function paint(width, height, { markScale = 0.52, vignette = true } = {}) {
  const px = new Uint8Array(width * height * 4);
  const cx = width / 2;
  const cy = height / 2;
  const size = Math.min(width, height);
  const markR = (size * markScale) / 2;   // radius of the dot ring
  const dotR = markR * 0.30;
  const ringR = markR * 0.74;
  const ringW = size * 0.006;
  const edge = size * 0.004;
  const glowR = dotR * 2.6;

  // Three dots at 12, 4 and 8 o'clock.
  const dots = [0, 1, 2].map((i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / 3;
    return [cx + Math.cos(a) * ringR, cy + Math.sin(a) * ringR];
  });

  // Everything the mark touches lives inside this box; outside it we only need
  // the gradient, which is most of a tall splash screen.
  const reach = ringR + Math.max(dotR * 4, ringW * 3);
  const box = {
    top: Math.max(0, Math.floor(cy - reach)),
    bottom: Math.min(height, Math.ceil(cy + reach)),
    left: Math.max(0, Math.floor(cx - reach)),
    right: Math.min(width, Math.ceil(cx + reach)),
  };

  for (let y = 0; y < height; y++) {
    const yn = (y / height) * 0.88;
    const gy = (y - height * 0.96) / size;
    const vy = (y - cy) / (height * 0.72);
    const inBandY = y >= box.top && y < box.bottom;

    for (let x = 0; x < width; x++) {
      // Mostly vertical, with a slight diagonal so the corners are not flat.
      const t = clamp01(yn + (x / width) * 0.12);
      const idx = (t * RAMP_MAX + 0.5) | 0;
      let r = RAMP[idx * 3];
      let g = RAMP[idx * 3 + 1];
      let b = RAMP[idx * 3 + 2];

      // A single warm light source low and centred — the sun about to set.
      const gx = (x - cx) / size;
      const glowW = 0.28 * Math.exp(-(gx * gx + gy * gy) * 6);
      r += (255 - r) * glowW;
      g += (206 - g) * glowW;
      b += (138 - b) * glowW;

      if (vignette) {
        const vx = (x - cx) / (width * 0.72);
        const v = vx * vx + vy * vy;
        const k = 1 - 0.16 * clamp01(v * Math.sqrt(v));
        r *= k; g *= k; b *= k;
      }

      if (inBandY && x >= box.left && x < box.right) {
        // The mark: soft glow, then crisp dots.
        let glow = 0;
        let ink = 0;
        for (const [dx, dy] of dots) {
          const ex = x - dx;
          const ey = y - dy;
          const d = Math.sqrt(ex * ex + ey * ey);
          const a = 1 - smooth(dotR - edge, dotR + edge, d);
          if (a > ink) ink = a;
          const q = d / glowR;
          const em = Math.exp(-q * q);
          if (em > glow) glow = em;
        }
        const gw = 0.20 * glow;
        r += (255 - r) * gw; g += (232 - g) * gw; b += (200 - b) * gw;
        r += (255 - r) * ink; g += (251 - g) * ink; b += (245 - b) * ink;

        // Hairline ring tying the three dots together.
        const rx = x - cx;
        const ry = y - cy;
        const dr = Math.abs(Math.sqrt(rx * rx + ry * ry) - ringR);
        const ringA = (1 - smooth(ringW * 0.5, ringW * 1.6, dr)) * 0.30 * (1 - ink);
        r += (255 - r) * ringA; g += (245 - g) * ringA; b += (230 - b) * ringA;
      }

      const o = (y * width + x) * 4;
      px[o] = r < 0 ? 0 : r > 255 ? 255 : r + 0.5;
      px[o + 1] = g < 0 ? 0 : g > 255 ? 255 : g + 0.5;
      px[o + 2] = b < 0 ? 0 : b > 255 ? 255 : b + 0.5;
      px[o + 3] = 255;
    }
  }
  return px;
}

const FORCE = process.argv.includes('--force');

function write(name, width, height, opts) {
  const file = path.join(OUT, name);
  if (!FORCE && fs.existsSync(file)) return { bytes: fs.statSync(file).size, skipped: true };
  const png = encodePng(paint(width, height, opts), width, height);
  fs.writeFileSync(file, png);
  return { bytes: png.length, skipped: false };
}

/* ----------------------------------------------------------------- output -- */

const ICONS = [
  ['icon-1024.png', 1024],
  ['icon-512.png', 512],
  ['icon-192.png', 192],
  ['apple-touch-icon.png', 180],
  ['icon-120.png', 120],
];

// iPhone launch images. iOS matches these on device-width/height + pixel ratio.
const SPLASH = [
  ['splash-1290x2796.png', 1290, 2796], // 15/16 Pro Max, 14 Plus
  ['splash-1179x2556.png', 1179, 2556], // 15/16 Pro, 14 Pro
  ['splash-1284x2778.png', 1284, 2778], // 13/12 Pro Max
  ['splash-1170x2532.png', 1170, 2532], // 13/12/14
  ['splash-1125x2436.png', 1125, 2436], // X/XS/11 Pro
  ['splash-1242x2688.png', 1242, 2688], // XS Max/11 Pro Max
  ['splash-828x1792.png', 828, 1792],   // XR/11
  ['splash-750x1334.png', 750, 1334],   // SE/8/7
];

let total = 0;
let made = 0;
for (const [name, size] of ICONS) {
  const r = write(name, size, size, { markScale: 0.56 });
  total += r.bytes;
  if (!r.skipped) { made++; console.log(`  ${name.padEnd(24)} ${size}x${size}`); }
}
for (const [name, w, h] of SPLASH) {
  const r = write(name, w, h, { markScale: 0.223, vignette: false });
  total += r.bytes;
  if (!r.skipped) { made++; console.log(`  ${name.padEnd(24)} ${w}x${h}`); }
}

fs.writeFileSync(
  path.join(OUT, 'mark.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="none">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0" stop-color="#241A46"/>
      <stop offset="0.55" stop-color="#6C2A63"/>
      <stop offset="1" stop-color="#FF9842"/>
    </linearGradient>
  </defs>
  <rect width="100" height="100" rx="26" fill="url(#g)"/>
  <circle cx="50" cy="50" r="22" stroke="#FFF5E6" stroke-opacity="0.3" stroke-width="1.6"/>
  <circle cx="50" cy="28" r="9" fill="#FFFBF5"/>
  <circle cx="69.05" cy="61" r="9" fill="#FFFBF5"/>
  <circle cx="30.95" cy="61" r="9" fill="#FFFBF5"/>
</svg>
`,
);
if (made) console.log(`  mark.svg\n\n  ${(total / 1024).toFixed(0)} KB in ${OUT}\n`);
else console.log(`  icons already generated (${(total / 1024).toFixed(0)} KB) — pass --force to redraw\n`);
