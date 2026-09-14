const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { SolverWorker } = require('../electron/bridge.cjs');
const sheet = require('../equation_sheet_ee.json');

// Exercise the app's JSON request/response path with one warm engine, no mocks.
const worker = new SolverWorker();
after(() => worker.close());
const solve = (equations, unknowns, values = {}, extra = {}) => worker.request({
  operation: 'solve', equations, unknowns, values, ...extra,
});

function checkAnswers(result, unknowns, expected, numeric = false) {
  assert.equal(result.status, 'solved', result.message);
  assert.equal(result.numeric, numeric);
  assert.equal(result.answers.length, expected.length);
  const actual = result.answers.map(answer => {
    assert.deepEqual(answer.variables.map(v => v.key), unknowns);
    assert.ok(Number.isFinite(answer.residual) && answer.residual <= 1e-10);
    for (const value of answer.variables) assert.ok(value.latex.length > 0);
    return answer.variables.map(v => v.decimal);
  }).sort();
  const rows = expected.map(row => row.map(String)).sort();
  actual.forEach((row, i) => row.forEach((value, j) => {
    const want = rows[i][j];
    if (Number.isFinite(Number(want))) {
      // Relative tolerance still catches wrong answers for pico/nano-scale inputs.
      assert.ok(Math.abs(Number(value) - Number(want)) <= Math.max(1e-24, Math.abs(Number(want)) * 1e-10), `${value} != ${want}`);
    } else assert.equal(value, want);
  }));
}

// Fixed inputs and independently calculated answers for every formula in our sheet.
const inputs = {
  k_n:'200e-6', k_p:'100e-6', W:'10e-6', L:'1e-6', v_GS:'3', V_tn:'1', v_DS:'0.5',
  v_SG:'3', V_tp:'-1', v_SD:'0.5', R_1:'1e3', R_2:'9e3', A_1:'10', A_Od:'100',
  A_0:'100000', f:'10', f_b:'10', A_CL_ideal:'10', f_3dB:'10', dvO_dt:'-2e6',
  I_B1:'60e-9', I_B2:'40e-9', I_B:'50e-9', I_OS:'20e-9', W_n:'10e-6', L_n:'1e-6',
  W_p:'20e-6', L_p:'1e-6', V_DD:'5', r:'1', V_t:'1', alpha_n:'2', alpha_p:'2', C_L:'10e-12',
};
const sheetAnswers = {
  'nmos-triode':0.00175, 'nmos-saturation':0.004, 'nmos-gds':0.004,
  'pmos-triode':0.000875, 'pmos-saturation':0.002, 'pmos-gds':0.002,
  'inverting-gain':-9, 'noninverting-gain':10, 'opamp-closed-loop-gain':100/11,
  'opamp-open-loop-frequency':'50000.0 - 50000.0*I',
  'opamp-closed-loop-frequency':'5.0 - 5.0*I',
  'unity-gain-frequency':1e6, 'unity-gain-feedback':100, 'slew-rate':2e6,
  'input-bias-current':50e-9, 'input-offset-current':20e-9,
  'input-bias-current-one':60e-9, 'input-bias-current-two':40e-9,
  'cmos-nmos-output-resistance':125, 'cmos-pmos-output-resistance':125,
  'cmos-switching-threshold':2.5, 'cmos-strength-ratio':1, 'cmos-matched-threshold':2.5,
  'cmos-vil':2.125, 'cmos-vih':2.875, 'cmos-noise-margin':2.125, 'cmos-noise-margin-low':2.125,
  'cmos-tphl':2e-9, 'cmos-alpha-n':200/119, 'cmos-tplh':2e-9,
  'cmos-alpha-p':200/119, 'cmos-dynamic-power':2.5e-9,
};
test('EE sheet has a known-answer case for every equation', () => {
  assert.deepEqual(sheet.equations.map(eq => eq.id).sort(), Object.keys(sheetAnswers).map(id => `ee310-${id}`).sort());
});
for (const eq of sheet.equations) {
  test(`EE sheet: ${eq.name}`, async () => {
    const metadata = Object.fromEntries(eq.vars.map(v => [v.key, v]));
    const preview = await worker.request({ operation:'inspect', equations:[eq.formula], metadata });
    assert.deepEqual(preview.variables.map(v => v.key).sort(), eq.vars.map(v => v.key).sort());
    assert.ok(preview.latex[0].includes('='));
    const unknown = eq.formula.split('=')[0].trim();
    const values = Object.fromEntries(eq.vars.filter(v => v.key !== unknown).map(v => [v.key, inputs[v.key]]));
    checkAnswers(await solve([eq.formula], [unknown], values, { metadata }), [unknown], [[sheetAnswers[eq.id.slice(6)]]]);
  });
}

