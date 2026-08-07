// Interactive terminal menu.
//
// Only engages for a bare `node src/index.mjs` / `roots-watch` with no flags
// in an actual terminal (see the guard in index.mjs's main()) — anything
// scripted (CI, cron, `--once`, `--json`, ...) keeps using the plain flag-
// driven path so nothing here can break the GitHub Actions run.
//
// Ctrl+C rule, throughout: it never kills the CLI. At the menu it quits (the
// expected place to exit from); everywhere nested — including mid auto-run —
// it cancels whatever's in progress and drops back to the menu. That's the
// one behaviour worth stating up front because it's the opposite of a
// terminal's normal Ctrl+C.

import readline from 'node:readline';

import * as ui from './ui.mjs';

const FREQUENCIES = [
  { label: '5 min', minutes: 5 },
  { label: '15 min', minutes: 15 },
  { label: '30 min', minutes: 30 },
  { label: '1 hr', minutes: 60 },
  { label: '6 hr', minutes: 360 },
  { label: 'Custom', minutes: null },
];
const DEFAULT_FREQUENCY_INDEX = 3; // 1 hr

const DURATIONS = [
  { label: 'Forever', days: 0 },
  { label: '1 day', days: 1 },
  { label: '2 days', days: 2 },
  { label: '7 days', days: 7 },
];

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

function isCtrlC(key) {
  return Boolean(key && key.ctrl && key.name === 'c');
}

function isBack(key) {
  return isCtrlC(key) || Boolean(key && key.name === 'escape');
}

function isConfirm(key) {
  return Boolean(key && (key.name === 'return' || key.name === 'enter'));
}

/** Reads keypresses one at a time from stdin, in raw mode. */
class KeyReader {
  start() {
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    this._onKey = (sequence, key) => {
      const resolve = this._resolve;
      this._resolve = null;
      if (resolve) resolve(key ?? { name: undefined, sequence });
    };
    process.stdin.on('keypress', this._onKey);
  }

  /** Resolves with the next keypress. Callers await this one at a time. */
  next() {
    return new Promise((resolve) => {
      this._resolve = resolve;
    });
  }

