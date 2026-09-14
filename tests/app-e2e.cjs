// End-to-end check of the real app: real main process, real preload/IPC, real SymPy worker, real UI.
// Run with: npx electron tests/app-e2e.cjs   (on Linux without a desktop, set DISPLAY to an available X server)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const electron = require('electron');
const { app, BrowserWindow } = electron;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jotter-e2e-'));
process.env.JOTTER_DATA_DIR = dir;
const v = (key, unit = '') => ({ key, tex: '', unit, desc: '', domain: 'real' });
const seed = { version: 1, equations: [
  { id: 'ohm', name: "Ohm's law", subject: 'ee', klass: 'Circuits', formula: 'V = I*R', vars: [v('V', 'V'), v('I', 'A'), v('R', 'ohm')] },
  { id: 'power', name: 'Electrical power', subject: 'ee', klass: 'Circuits', formula: 'P = V*I', vars: [v('P', 'W'), v('V', 'V'), v('I', 'A')] },
  { id: 'square', name: 'Square root', subject: 'math', klass: '', formula: 'x^2 = a', vars: [v('x'), v('a')] },
  { id: 'fixed', name: 'Cosine fixed point', subject: 'math', klass: '', formula: 'cos(x) = x', vars: [v('x')] },
] };
fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify(seed));

