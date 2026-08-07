// Terminal styling for the CLI: colours, the ROOTS wordmark, and a couple of
// screen primitives (clear, cursor visibility, a bordered box).
//
// Hand-rolled rather than pulling in chalk/figlet/etc — the watcher's whole
// pitch is "clone it and run it, nothing to install" (see README), and this
// is the only place that would need a dependency.

const ESC = '\x1b[';

function detectColor(env = process.env) {
  if ('NO_COLOR' in env) return false; // https://no-color.org — presence wins, value doesn't matter
  if (env.FORCE_COLOR === '0') return false;
  if ('FORCE_COLOR' in env) return true;
  if (process.stdout.isTTY) return true;
  // GitHub Actions renders ANSI colour in its log viewer even though stdout isn't a TTY there.
  if (env.GITHUB_ACTIONS) return true;
  return false;
}

export const useColor = detectColor();

function wrap(open, close) {
  return (text) => (useColor ? `${ESC}${open}m${text}${ESC}${close}m` : String(text));
}

/** 256-colour foreground, e.g. tone(136)('gold'). */
function tone(code, text) {
  return useColor ? `${ESC}38;5;${code}m${text}${ESC}0m` : String(text);
}

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const italic = wrap(3, 23);
export const underline = wrap(4, 24);
export const inverse = wrap(7, 27);
export const green = wrap(32, 39);
export const brightGreen = wrap(92, 39);
export const yellow = wrap(33, 39);
export const red = wrap(31, 39);
export const gray = wrap(90, 39);
export const cyan = wrap(36, 39);
export { tone };

// --- ROOTS wordmark -------------------------------------------------------
//
// A hand-rolled 5x7 dot-matrix font, just enough letters for "ROOTS", so the
// banner doesn't need figlet. '#' is an on-pixel, '.' is off.
const FONT = {
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
};
const WORD = ['R', 'O', 'O', 'T', 'S'];
const LOGO_HEIGHT = 7;
export const LOGO_WIDTH = WORD.length * 5 + (WORD.length - 1);

// Green at the top fading to soil brown at the bottom, so the wordmark looks
// like it's growing out of the ground. xterm-256 codes.
const GRADIENT = [28, 64, 100, 136, 130, 94, 58];

/** The big block "ROOTS" wordmark, coloured green-to-brown top to bottom. */
export function renderLogo() {
  const rows = [];
  for (let row = 0; row < LOGO_HEIGHT; row += 1) {
    const line = WORD.map((letter) => FONT[letter][row]).join('.');
    const pixels = line.replace(/[#.]/g, (ch) => (ch === '#' ? '█' : ' '));
    rows.push(useColor ? tone(GRADIENT[row], pixels) : pixels);
  }
  return rows.join('\n');
}

/** Logo + tagline, ready to print once at startup or atop a screen. */
export function renderBanner() {
  const tagline = center('🌿 stock watch', LOGO_WIDTH);
  return `${renderLogo()}\n${dim(tagline)}\n`;
}

export function center(text, width) {
  const visibleLength = text.replace(/\p{Extended_Pictographic}/gu, '  ').length;
  const pad = Math.max(0, Math.floor((width - visibleLength) / 2));
  return ' '.repeat(pad) + text;
}

// --- screen primitives -----------------------------------------------------

export function clearScreen() {
  // Scrollback-preserving clear + cursor home, not the "erase everything"
  // console.clear() shortcut — keeps a plain-pipe run's history intact.
  if (process.stdout.isTTY) process.stdout.write(`${ESC}2J${ESC}H`);
}

export function hideCursor() {
  if (process.stdout.isTTY) process.stdout.write(`${ESC}?25l`);
}

export function showCursor() {
  if (process.stdout.isTTY) process.stdout.write(`${ESC}?25h`);
}

/**
 * A bordered box around plain-text lines. Content is intentionally left
 * uncoloured — ANSI escapes would throw off the padding math — only the
 * border takes a colour.
 */
export function box(lines, { borderColor = (text) => text, pad = 1 } = {}) {
  const width = Math.max(0, ...lines.map((line) => line.length));
  const rule = '─'.repeat(width + pad * 2);
  const top = borderColor(`┌${rule}┐`);
  const bottom = borderColor(`└${rule}┘`);
  const body = lines.map(
    (line) => `${borderColor('│')}${' '.repeat(pad)}${line.padEnd(width)}${' '.repeat(pad)}${borderColor('│')}`,
  );
  return [top, ...body, bottom].join('\n');
}

// --- status pills ------------------------------------------------------
//
// The whole point of these: stock status should read at a glance, as a
// shape and a colour, not as a sentence you have to parse.

export const EYE = '👁';

const PILL_COLOR = { good: 40, bad: 196, unknown: 178, watching: 67 }; // green, red, gold, slate blue
const PILL_ICON = { good: '✓', bad: '✗', unknown: '?', watching: '·' };

/**
 * A solid, rounded "pill" badge — a size plus its status, as a colour and a
 * shape rather than a word. `status` is one of PILL_COLOR's keys:
 * 'good' (in stock, green), 'bad' (sold out, red), 'unknown' (gold), or
 * 'watching' (neutral — configured but not checked yet).
 */
export function pill(label, status) {
  const code = PILL_COLOR[status] ?? PILL_COLOR.unknown;
  const icon = PILL_ICON[status] ?? '';
  const text = icon ? `${icon} ${label}` : label;
  if (!useColor) return `[${text}]`;
  const cap = `${ESC}38;5;${code}m`; // half-blocks in the fill colour round off the ends
  const fill = `${ESC}1m${ESC}38;5;16m${ESC}48;5;${code}m`; // bold near-black on the fill colour
  const reset = `${ESC}0m`;
  return `${cap}▌${reset}${fill} ${text} ${reset}${cap}▐${reset}`;
}