for (const [id, unknown, overrides, expected] of [
  ['nmos-triode', 'v_DS', {i_D:'0.00175'}, [0.5,3.5]],
  ['nmos-saturation', 'v_GS', {i_D:'0.004'}, [-1,3]],
  ['inverting-gain', 'R_2', {A_V:'-9'}, [9000]],
  ['unity-gain-frequency', 'f_b', {f_T:'1e6'}, [10]],
  ['slew-rate', 'dvO_dt', {SR:'2e6'}, [-2e6,2e6]],
  ['cmos-dynamic-power', 'V_DD', {P_D:'2.5e-9'}, [-5,5]],
]) {
  test(`EE rearrangement: ${id} for ${unknown}`, async () => {
    const eq = sheet.equations.find(eq => eq.id === `ee310-${id}`);
    const metadata = Object.fromEntries(eq.vars.map(v => [v.key, v]));
    checkAnswers(await solve([eq.formula], [unknown], {...inputs,...overrides}, {metadata}), [unknown], expected.map(v => [v]));
  });
}

const cases = [
  ['precedence', 'q=2+3*4^2', 'q', {}, [50]],
  ['unary minus before power', 'q=-2^2', 'q', {}, [-4]],
  ['negative base', 'q=(-2)^2', 'q', {}, [4]],
  ['right associative powers', 'q=2^3^2', 'q', {}, [512]],
  ['negative power', 'q=2^-3', 'q', {}, [0.125]],
  ['unicode minus', 'q=5−8', 'q', {}, [-3]],
  ['exact decimal arithmetic', 'q=0.1+0.2', 'q', {}, [0.3]],
  ['fraction values', 'q=a/b', 'q', {a:'1/3',b:'2/7'}, [7/6]],
  ['constant expression values', 'q=a+b', 'q', {a:'sin(pi/2)',b:'ln(e)'}, [2]],
  ['Ohm voltage', 'V=I*R', 'V', {I:'2e-3',R:'4700'}, [9.4]],
  ['Ohm current', 'V=I*R', 'I', {V:'9.4',R:'4700'}, [0.002]],
  ['Ohm resistance', 'V=I*R', 'R', {V:'9.4',I:'2e-3'}, [4700]],
  ['zero coefficient identity', 'y=a*x', 'x', {y:'0',a:'0'}, 'underdetermined'],
  ['zero coefficient contradiction', 'y=a*x', 'x', {y:'1',a:'0'}, 'no-solution'],
  ['quadratic distinct roots', 'x^2-5*x+6=0', 'x', {}, [2,3]],
  ['quadratic repeated root', '(x-3)^2=0', 'x', {}, [3]],
  ['cubic real roots', 'x^3-x=0', 'x', {}, [-1,0,1]],
  ['absolute value roots', 'abs(x)=3', 'x', {}, [-3,3]],
  ['square root inverse', 'sqrt(x)=3', 'x', {}, [9]],
  ['square root extraneous root', 'sqrt(x)=-3', 'x', {}, 'no-solution'],
  ['log inverse', 'ln(x)=2', 'x', {}, [Math.exp(2)]],
  ['exponential inverse', 'exp(x)=2', 'x', {}, [Math.log(2)]],
  ['periodic solution set', 'sin(x)=0', 'x', {}, 'conditional'],
  ['integer rejects fractional root', '2*x=3', 'x', {}, 'no-solution', {metadata:{x:{domain:'integer'}}}],
  ['integer roots', 'x^2=4', 'x', {}, [-2,2], {metadata:{x:{domain:'integer'}}}],
  ['positive excludes zero', 'x*(x-2)=0', 'x', {}, [2], {metadata:{x:{domain:'positive'}}}],
  ['complex roots', 'x^2=-1', 'x', {}, ['-1.0*I','1.0*I'], {metadata:{x:{domain:'complex'}}}],
  ['complex known value', 'z=a+1', 'z', {a:'2+3*i'}, ['3.0 + 3.0*I'], {metadata:{z:{domain:'complex'},a:{domain:'complex'}}}],
];
for (const [name, formula, unknown, values, expected, extra] of cases) {
  test(`equation: ${name}`, async () => {
    const result = await solve([formula], [unknown], values, extra);
    if (typeof expected === 'string') {
      assert.equal(result.status, expected);
      assert.ok(result.message);
      if (expected === 'conditional') assert.ok(result.setLatex);
    } else checkAnswers(result, [unknown], expected.map(value => [value]));
  });
}

