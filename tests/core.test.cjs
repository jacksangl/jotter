const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { launchSolver, SolverWorker } = require('../electron/bridge.cjs');
const { validateLibrary, readLibrary, writeLibrary } = require('../electron/library.cjs');
const solve = (equations, unknowns, values = {}, extra = {}) => launchSolver({ operation: 'solve', equations, unknowns, values, ...extra });

test('copied AI prompt example passes library and formula validation and solves correctly', async () => {
  const source = await fs.readFile(path.join(__dirname, '../src/ai-import-prompt.js'), 'utf8');
  const prompt = require('node:vm').runInNewContext(source + '\nAI_IMPORT_PROMPT');
  const example = JSON.parse(prompt.split('VALID EXAMPLE\n')[1].split('\n\nFINAL VALIDATION')[0]);
  const library = validateLibrary(example);
  for (const equation of library.equations) {
    const metadata = Object.fromEntries(equation.vars.map(v => [v.key, v]));
    const inspected = await launchSolver({ operation: 'inspect', equations: [equation.formula], metadata });
    assert.deepEqual(inspected.variables.map(v => v.key).sort(), equation.vars.map(v => v.key).sort());
  }
  const capacitor = library.equations[0];
  assert.equal(capacitor.vars.find(v => v.key === 'omega').tex, '\\omega');
  const metadata = Object.fromEntries(capacitor.vars.map(v => [v.key, v]));
  const result = await solve([capacitor.formula], ['Z'], { omega: '1000', C: '1e-6' }, { metadata });
  assert.equal(result.status, 'solved');
  assert.equal(result.answers[0].variables[0].decimal, '-1000.0*I');
});