// Keep the test invisible: the app's window is created hidden.
try {
  const Original = BrowserWindow;
  Object.defineProperty(electron, 'BrowserWindow', { configurable: true, value: class extends Original { constructor(options) { super({ ...options, show: false }); } } });
} catch { /* fall back to a visible window */ }
require('../electron/main.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  let win;
  for (let i = 0; i < 100 && !(win = BrowserWindow.getAllWindows()[0]); i++) await sleep(50);
  assert.ok(win, 'main.cjs did not create a window');
  if (win.webContents.isLoading()) await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
  const run = code => win.webContents.executeJavaScript(code).catch(error => { console.error('Renderer check failed:', code); throw error; });
  const text = selector => run(`document.querySelector(${JSON.stringify(selector)}).textContent`);
  async function waitFor(code, label, timeout = 20000) {
    const start = Date.now();
    for (;;) {
      const value = await run(code);
      if (value) return value;
      if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${label}: ${await run('document.querySelector("#single-result").textContent + " | " + document.querySelector("#system-result").textContent + " | " + document.querySelector("#notice-message").textContent')}`);
      await sleep(100);
    }
  }
  const type = (selector, value) => run(`{ const e = document.querySelector(${JSON.stringify(selector)}); e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event(e.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); }`);
  const click = selector => run(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const clickText = (selector, label) => run(`[...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.textContent.trim() === ${JSON.stringify(label)}).click()`);
  const answers = selector => run(`[...document.querySelectorAll(${JSON.stringify(selector)} + " .answer-row")].map(r => r.querySelector(".muted").textContent)`);
  const solved = selector => waitFor(`document.querySelector(${JSON.stringify(selector)} + " .answer-row") || /No solution|free variables|did not converge/.test(document.querySelector(${JSON.stringify(selector)}).textContent)`, `result in ${selector}`).then(() => text(selector));
  const setUnknowns = async keys => {
    const labels = await run('[...document.querySelectorAll("#unknown-list input")].map(b => b.getAttribute("aria-label").slice(10))');
    for (const key of labels) await run(`{ const box = document.querySelector("#unknown-list input[aria-label='Solve for ${key}']"); if (box.checked !== ${JSON.stringify(keys.includes(key))}) box.click(); }`);
  };
  const passed = [];

  // Library loads through real IPC and the first equation renders through the real solver's inspect.
  await waitFor('document.querySelectorAll(".library-item").length === 4', 'library to load');
  await waitFor('document.querySelector("#eq-formula .katex")', 'KaTeX render of the inspected formula');
  passed.push('library load + inspect');

  // Hovering a library item renders its formula preview through the real preview channel.
  await run('[...document.querySelectorAll(".library-item")].find(e => e.textContent.includes("Square root")).dispatchEvent(new MouseEvent("mouseenter"))');
  await waitFor('!document.querySelector("#eq-preview").hidden && document.querySelector("#eq-preview annotation")?.textContent.includes("x^{2}")', 'hover formula preview');
  await run('[...document.querySelectorAll(".library-item")].find(e => e.textContent.includes("Square root")).dispatchEvent(new MouseEvent("mouseleave"))');
  assert.equal(await run('document.querySelector("#eq-preview").hidden'), true);
  passed.push('hover preview');

  // Single equation: V = I*R, solve for R with V = 12, I = 2.
  await clickText('.library-item span', "Ohm's law");
  await waitFor('document.querySelector("#eq-name").textContent === "Ohm\'s law"', "Ohm's law selection");
  await type('#solve-for', 'R');
  await waitFor('document.querySelector("#var-rows-V") && document.querySelector("#var-rows-I") && !document.querySelector("#var-rows-R")', 'R to become the unknown');
  await type('#var-rows-V', '12'); await type('#var-rows-I', '2');
  await click('#solve-btn');
  assert.doesNotMatch(await solved('#single-result'), /verified|checked against/);
  assert.deepEqual(await answers('#single-result'), ['6.00000000000 ohm']);
  assert.equal(await run('document.querySelector("#solve-btn").disabled'), false, 'controls re-enable after solving');
  await waitFor('document.querySelector("#history-count").textContent === "1"', 'first saved calculation');
  const historyFile = path.join(dir, 'history.json');
  assert.equal(JSON.parse(fs.readFileSync(historyFile, 'utf8')).entries[0].request.values.I, '2');
  passed.push('single linear solve and durable history (R = V/I = 6 ohm)');

  // Editing a value invalidates the result; scientific notation and fractions are accepted.
  await type('#var-rows-I', '1/4');
  assert.match(await text('#single-result'), /Values changed/);
  await click('#solve-btn');
  assert.doesNotMatch(await solved('#single-result'), /verified|checked against/);
  assert.deepEqual(await answers('#single-result'), ['48.0000000000 ohm']);
  passed.push('re-solve with a fraction input (R = 48 ohm)');

  // Bad input surfaces the engine's message in the result box instead of crashing.
  await type('#var-rows-I', 'abc');
  await click('#solve-btn');
  await waitFor('/finite value for I/.test(document.querySelector("#single-result").textContent)', 'validation message');
  assert.ok(await run('document.querySelector("#single-result .katex")'), 'validation symbols render as LaTeX');
  assert.equal(JSON.parse(fs.readFileSync(historyFile, 'utf8')).entries.length, 2, 'invalid solve is not recorded');
  passed.push('invalid value reports an error without recording history');

  // Nonlinear single equation with two real roots.
  await clickText('.library-item span', 'Square root');
  await waitFor('document.querySelector("#var-rows-a")', 'square root sheet');
  await type('#var-rows-a', '9');
  await click('#solve-btn');
  assert.match(await solved('#single-result'), /Solution 2/);
  assert.deepEqual((await answers('#single-result')).sort(), ['-3.00000000000', '3.00000000000']);
  passed.push('nonlinear single solve with two roots (x = ±3)');

  // Numerical mode with a starting guess.
  await clickText('.library-item span', 'Cosine fixed point');
  await waitFor('document.querySelector("#eq-name").textContent === "Cosine fixed point"', 'fixed point sheet');
  await click('#single-numeric');
  await waitFor('document.querySelector("#single-guesses input")', 'guess field');
  await type('#single-guesses input', '1');
  await click('#solve-btn');
  assert.match(await solved('#single-result'), /numerical root/);
  assert.match((await answers('#single-result'))[0], /^0\.739085133215/);
  await click('#single-numeric');
  passed.push('numerical single solve (cos x = x → 0.7390851)');

  // Editor: add an equation through the real preview/inspect and save/persist path.
  await run('document.dispatchEvent(new KeyboardEvent("keydown", { key: "n", ctrlKey: true }))');
  assert.equal(await run('document.querySelector("#panel-editor").hidden'), false);
  await type('#ed-name', "Newton's second law"); await type('#ed-subject', 'math'); await type('#ed-class', 'Physics');
  await type('#ed-formula', 'F = m*a');
  await waitFor('document.querySelectorAll("#ed-vars tbody tr").length === 3 && document.querySelector("#ed-preview .katex")', 'editor preview');
  await run('document.querySelector("#editor-form").requestSubmit()');
  await waitFor('document.querySelector("#notice-message").textContent === "Equation saved."', 'save notice');
  assert.equal(await run('document.querySelectorAll(".library-item").length'), 5);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'library.json'), 'utf8'));
  assert.equal(saved.equations.length, 5);
  assert.deepEqual(saved.equations.at(-1).vars.map(x => x.key), ['F', 'm', 'a']);
  assert.ok(fs.existsSync(path.join(dir, 'library.json.bak')), 'backup written');
  assert.equal(await run('document.querySelector("#eq-name").textContent'), "Newton's second law");
  await type('#var-rows-m', '3'); await type('#var-rows-a', '4');
  await click('#solve-btn');
  assert.doesNotMatch(await solved('#single-result'), /verified|checked against/);
  assert.deepEqual(await answers('#single-result'), ['12.0000000000']);
  passed.push('editor save persists to disk and the new equation solves (F = 12)');

  // System of equations: V = I*R and P = V*I sharing V and I; unknowns I and R with V = 12, P = 24.
  await click('#tab-system');
  assert.equal(await run('document.querySelector("#panel-system").hidden'), false);
  await type('#slot-0', 'ohm'); await type('#slot-1', 'power');
  await waitFor('document.querySelectorAll("#unknown-list input").length === 4', 'shared variable list (V, I, R, P)');
  await run('document.querySelector("#unknown-list input[aria-label=\'Solve for I\']").click()');
  await run('document.querySelector("#unknown-list input[aria-label=\'Solve for R\']").click()');
  await waitFor('document.querySelector("#system-vars-V") && document.querySelector("#system-vars-P") && document.querySelectorAll("#system-vars .is-unknown").length === 2', 'system known fields');
  await type('#system-vars-V', '12'); await type('#system-vars-P', '24');
  await click('#solve-system');
  assert.doesNotMatch(await solved('#system-result'), /verified|checked against/);
  assert.deepEqual(await answers('#system-result'), ['2.00000000000 A', '6.00000000000 ohm']);
  passed.push('system solve (V=IR, P=VI → I = 2 A, R = 6 ohm)');

  // Inconsistent system: unknown R only, with values that contradict P = V*I.
  await run('document.querySelector("#unknown-list input[aria-label=\'Solve for I\']").click()');
  await waitFor('document.querySelector("#system-vars-I")', 'I to become known');
  await type('#system-vars-I', '2'); await type('#system-vars-P', '100');
  await click('#solve-system');
  assert.match(await solved('#system-result'), /No solution/);
  passed.push('inconsistent system reports no solution');

  // Underdetermined system: two unknowns V and I from V = I*R only (slot 2 removed by selecting nothing).
  await type('#slot-1', '');
  await waitFor('document.querySelectorAll("#unknown-list input").length === 3', 'single-equation variable list');
  await run('document.querySelector("#unknown-list input[aria-label=\'Solve for V\']").click()');
  await waitFor('document.querySelectorAll("#system-vars .is-unknown").length === 2', 'two unknowns');
  await click('#solve-system');
  await waitFor('document.querySelector("#system-result").textContent === "Choose at least two equations."', 'two-equation guard');
  passed.push('system requires two equations');

  // Shared-variable renaming is refused when unit labels disagree (P is W, V is V).
  await type('#slot-1', 'power');
  await waitFor('document.querySelectorAll("#unknown-list input").length === 4', 'four shared variables again');
  await run('{ const e = document.querySelector("#mappings input[aria-label=\'Equation 2 shared symbol for P\']"); e.value = "V"; e.dispatchEvent(new Event("change")); }');
  await waitFor('/different unit labels/.test(document.querySelector("#system-result").textContent)', 'unit mismatch message');
  passed.push('renaming onto a variable with a different unit is rejected');

  // Numerical system: V = I*R and P = V*I with guesses; same physical answer as before.
  await run('{ const e = document.querySelector("#mappings input[aria-label=\'Equation 2 shared symbol for P\']"); e.value = "P"; e.dispatchEvent(new Event("change")); }');
  await waitFor('document.querySelectorAll("#unknown-list input").length === 4', 'P split from V');
  await setUnknowns(["I", "R"]);
  await waitFor('document.querySelector("#system-vars-P") && document.querySelectorAll("#system-vars .is-unknown").length === 2', 'I and R unknown for numeric run');
  await type('#system-vars-V', '12'); await type('#system-vars-P', '24');
  await click('#system-numeric');
  await waitFor('document.querySelectorAll("#system-guesses input").length === 2', 'two guess fields');
  await run('for (const g of document.querySelectorAll("#system-guesses input")) { g.value = "1"; g.dispatchEvent(new Event("input")); }');
  await click('#solve-system');
  assert.match(await solved('#system-result'), /numerical root/);
  assert.deepEqual((await answers('#system-result')).map(x => x.replace(/(\.\d{6})\d+/, '$1')).sort(), ['2.000000 A', '6.000000 ohm']);
  passed.push('numerical system solve');

  // Nonlinear system: x^2 = a and F = m*a with shared a; unknowns x and a from F = 18, m = 2 → a = 9, x = ±3.
  await click('#system-numeric');
  await type('#slot-0', 'square'); await type('#slot-1', saved.equations.at(-1).id);
  await waitFor('document.querySelectorAll("#unknown-list input").length === 4', 'x, a, F, m listed');
  await setUnknowns(["x", "a"]);
  await waitFor('document.querySelector("#system-vars-F") && document.querySelector("#system-vars-m")', 'F and m known');
  await type('#system-vars-F', '18'); await type('#system-vars-m', '2');
  await click('#solve-system');
  assert.match(await solved('#system-result'), /Solution 2/);
  assert.deepEqual((await answers('#system-result')).sort(), ['-3.00000000000', '3.00000000000', '9.00000000000', '9.00000000000']);
  passed.push('nonlinear system with two solutions (x = ±3, a = 9)');

  // Shared-variable renaming on unitless equations: F → x turns the system into x^2 = a, x = m*a.
  await run('{ const e = document.querySelector("#mappings input[aria-label=\'Equation 2 shared symbol for F\']"); e.value = "x"; e.dispatchEvent(new Event("change")); }');
  await waitFor('document.querySelectorAll("#unknown-list input").length === 3', 'F merged into x');
  await setUnknowns(["x", "a"]);
  await waitFor('document.querySelector("#system-vars-m") && document.querySelectorAll("#system-vars .is-unknown").length === 2', 'm known, x and a unknown');
  await type('#system-vars-m', '2');
  await click('#solve-system');
  assert.match(await solved('#system-result'), /Solution 2/);
  assert.deepEqual((await answers('#system-result')).sort(), ['0', '0', '0.250000000000', '0.500000000000']);
  passed.push('system with a renamed shared variable (F→x → (x,a) = (0,0) and (1/2,1/4))');

  // History survives a renderer reload, and retains exact inputs and all solution branches.
  await waitFor('document.querySelector("#history-count").textContent === "9"', 'all successful solves recorded');
  const archive = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
  assert.equal(archive.entries.length, 9, 'inconsistent and invalid calculations are excluded');
  assert.equal(archive.entries[0].mappings[1].F, 'x');
  assert.equal(archive.entries[0].result.answers.length, 2);
  assert.ok(archive.entries.some(entry => entry.request.numeric && entry.kind === 'system'));
  assert.ok(fs.existsSync(historyFile + '.bak'));
  await new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.webContents.reload(); });
  await waitFor('document.querySelector("#history-count").textContent === "9" && document.querySelectorAll(".library-item").length === 5', 'history reload');
  await click('#history-toggle');
  assert.equal(await run('document.querySelector("#history").hidden'), false);
  assert.match(await text('#history-list'), /Today/);
  await type('#history-filter', 'Circuits');
  assert.equal(await run('document.querySelectorAll(".history-item").length'), 4);
  await type('#history-filter', '');
  await click('.history-item summary');
  await waitFor('document.querySelector(".history-item .history-reuse")', 'expanded history controls');
  await click('.history-item .history-reuse');
  assert.equal(await run('document.querySelector("#history").hidden'), true);
  assert.equal(await run('document.querySelector("#panel-system").hidden'), false);
  assert.equal(await run('document.querySelector("#mappings input[aria-label=" + JSON.stringify("Equation 2 shared symbol for F") + "]").value'), 'x');
  assert.equal(await run('document.querySelector("#system-vars-m").value'), '2');
  assert.deepEqual((await answers('#system-result')).sort(), ['0', '0', '0.250000000000', '0.500000000000']);
  assert.equal(JSON.parse(fs.readFileSync(historyFile, 'utf8')).entries.length, 9, 'opening history does not create a duplicate');

  const numerical = archive.entries.find(entry => entry.kind === 'system' && entry.request.numeric);
  await click('#history-toggle');
  await run(`document.querySelector('.history-item[data-id="${numerical.id}"]').open = true`);
  await waitFor(`document.querySelector('.history-item[data-id="${numerical.id}"] .history-reuse')`, 'saved numerical controls');
  await click(`.history-item[data-id="${numerical.id}"] .history-reuse`);
  assert.equal(await run('document.querySelector("#system-numeric").checked'), true);
  assert.deepEqual(await run('[...document.querySelectorAll("#system-guesses input")].map(input => input.value)'), ['1', '1']);
  assert.match(await text('#system-result'), /numerical root/);

  const fraction = archive.entries.find(entry => entry.kind === 'equation' && entry.request.values.I === '1/4');
  await click('#history-toggle');
  await run(`document.querySelector('.history-item[data-id="${fraction.id}"]').open = true`);
  await waitFor(`document.querySelector('.history-item[data-id="${fraction.id}"] .history-reuse')`, 'saved fraction controls');
  await click(`.history-item[data-id="${fraction.id}"] .history-reuse`);
  assert.equal(await run('document.querySelector("#var-rows-I").value'), '1/4');
  assert.equal(await run('document.querySelector("#solve-for").value'), 'R');
  assert.deepEqual(await answers('#single-result'), ['48.0000000000 ohm']);
  passed.push('history reload, class filtering, exact fractions, renamed systems and multiple answers');

  // Narrow drawer acts as a modal; worksheet input and focus are restored on dismissal.
  win.setContentSize(900, 800);
  await click('#history-toggle');
  await waitFor('document.querySelector("#history").getAttribute("aria-modal") === "true"', 'narrow history mode');
  assert.equal(await run('document.querySelector(".page-wrap").inert'), true);
  await run('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
  assert.equal(await run('document.activeElement.id'), 'history-toggle');
  assert.equal(await run('document.querySelector(".page-wrap").inert'), false);
  assert.equal(await run('document.querySelector("#var-rows-I").value'), '1/4');
  win.setContentSize(1320, 920);
  passed.push('drawer dismissal restores focus and preserves entered values');

  // A broken history file must not hide a successful solve or be silently overwritten.
  fs.writeFileSync(historyFile, '{broken');
  await click('#solve-btn');
  assert.doesNotMatch(await solved('#single-result'), /verified|checked against/);
  assert.deepEqual(await answers('#single-result'), ['48.0000000000 ohm']);
  assert.match(await text('#notice-message'), /history could not be saved/);
  assert.equal(fs.readFileSync(historyFile, 'utf8'), '{broken');
  await new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.webContents.reload(); });
  await waitFor('/Cannot read history/.test(document.querySelector("#history-status").textContent)', 'history read error');
  fs.writeFileSync(historyFile, JSON.stringify(archive));
  await click('#history-retry');
  await waitFor('document.querySelector("#history-count").textContent === "9"', 'history recovery');
  passed.push('history read/write failures preserve the archive and the current solve result');

  // Changing a library equation leaves the archived snapshot intact and prevents stale reuse.
  await run('(async () => { state.library = (await api.save({ ...byId("ohm"), formula: "V=2*I*R" })).equations; renderLibrary(); })()');
  await click('#history-toggle');
  await run(`document.querySelector('.history-item[data-id="${fraction.id}"]').open = true`);
  await waitFor(`document.querySelector('.history-item[data-id="${fraction.id}"] .history-detail')`, 'archived equation detail');
  assert.equal(await run(`!!document.querySelector('.history-item[data-id="${fraction.id}"] .history-reuse')`), false);
  assert.match(await text(`.history-item[data-id="${fraction.id}"]`), /Equation changed or removed/);
  assert.equal(JSON.parse(fs.readFileSync(historyFile, 'utf8')).entries.find(entry => entry.id === fraction.id).equations[0].formula, 'V = I*R');
  passed.push('archived equations remain readable after library edits');

  console.log('App end-to-end passed:\n' + passed.map(x => '  ✔ ' + x).join('\n'));
}).then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); }).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