for (const [expression, expected] of [
  ['sin(pi/2)',1], ['cos(pi)',-1], ['tan(pi/4)',1], ['asin(1)',Math.PI/2],
  ['acos(0)',Math.PI/2], ['atan(1)',Math.PI/4], ['sinh(0)',0], ['cosh(0)',1],
  ['tanh(0)',0], ['exp(1)',Math.E], ['log(8,2)',3], ['ln(e)',1], ['sqrt(9)',3], ['Abs(-4)',4], ['abs(-4)',4],
]) {
  test(`function: ${expression}`, async () => checkAnswers(await solve([`q=${expression}`], ['q']), ['q'], [[expected]]));
}

for (const [name, equations, unknowns, values, expected, extra] of [
  ['ordered unknowns', ['x+y=5','x-y=1'], ['y','x'], {}, [[2,3]]],
  ['three unknowns', ['x+y+z=6','x-y=0','z=2*x'], ['x','y','z'], {}, [[1.5,1.5,3]]],
  ['nonlinear roots', ['x*y=2','x+y=3'], ['x','y'], {}, [[1,2],[2,1]]],
  ['overdetermined consistent', ['x+y=5','x-y=1','2*x=6'], ['x','y'], {}, [[3,2]]],
  ['EE bias and offset', ['I_B=(I_B1+I_B2)/2','I_OS=abs(I_B1-I_B2)'], ['I_B1','I_B2'], {I_B:'50e-9',I_OS:'20e-9'}, [[40e-9,60e-9],[60e-9,40e-9]]],
  ['numerical fixed point', ['cos(x)=x'], ['x'], {}, [[0.739085133215]], {numeric:true,guesses:{x:'1'}}],
  ['numerical system', ['x^2+y^2=5','x-y=1'], ['x','y'], {}, [[2,1]], {numeric:true,guesses:{x:'2.1',y:'0.9'}}],
]) {
  test(`system: ${name}`, async () => checkAnswers(await solve(equations, unknowns, values, extra), unknowns, expected, !!extra?.numeric));
}

for (const raw of ['', 'abc', '1/0', 'sqrt(-1)', '1e101', '__import__("os")']) {
  test(`invalid known value: ${JSON.stringify(raw)}`, async () => {
    await assert.rejects(solve(['q=a'], ['q'], {a:raw}), /finite value for `a` matching/);
  });
}
test('absolute-value systems reject impossible offsets and respect positive domains', async () => {
  const equations = ['x+y=2', 'abs(x-y)=4'];
  checkAnswers(await solve(equations, ['x','y']), ['x','y'], [[-1,3],[3,-1]]);
  assert.equal((await solve(equations, ['x','y'], {}, {metadata:{x:{domain:'positive'},y:{domain:'positive'}}})).status, 'no-solution');
  assert.equal((await solve(['x+y=2','abs(x-y)=-1'], ['x','y'])).status, 'no-solution');
});
for (const [name, equations, unknowns, values, extra, error] of [
  ['missing known', ['q=a+b'], ['q'], {a:'1'}, {}, /value for `b`/],
  ['zero denominator', ['q=a/b'], ['q'], {a:'1',b:'0'}, {}, /division by zero/],
  ['zero negative power', ['q=a^-1'], ['q'], {a:'0'}, {}, /division by zero/],
  ['positive known zero', ['q=a'], ['q'], {a:'0'}, {metadata:{a:{domain:'positive'}}}, /finite value/],
  ['integer known fraction', ['q=a'], ['q'], {a:'1/2'}, {metadata:{a:{domain:'integer'}}}, /finite value/],
  ['duplicate unknown', ['x=1'], ['x','x'], {}, {}, /distinct unknowns/],
  ['absent unknown', ['x=1'], ['y'], {}, {}, /distinct unknowns/],
  ['empty unknowns', ['x=1'], [], {}, {}, /distinct unknowns/],
  ['no equations', [], ['x'], {}, {}, /one and eight/],
  ['too many equations', Array(9).fill('x=1'), ['x'], {}, {}, /one and eight/],
]) {
  test(`validation: ${name}`, async () => assert.rejects(solve(equations, unknowns, values, extra), error));
}