// Test-only equations: none are seeded into the application library.
test('preview detects symbols and preserves explicit grouping; code execution is rejected', async () => {
  const result = await launchSolver({ operation: 'inspect', equations: ['q = a*(b-c)/d'] });
  assert.deepEqual(result.variables.map(v => v.key), ['q', 'a', 'b', 'c', 'd']);
  assert.match(result.latex[0], /frac/);
  for (const formula of ['x = __import__("os")', 'x = a.__class__', 'x = [1,2]', 'x = 2y', 'x = 10^1000']) {
    await assert.rejects(launchSolver({ operation: 'inspect', equations: [formula] }));
  }
});
test('single equation rearranges using exact fractions and scientific notation', async () => {
  const result = await solve(['q = a*(b-c)/d'], ['b'], { q: '1e-3', a: '1/2', c: '2', d: '5' });
  assert.equal(result.status, 'solved');
  assert.equal(result.answers[0].variables[0].decimal, '2.01000000000');
});
test('square brackets group expressions in previews and solves, including nested groups', async () => {
  const formula = 'I_d =\n (1/2 * k_n) * (W/L) * [(V_gs - V_tn)*V_ds * V_ds ^ 2]';
  const parentheses = formula.replaceAll('[', '(').replaceAll(']', ')');
  const bracketPreview = await launchSolver({operation:'inspect',equations:[formula]});
  const parenPreview = await launchSolver({operation:'inspect',equations:[parentheses]});
  assert.match(bracketPreview.latex[0], /\\left\[\\left\(V_\{gs\} - V_\{tn\}\\right\) V_\{ds\} V_\{ds\}\^\{2\}\\right\]/);
  assert.equal(bracketPreview.latex[0].replaceAll('\\left[', '\\left(').replaceAll('\\right]', '\\right)'), parenPreview.latex[0]);
  const result = await solve([formula], ['I_d'], {k_n:'2',W:'4',L:'2',V_gs:'3',V_tn:'1',V_ds:'2'});
  assert.equal(Number(result.answers[0].variables[0].decimal),32);
  assert.equal(Number((await solve(['q = [2 * [x + 1]]'], ['q'], {x:'3'})).answers[0].variables[0].decimal),8);
  for (const invalid of ['q = [x + 1)', 'q = []', 'q = [1, 2]', 'q = x[1]']) {
    await assert.rejects(launchSolver({operation:'inspect',equations:[invalid]}));
  }
});
test('fraction preview has no spurious identity factor and retains original denominator restrictions', async () => {
  const preview = await launchSolver({operation:'inspect',equations:['I_d = (1/2 * k_n) * (W/L)']});
  assert.equal(preview.latex[0], 'I_{d} = \\left(\\frac{k_{n}}{2}\\right) \\left(\\frac{W}{L}\\right)');
  const ratio = await launchSolver({operation:'inspect',equations:['q = x/x']});
  assert.match(ratio.latex[0], /\\frac\{x\}\{x\}/);
  await assert.rejects(solve(['I_d = (1/2 * k_n) * (W/L)'], ['I_d'], { k_n:'2', W:'1', L:'0' }), /division by zero/);
});
test('systems: unique, dependent and inconsistent', async () => {
  const unique = await solve(['x+y=5', 'x-y=1'], ['x','y']);
  assert.equal(unique.status, 'solved');
  assert.deepEqual(unique.answers[0].variables.map(v => Number(v.decimal)), [3,2]);
  assert.equal((await solve(['x+y=5','2*x+2*y=10'], ['x','y'])).status, 'underdetermined');
  assert.equal((await solve(['x+y=5','x+y=6'], ['x','y'])).status, 'no-solution');
});
test('nonlinear real and complex roots, domains and nonlinear systems', async () => {
  assert.equal((await solve(['x^2=4'], ['x'])).answers.length, 2);
  const positive = await solve(['x^2=4'], ['x'], {}, { metadata: { x: { domain: 'positive' } } });
  assert.equal(positive.answers.length, 1);
  assert.equal((await solve(['x^2=-1'], ['x'])).status, 'no-solution');
  assert.equal((await solve(['x^2=-1'], ['x'], {}, { metadata: { x: { domain: 'complex' } } })).answers.length, 2);
  assert.equal((await solve(['x*y=2', 'x+y=3'], ['x','y'])).answers.length, 2);
});
test('original denominators and required values cannot be simplified away', async () => {
  await assert.rejects(solve(['q=x/d'], ['x'], { q:'2', d:'0' }), /division by zero/);
  await assert.rejects(solve(['q=x/d'], ['x'], { q:'2' }), /value for `d`/);
  assert.equal((await solve(['x/x=0'], ['x'])).status, 'no-solution');
  assert.equal((await solve(['(x^2-1)/(x-1)=2'], ['x'])).status, 'no-solution');
});
test('numerical mode returns a verified root and cancellation terminates a request', async () => {
  const result = await solve(['cos(x)=x'], ['x'], {}, { numeric:true, guesses:{ x:'1' } });
  assert.equal(result.status, 'solved');
  assert.ok(Math.abs(Number(result.answers[0].variables[0].decimal) - 0.7390851332) < 1e-9);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(launchSolver({ operation:'inspect', equations:['x=1'] }, { signal:controller.signal }), /cancelled/);
});
test('empty library, durable saves, backup, validation and corrupt file preservation', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'equation-test-'));
  try {
    const file = path.join(directory,'library.json');
    assert.deepEqual(await readLibrary(file), {version:1,equations:[]});
    const library = { version:1, equations:[{id:'test',name:'Test only',subject:'math',klass:'',formula:'x=1',vars:[{key:'x',tex:'x',unit:'',desc:'',domain:'real'}]}] };
    await writeLibrary(file, library);
    assert.deepEqual(await readLibrary(file), library);
    await writeLibrary(file, {version:1,equations:[]});
    assert.deepEqual(JSON.parse(await fs.readFile(file+'.bak','utf8')), library);
    assert.throws(() => validateLibrary({version:2,equations:[]}));
    await fs.writeFile(file, 'broken');
    await assert.rejects(readLibrary(file), /not been overwritten/);
    assert.equal(await fs.readFile(file,'utf8'), 'broken');
  } finally { await fs.rm(directory,{recursive:true,force:true}); }
});
test('warm worker reuses its process and recovers after a cancelled calculation', async () => {
  const worker = new SolverWorker();
  try {
    const request = {operation:'solve',equations:['x+y=5'],unknowns:['x'],values:{y:'2'}};
    await worker.request(request);
    const pid = worker.child.pid;
    const result = await worker.request({...request,values:{y:'1'}});
    assert.equal(result.answers[0].variables[0].decimal,'4.00000000000');
    assert.equal(worker.child.pid,pid);
    const controller = new AbortController();
    const pending = worker.request(request,{signal:controller.signal});
    queueMicrotask(() => controller.abort());
    await assert.rejects(pending,/cancelled/);
    assert.equal((await worker.request(request)).status,'solved');
  } finally { worker.close(); }
});