  stop() {
    process.stdin.off('keypress', this._onKey);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}

function smallBanner() {
  return `${ui.bold(ui.green('ROOTS'))} ${ui.dim('· stock watch')}`;
}

function hint(text) {
  return ui.dim(text);
}

function render(...blocks) {
  ui.clearScreen();
  console.log(blocks.filter((block) => block !== null && block !== undefined).join('\n'));
}

function optionRow(labels, selectedIdx) {
  return labels.map((label, i) => (i === selectedIdx ? ui.inverse(` ${label} `) : ui.dim(label))).join('  ');
}

// --- text input --------------------------------------------------------

async function promptText(keys, label, initial, { digitsOnly = false } = {}) {
  let buf = initial ?? '';
  for (;;) {
    render(smallBanner(), '', ui.bold(label), '', `  ${buf}${ui.dim('_')}`, '', hint('Enter confirm · Esc cancel'));
    const key = await keys.next();
    if (isBack(key)) return null;
    if (isConfirm(key)) {
      if (!digitsOnly) return buf.trim() || initial;
      const n = Number(buf);
      if (buf && Number.isFinite(n) && n > 0) return n;
      continue; // invalid number — keep editing
    }
    if (key.name === 'backspace') {
      buf = buf.slice(0, -1);
      continue;
    }
    const ch = key.sequence ?? '';
    if (ch.length === 1 && ch >= ' ' && !key.ctrl && !key.meta) {
      if (digitsOnly && !/[0-9]/.test(ch)) continue;
      buf += ch;
    }
  }
}

// --- main menu -----------------------------------------------------------

async function showMenu(keys, session) {
  const notifyStatus = session.hasChannel ? ui.green('configured') : ui.yellow('not set — see Settings');
  render(
    ui.renderBanner(),
    `  ${ui.bold('1')}  Start          configure & run a check`,
    `  ${ui.bold('2')}  Settings       url · sizes · notifications  ${ui.dim('(')}${notifyStatus}${ui.dim(')')}`,
    `  ${ui.bold('Q')}  Quit`,
    '',
    hint('1/2 to choose · Ctrl+C to quit'),
  );

  for (;;) {
    const key = await keys.next();
    if (isCtrlC(key)) return 'quit';
    const name = (key.name ?? key.sequence ?? '').toLowerCase();
    if (name === '1' || (isConfirm(key))) return 'start';
    if (name === '2') return 'settings';
    if (name === 'q') return 'quit';
  }
}

// --- settings --------------------------------------------------------------

async function showSettings(keys, session) {
  for (;;) {
    render(
      smallBanner(),
      '',
      ui.bold('Settings'),
      '',
      `  ${ui.bold('1')}  URL       ${session.config.url}`,
      `  ${ui.bold('2')}  Sizes     ${session.config.sizes.join(', ')}`,
      `  ${ui.bold('3')}  Webhook   ${
        session.hasChannel ? ui.green('configured') : ui.yellow('not set — see .env.example')
      }`,
      '',
      hint("edits are session-only, they don't touch .env · Esc back"),
    );

    const key = await keys.next();
    if (isBack(key)) return;
    const name = key.name ?? '';

    if (name === '1') {
      const url = await promptText(keys, 'Product URL', session.config.url);
      if (url) session.config.url = url;
    } else if (name === '2') {
      const sizes = await promptText(keys, 'Sizes (comma separated)', session.config.sizes.join(', '));
      if (sizes) {
        session.config.sizes = sizes
          .split(',')
          .map((size) => size.trim())
          .filter(Boolean);
      }
    }
  }
}

// --- run configuration -----------------------------------------------------

function fieldsFor(runConfig) {
  return runConfig.autoRun ? ['autoRun', 'frequency', 'duration'] : ['autoRun'];
}

function renderRunConfigBody(runConfig) {
  const fields = fieldsFor(runConfig);
  const marker = (fieldId) => (fields[runConfig.focus] === fieldId ? ui.cyan('▸') : ' ');
  const rows = [
    `  ${marker('autoRun')} ${ui.bold('Auto-run')}    ${optionRow(['Yes', 'No'], runConfig.autoRun ? 0 : 1)}`,
  ];

  if (runConfig.autoRun) {
    const freqLabels = FREQUENCIES.map((freq) => freq.label);
    const freqSuffix =
      FREQUENCIES[runConfig.freqIdx].minutes === null ? ui.dim(`  (${runConfig.customMinutes ?? '?'} min)`) : '';
    rows.push(`  ${marker('frequency')} ${ui.bold('Frequency')}   ${optionRow(freqLabels, runConfig.freqIdx)}${freqSuffix}`);
    const durLabels = DURATIONS.map((duration) => duration.label);
    rows.push(`  ${marker('duration')} ${ui.bold('Duration')}    ${optionRow(durLabels, runConfig.durIdx)}`);
  } else {
    rows.push(ui.dim('               frequency / duration — n/a, auto-run is off'));
  }

  return rows.join('\n');
}

/** @returns {Promise<boolean>} true if the user confirmed (Enter), false if they backed out. */
async function showRunConfig(keys, runConfig) {
  runConfig.focus = 0;
  for (;;) {
    render(
      smallBanner(),
      '',
      ui.bold('Run configuration'),
      '',
      renderRunConfigBody(runConfig),
      '',
      hint('↑/↓ field · ←/→ change · Enter start · Esc back'),
    );

    const key = await keys.next();
    if (isBack(key)) return false;

    const fields = fieldsFor(runConfig);
    const field = fields[runConfig.focus];

    if (key.name === 'up') {
      runConfig.focus = Math.max(0, runConfig.focus - 1);
    } else if (key.name === 'down') {
      runConfig.focus = Math.min(fields.length - 1, runConfig.focus + 1);
    } else if (key.name === 'left' || key.name === 'right') {
      const dir = key.name === 'left' ? -1 : 1;
      if (field === 'autoRun') {
        runConfig.autoRun = !runConfig.autoRun;
        runConfig.focus = 0;
      } else if (field === 'frequency') {
        runConfig.freqIdx = (runConfig.freqIdx + dir + FREQUENCIES.length) % FREQUENCIES.length;
      } else if (field === 'duration') {
        runConfig.durIdx = (runConfig.durIdx + dir + DURATIONS.length) % DURATIONS.length;
      }
    } else if (isConfirm(key)) {
      if (runConfig.autoRun && FREQUENCIES[runConfig.freqIdx].minutes === null) {
        const minutes = await promptText(keys, 'Custom interval, in minutes', String(runConfig.customMinutes ?? 45), {
          digitsOnly: true,
        });
        if (minutes === null) continue; // cancelled back into the form
        runConfig.customMinutes = minutes;
      }
      return true;
    }
  }
}

// --- running ---------------------------------------------------------------

function formatCountdown(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}

/** Waits, redrawing a countdown each second. Returns true if Ctrl+C cancelled it. */
async function waitWithCountdown(keys, waitMs, checks) {
  const endAt = Date.now() + waitMs;
  for (;;) {
    const remaining = endAt - Date.now();
    if (remaining <= 0) return false;
    const label = `checks so far: ${checks} · next check in ${formatCountdown(Math.ceil(remaining / 1000))} · Ctrl+C to stop`;
    process.stdout.write(`\r${hint(label)}${' '.repeat(8)}`);

    const tickMs = Math.min(1000, remaining);
    const outcome = await Promise.race([
      keys.next().then((key) => ({ key })),
      sleep(tickMs).then(() => ({ timedOut: true })),
    ]);
    if (outcome.key && isCtrlC(outcome.key)) {
      process.stdout.write('\n');
      return true;
    }
  }
}

async function runLoop(keys, session, runConfig, runCheck, notifyConfig) {
  const minutes = runConfig.autoRun ? FREQUENCIES[runConfig.freqIdx].minutes ?? runConfig.customMinutes : null;
  const durationDays = runConfig.autoRun ? DURATIONS[runConfig.durIdx].days : 0;
  const stopAt = durationDays > 0 ? Date.now() + durationDays * 86_400_000 : null;

  let checks = 0;
  for (;;) {
    ui.clearScreen();
    console.log(smallBanner());
    console.log(`${ui.bold('Watching')} ${session.config.url}`);
    console.log(
      `${ui.EYE} ${session.config.sizes.map((size) => ui.pill(size, 'watching')).join(' ')}${
        runConfig.autoRun ? ui.dim(`  every ${minutes} min`) : ''
      }`,
    );
    console.log();

    try {
      await runCheck(session.config, notifyConfig);
    } catch (error) {
      console.error(`Check failed: ${error.stack ?? error}`);
    }
    checks += 1;

    if (!runConfig.autoRun) {
      console.log();
      console.log(hint('Press any key to return to the menu'));
      await keys.next();
      return;
    }

    if (stopAt && Date.now() >= stopAt) {
      console.log();
      console.log(ui.dim(`Duration reached (${DURATIONS[runConfig.durIdx].label}) — back to menu.`));
      await sleep(1500);
      return;
    }

    console.log();
    const jitterMs = Math.floor(Math.random() * 60_000);
    const cancelled = await waitWithCountdown(keys, minutes * 60_000 + jitterMs, checks);
    if (cancelled) {
      console.log(ui.yellow('Auto-run cancelled — back to menu.'));
      await sleep(900);
      return;
    }
  }
}

// --- entry point -------------------------------------------------------

export async function runInteractive({ config, notifyConfig, hasChannel, runCheck }) {
  const keys = new KeyReader();
  keys.start();
  ui.hideCursor();

  const session = { config: { ...config, sizes: [...config.sizes] }, hasChannel };
  const runConfig = { autoRun: true, freqIdx: DEFAULT_FREQUENCY_INDEX, durIdx: 0, customMinutes: null, focus: 0 };

  try {
    for (;;) {
      const choice = await showMenu(keys, session);
      if (choice === 'quit') break;
      if (choice === 'settings') {
        await showSettings(keys, session);
        continue;
      }
      if (choice === 'start') {
        const confirmed = await showRunConfig(keys, runConfig);
        if (!confirmed) continue;
        await runLoop(keys, session, runConfig, runCheck, notifyConfig);
      }
    }
  } finally {
    keys.stop();
    ui.showCursor();
    ui.clearScreen();
  }

  console.log(ui.dim('Goodbye.'));
  return 0;
}
