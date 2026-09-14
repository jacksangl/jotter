'use strict';
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const subjects = { math: 'Math', ee: 'Electrical Engineering', cs: 'Computer Science' };
const api = window.calculator;
const state = { library: [], selected: null, unknown: null, values: {}, busy: false, editorId: null, editorVars: [], previewVersion: 0, slots: ['', ''], mappings: {}, systemUnknowns: new Set(), systemValues: {} };
let worksheetReady = false, worksheetTimer, worksheetMode = 'equation', worksheetWarning = false;
function scheduleWorksheetSave() {
  if (!worksheetReady) return;
  clearTimeout(worksheetTimer);
  worksheetTimer = setTimeout(saveWorksheet, 300);
}
function saveWorksheet() {
  clearTimeout(worksheetTimer);
  if (!worksheetReady) return;
  const system = worksheetMode === 'system', prefix = system ? 'system' : 'single';
  const snapshot = {
    version: 1, mode: worksheetMode, numeric: $(`#${prefix}-numeric`).checked,
    guesses: Object.fromEntries($$(`#${prefix}-guesses input`).map(input => [input.dataset.key, input.value])),
    ...(system ? { slots: state.slots, mappings: state.mappings, unknowns: [...state.systemUnknowns], values: state.systemValues }
      : { selected: state.selected, unknown: state.unknown, values: state.values[state.selected] }),
  };
  try { Worksheet.write(localStorage, snapshot, state.library); worksheetWarning = false; }
  catch (error) {
    if (!worksheetWarning) notify(error.message.includes('too large') ? error.message : 'Could not remember this worksheet across restarts. Your equation library is saved separately.', true);
    worksheetWarning = true;
  }
}
window.addEventListener('beforeunload', saveWorksheet);
const copyText = text => api?.copy ? api.copy(text) : navigator.clipboard.writeText(text);
const byId = id => state.library.find(eq => eq.id === id);
const metadata = vars => Object.fromEntries(vars.map(v => [v.key, v]));
const tex = (element, source, display = false) => katex.render(source, element, { displayMode: display, throwOnError: false, trust: false, maxExpand: 200, maxSize: 10 });
function node(tag, className = '', text = '') { const e = document.createElement(tag); e.className = className; e.textContent = text; return e; }
function option(value, text) { const e = node('option', '', text); e.value = value; return e; }
function dropdownOptions(select, options) {
  // Chromium's customizable select keeps native selection, keyboard and focus behavior.
  const button = node('button'); button.type = 'button';
  button.append(node('selectedcontent'));
  select.replaceChildren(button, ...options);
}
function notify(message, error = false) { $('#notice-message').textContent = message; $('#notice').hidden = !message; $('#notice').classList.toggle('error', error); }
async function action(work) { try { return await work(); } catch (error) { notify(error.message, true); } }
function renderMessage(container, message, vars = []) {
  const paragraph = node('p');
  const known = [...vars].sort((a, b) => b.key.length - a.key.length);
  if (!known.length) paragraph.textContent = message;
  else {
    const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\b(?:${known.map(v => escapeRegex(v.key)).join('|')})\\b`, 'g');
    let cursor = 0;
    for (const match of message.matchAll(pattern)) {
      paragraph.append(document.createTextNode(message.slice(cursor, match.index)));
      const symbol = node('span');
      const variable = known.find(v => v.key === match[0]);
      tex(symbol, variable.tex || variable.key.replace(/_(\w+)/, '_{$1}'));
      paragraph.append(symbol);
      cursor = match.index + match[0].length;
    }
    paragraph.append(document.createTextNode(message.slice(cursor)));
  }
  container.replaceChildren(paragraph);
}
function showError(container, message, vars) { renderMessage(container, message, vars); }
function invalidateResult(system = false) { $(`#${system ? 'system' : 'single'}-result`).textContent = 'Values changed. Solve to update the result.'; scheduleWorksheetSave(); }
function showTab(name) {
  if (name === 'equation' || name === 'system') worksheetMode = name;
  scheduleWorksheetSave();
  $$('.tab').forEach(tab => {
    const selected = tab.id === `tab-${name}`;
    tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
    document.getElementById(tab.getAttribute('aria-controls')).hidden = !selected;
  });
}
$$('.tab').forEach((tab, index, tabs) => {
  tab.addEventListener('click', () => showTab(tab.id.slice(4)));
  tab.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next].click(); tabs[next].focus();
  });
});
function renderLibrary() {
  const equations = state.library;
  const previousClass = $('#class-filter').value;
  dropdownOptions($('#class-filter'), [option('', 'All classes'), ...[...new Set(equations.map(e => e.klass).filter(Boolean))].sort().map(c => option(c, c))]);
  $('#class-filter').value = [...$('#class-filter').options].some(o => o.value === previousClass) ? previousClass : '';
  const query = $('#search').value.toLowerCase();
  const items = equations.filter(e => (!$('#class-filter').value || e.klass === $('#class-filter').value) && `${e.name} ${e.klass} ${e.formula}`.toLowerCase().includes(query));
  $('#library-count').textContent = String(items.length);
  $('#library-empty').hidden = items.length > 0;
  $('#library-empty').textContent = equations.length ? 'No matching equations.' : 'No equations here yet.';
  $('#library-list').replaceChildren(...items.map(eq => {
    const li = node('li'), button = node('button', 'library-item');
    button.setAttribute('aria-selected', String(eq.id === state.selected));
    button.append(node('span', '', eq.name), node('small', '', eq.klass || 'No class'));
    button.addEventListener('contextmenu', event => { event.preventDefault(); equationMenu(eq); });
    button.addEventListener('keydown', event => {
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); equationMenu(eq); }
    });
    button.addEventListener('mouseenter', () => showPreview(eq, button));
    button.addEventListener('mouseleave', hidePreview);
    button.addEventListener('click', () => { hidePreview(); selectEquation(eq); }); li.append(button); return li;
  }));
}
// Small formula preview beside a hovered library item. It shares the LaTeX cache below and fills any
// miss through the preview channel, which never cancels the sheet's or editor's inspect.
let previewTarget = null, previewDelay;
const previewLatex = eq => formulaLatex(eq, api.preview || api.inspect);
function showPreview(eq, anchor) {
  hidePreview(); previewTarget = anchor;
  previewDelay = setTimeout(async () => {
    let latex;
    try { latex = await previewLatex(eq); } catch { return; }
    if (previewTarget !== anchor || !anchor.isConnected) return;
    const preview = $('#eq-preview');
    tex(preview, latex); preview.hidden = false;
    // Sit just right of the sidebar, clamped to the window, so it never covers the list or the sheet's controls.
    const rect = anchor.getBoundingClientRect(), box = preview.getBoundingClientRect(), edge = $('#library').getBoundingClientRect().right;
    preview.style.left = `${Math.min(edge + 8, window.innerWidth - box.width - 8)}px`;
    preview.style.top = `${Math.max(8, Math.min(rect.top + (rect.height - box.height) / 2, window.innerHeight - box.height - 8))}px`;
  }, 200);
}
function hidePreview() { clearTimeout(previewDelay); previewTarget = null; $('#eq-preview').hidden = true; }
$('#library-list').addEventListener('scroll', hidePreview);
window.addEventListener('blur', hidePreview);
function selectEquation(eq) {
  state.selected = eq?.id || null; state.unknown = eq?.vars[0]?.key || null;
  renderLibrary(); renderEquation(); showTab('equation');
}
$('#search').addEventListener('input', renderLibrary);
$('#class-filter').addEventListener('change', renderLibrary);
function variableRows(container, vars, unknowns, values, changed) {
  container.replaceChildren(...vars.map(v => {
    const row = node('div', `var-row${unknowns.has(v.key) ? ' is-unknown' : ''}`);
    const symbol = node('label', 'var-sym'); tex(symbol, v.tex || v.key.replace(/_(\w+)/, '_{$1}'));
    const equals = node('div', 'var-eq', '='); equals.setAttribute('aria-hidden', 'true');
    const cell = node('div');
    if (unknowns.has(v.key)) cell.append(node('span', 'var-unknown', '? unknown · solve for this'));
    else {
      const input = node('input', 'input'); input.type = 'text'; input.inputMode = 'text'; input.autocomplete = 'off';
      input.id = `${container.id}-${v.key}`; symbol.htmlFor = input.id;
      input.setAttribute('aria-label', `${v.key}${v.unit ? ` in ${v.unit}` : ''}`);
      input.value = values[v.key] || ''; input.maxLength = 200;
      input.addEventListener('input', () => { values[v.key] = input.value; changed(); }); cell.append(input);
    }
    row.append(symbol, equals, cell, node('div', 'var-meta', [v.unit, v.desc].filter(Boolean).join(' · '))); return row;
  }));
}
// LaTeX for an equation depends only on its formula and variable metadata, never on the chosen unknown,
// so it is inspected once, cached by content and rendered synchronously on later visits.
const latexCache = new Map(), latexPending = new Map();
const latexKey = eq => JSON.stringify([eq.formula, eq.vars.map(v => [v.key, v.tex || ''])]);
let lastInspect = Promise.resolve();
function inspect(input) {
  const pending = api.inspect(input);
  lastInspect = pending.catch(() => {});
  return pending;
}
function formulaLatex(eq, fetch = inspect) {
  const key = latexKey(eq);
  if (latexCache.has(key)) return Promise.resolve(latexCache.get(key));
  if (!latexPending.has(key)) {
    const pending = fetch({ equations: [eq.formula], metadata: metadata(eq.vars) })
      .then(inspected => { latexCache.set(key, inspected.latex[0]); return inspected.latex[0]; })
      .finally(() => latexPending.delete(key));
    latexPending.set(key, pending);
  }
  return latexPending.get(key);
}
let equationRender = 0;
function renderFormula(eq) {
  const version = ++equationRender, cached = latexCache.get(latexKey(eq));
  if (cached !== undefined) { tex($('#eq-formula'), cached, true); return; }
  $('#eq-formula').textContent = eq.formula;
  formulaLatex(eq)
    .then(latex => { if (version === equationRender) tex($('#eq-formula'), latex, true); })
    .catch(error => { if (version === equationRender) notify(error.message, true); });
}
// Warm the cache in the background so the first visit to each equation renders LaTeX immediately.
// The main process cancels an in-flight inspect when a new one starts, so wait for any active inspect first.
let warming = false;
async function warmLatexCache() {
  if (warming || !api) return;
  warming = true;
  try {
    for (const eq of [...state.library]) {
      if (latexCache.has(latexKey(eq))) continue;
      await lastInspect;
      if (!byId(eq.id)) continue;
      try { await formulaLatex(eq); } catch { /* Left uncached; the next selection fetches it. */ }
      paintSlotFormulas();
    }
  } finally { warming = false; }
}
// Slot dropdowns show plain formulas until the cache holds their LaTeX; fetching per option would cancel the active inspect.
function paintSlotFormulas() {
  for (const span of $$('.slot-formula:not(:has(.katex))')) {
    const eq = byId(span.dataset.id), cached = eq && latexCache.get(latexKey(eq));
    if (cached !== undefined) tex(span, cached);
  }
}
function renderUnknown() {
  scheduleWorksheetSave();
  const eq = byId(state.selected);
  if (!eq) return;
  if (!eq.vars.some(v => v.key === state.unknown)) state.unknown = eq.vars[0]?.key || null;
  $('#solve-for').value = state.unknown;
  state.values[eq.id] ||= {};
  variableRows($('#var-rows'), eq.vars, new Set([state.unknown]), state.values[eq.id], () => invalidateResult());
  $('#single-result').textContent = 'Choose an unknown and enter the known values.';
  renderGuesses(false);
}
function renderEquation() {
  const eq = byId(state.selected);
  $('#equation-sheet').hidden = !eq; $('#equation-empty').hidden = !!eq;
  if (!eq) { scheduleWorksheetSave(); return; }
  $('#eq-name').textContent = eq.name; $('#eq-context').textContent = [subjects[eq.subject], eq.klass].filter(Boolean).join(' / ');
  dropdownOptions($('#solve-for'), eq.vars.map(v => {
    const item = option(v.key, ''); item.setAttribute('aria-label', v.key);
    const symbol = node('span'); tex(symbol, v.tex || v.key.replace(/_(\w+)/, '_{$1}'));
    item.append(symbol); return item;
  }));
  renderUnknown();
  renderFormula(eq);
}
$('#solve-for').addEventListener('change', () => { state.unknown = $('#solve-for').value; renderUnknown(); });
$('#clear-values').addEventListener('click', () => { if (state.selected) state.values[state.selected] = {}; renderUnknown(); });

let previewTimer;
function captureEditorVars() {
  return [...$('#ed-vars tbody').children].map(row => {
    const inputs = row.querySelectorAll('input, select');
    return { key: row.dataset.key, tex: inputs[0].value, unit: inputs[1].value, desc: inputs[2].value, domain: inputs[3].value };
  });
}
function renderEditorVars(vars) {
  $('#ed-vars tbody').replaceChildren(...vars.map(v => {
    const row = node('tr'), sym = node('td', 'var-sym'); row.dataset.key = v.key; sym.title = v.key; tex(sym, v.tex || v.key.replace(/_(\w+)/, '_{$1}')); row.append(sym);
    for (const [field, label, limit] of [['tex', 'display LaTeX', 120], ['unit', 'unit', 40], ['desc', 'description', 200]]) {
      const td = node('td'), input = node('input', 'input'); input.value = v[field] || ''; input.maxLength = limit;
      input.setAttribute('aria-label', `${v.key} ${label}`); td.append(input); row.append(td);
    }
    const td = node('td'), select = node('select', 'select'); select.setAttribute('aria-label', `${v.key} domain`);
    select.append(...['real', 'positive', 'integer', 'complex'].map(d => option(d, d))); select.value = v.domain || 'real'; td.append(select); row.append(td); return row;
  }));
}
function openEditor(eq = null, duplicate = false) {
  state.previewVersion++; clearTimeout(previewTimer); state.editorId = duplicate ? null : eq?.id || null;
  $('#editor-form').reset(); $('#ed-name').value = eq ? eq.name + (duplicate ? ' (copy)' : '') : '';
  $('#ed-subject').value = eq?.subject || 'math'; $('#ed-class').value = eq?.klass || ''; $('#ed-formula').value = eq?.formula || '';
  state.editorVars = eq?.vars.map(v => ({ ...v })) || []; renderEditorVars(state.editorVars);
  $('#editor-title').textContent = state.editorId ? 'Edit equation' : 'Add equation';
  $('#delete').hidden = !state.editorId; $('#ed-preview').textContent = 'Your formatted equation will appear here.';
  $('#editor-status').textContent = 'Saved locally. Export your library to use it on another computer.';
  showTab('editor'); $('#ed-name').focus(); if (eq) previewEquation();
}
$$('[data-new]').forEach(b => b.addEventListener('click', () => openEditor()));
$('#editor-clear').addEventListener('click', () => openEditor());
$('#edit').addEventListener('click', () => openEditor(byId(state.selected)));
$('#duplicate').addEventListener('click', () => openEditor(byId(state.selected), true));
async function previewEquation() {
  const version = ++state.previewVersion, formula = $('#ed-formula').value.trim();
  if (!formula) { $('#ed-preview').textContent = 'Your formatted equation will appear here.'; renderEditorVars([]); return null; }
  const existing = metadata(captureEditorVars());
  try {
    const inspected = await inspect({ equations: [formula], metadata: existing });
    if (version !== state.previewVersion) return null;
    state.editorVars = inspected.variables.map(v => ({ ...v, unit: '', desc: '', domain: 'real', ...existing[v.key] }));
    renderEditorVars(state.editorVars); tex($('#ed-preview'), inspected.latex[0], true);
    $('#editor-status').textContent = `${state.editorVars.length} variables detected. Check the grouping above before saving.`;
    return inspected;
  } catch (error) {
    if (version === state.previewVersion) { $('#ed-preview').textContent = error.message; $('#editor-status').textContent = 'Check the formula before saving.'; }
    return null;
  }
}
$('#ed-formula').addEventListener('input', () => { state.previewVersion++; clearTimeout(previewTimer); previewTimer = setTimeout(previewEquation, 300); });
$('#ed-vars').addEventListener('change', () => { clearTimeout(previewTimer); previewTimer = setTimeout(previewEquation, 300); });
$('#editor-form').addEventListener('submit', event => {
  event.preventDefault();
  action(async () => {
    clearTimeout(previewTimer); $('#save').disabled = true;
    try {
      if (!await previewEquation()) throw new Error('Correct the formula before saving.');
      const eq = { id: state.editorId || crypto.randomUUID(), name: $('#ed-name').value.trim(), subject: $('#ed-subject').value, klass: $('#ed-class').value.trim(), formula: $('#ed-formula').value.trim(), vars: captureEditorVars() };
      const library = await api.save(eq); state.library = library.equations;
      $('#search').value = ''; $('#class-filter').value = ''; state.editorId = eq.id;
      renderSlots(); selectEquation(byId(eq.id)); notify('Equation saved.');
    } finally { $('#save').disabled = false; }
  });
});
async function deleteEquation(id) {
  const library = await api.remove(id); state.library = library.equations;
  if (!byId(id)) {
    delete state.values[id];
    if (state.editorId === id) openEditor();
    if (state.selected === id) selectEquation(state.library[0]);
  }
  renderLibrary(); renderSlots();
}
$('#delete').addEventListener('click', () => action(() => deleteEquation(state.editorId)));
let renameId = null;
async function equationMenu(eq) {
  if (state.busy) return;
  await action(async () => {
    const choice = await api.equationMenu();
    if (state.busy || !byId(eq.id)) return;
    if (choice === 'delete') await deleteEquation(eq.id);
    if (choice === 'rename') {
      renameId = eq.id;
      $('#rename-name').value = byId(eq.id).name;
      $('#rename-error').textContent = '';
      $('#rename-dialog').showModal(); $('#rename-name').select();
    }
  });
}
$('#rename-cancel').addEventListener('click', () => $('#rename-dialog').close());
$('#rename-form').addEventListener('submit', async event => {
  event.preventDefault();
  const name = $('#rename-name').value.trim();
  if (!name) { $('#rename-error').textContent = 'Enter a name.'; return; }
  $('#rename-save').disabled = true;
  try {
    const eq = byId(renameId);
    if (!eq) throw new Error('Equation not found.');
    state.library = (await api.save({ ...eq, name })).equations;
    renderLibrary(); renderSlots();
    if (state.selected === renameId) $('#eq-name').textContent = name;
    if (state.editorId === renameId) $('#ed-name').value = name;
    $('#rename-dialog').close();
  } catch (error) { $('#rename-error').textContent = error.message; }
  finally { $('#rename-save').disabled = false; }
});
function toggleSidebar(collapsed = !$('#library').hidden) {
  $('#library').hidden = collapsed;
  $('.workspace').classList.toggle('sidebar-collapsed', collapsed);
  $('#toggle-sidebar').setAttribute('aria-expanded', String(!collapsed));
  $('#toggle-sidebar').setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
  $('#toggle-sidebar').title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
}
$('#toggle-sidebar').addEventListener('click', () => toggleSidebar());
$('#dismiss-notice').addEventListener('click', () => notify(''));

function renderSlots() {
  $('#slots').replaceChildren(...state.slots.map((id, index) => {
    const li = node('li', 'slot');
    const label = node('label', '', `Equation ${index + 1}`); label.htmlFor = `slot-${index}`;
    const select = node('select', 'select notebook-select'); select.id = label.htmlFor;
    dropdownOptions(select, [option('', 'Choose an equation'), ...state.library.map(eq => {
      const item = option(eq.id, ''), formula = node('span', 'slot-formula');
      item.setAttribute('aria-label', `${eq.name} · ${subjects[eq.subject]}`); item.append(node('span', 'slot-name', eq.name), formula);
      formula.dataset.id = eq.id; formula.textContent = eq.formula;
      return item;
    })]);
    select.value = byId(id) ? id : ''; state.slots[index] = select.value;
    select.addEventListener('change', () => { state.slots[index] = select.value; state.mappings[index] = {}; renderSystem(); });
    li.append(label, select);
    if (state.slots.length > 2) { const remove = node('button', 'btn btn-ghost btn-sm', 'Remove'); remove.addEventListener('click', () => { state.slots.splice(index, 1); state.mappings = {}; renderSlots(); }); li.append(remove); }
    return li;
  }));
  paintSlotFormulas();
  $('#add-slot').disabled = state.slots.length >= 8; renderSystem();
}
$('#add-slot').addEventListener('click', () => { if (state.slots.length < 8) { state.slots.push(''); renderSlots(); } });
function systemData() {
  const equations = [], vars = new Map();
  state.slots.forEach((id, index) => {
    const eq = byId(id); if (!eq) return;
    const mapping = {};
    eq.vars.forEach(v => {
      const key = state.mappings[index]?.[v.key] || v.key;
      if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(key)) throw new Error('Shared variable names must start with a letter and contain only letters, numbers or underscores.');
      if (Object.values(mapping).includes(key)) throw new Error('Two variables in the same equation cannot share a symbol.');
      mapping[v.key] = key;
      const previous = vars.get(key);
      if (previous && (previous.unit !== v.unit || previous.domain !== v.domain)) throw new Error(`The shared variable ${key} has different unit labels or domains. Edit the equations to agree or use separate shared symbols.`);
      vars.set(key, { ...v, key, tex: key === v.key ? v.tex : key });
    });
    equations.push(eq.formula.replace(/\b[A-Za-z][A-Za-z0-9_]*\b/g, name => mapping[name] || name));
  });
  return { equations, vars: [...vars.values()] };
}
function renderSystem() {
  scheduleWorksheetSave();
  $('#mappings').replaceChildren();
  state.slots.forEach((id, index) => {
    const eq = byId(id); if (!eq) return;
    const section = node('div', 'mapping-section'); section.append(node('h3', '', `${index + 1}. ${eq.name}`));
    eq.vars.forEach(v => {
      const label = node('label', 'mapping-row'), symbol = node('span'), input = node('input', 'input');
      tex(symbol, v.tex || v.key.replace(/_(\w+)/, '_{$1}')); label.append(symbol, node('span', 'muted', '→'));
      input.value = state.mappings[index]?.[v.key] || v.key; input.maxLength = 40;
      input.setAttribute('aria-label', `Equation ${index + 1} shared symbol for ${v.key}`);
      input.addEventListener('input', () => { state.mappings[index] ||= {}; state.mappings[index][v.key] = input.value.trim(); invalidateResult(true); });
      input.addEventListener('change', () => { state.mappings[index] ||= {}; state.mappings[index][v.key] = input.value.trim(); renderSystem(); });
      label.append(input); section.append(label);
    }); $('#mappings').append(section);
  });
  try {
    const { vars } = systemData();
    state.systemUnknowns = new Set([...state.systemUnknowns].filter(key => vars.some(v => v.key === key)));
    $('#unknown-list').replaceChildren(...vars.map(v => {
      const label = node('label'), checkbox = node('input'), symbol = node('span'); checkbox.type = 'checkbox'; checkbox.checked = state.systemUnknowns.has(v.key); checkbox.setAttribute('aria-label', `Solve for ${v.key}`);
      tex(symbol, v.tex || v.key); checkbox.addEventListener('change', () => { checkbox.checked ? state.systemUnknowns.add(v.key) : state.systemUnknowns.delete(v.key); renderSystem(); });
      label.append(checkbox, symbol); return label;
    }));
    if (!vars.length) $('#unknown-list').textContent = 'Choose equations to see their variables.';
    variableRows($('#system-vars'), vars, state.systemUnknowns, state.systemValues, () => invalidateResult(true));
    $('#system-result').textContent = 'Choose the unknowns and fill in the remaining values.'; renderGuesses(true);
  } catch (error) { $('#system-result').textContent = error.message; }
}
function renderGuesses(system) {
  const prefix = system ? 'system' : 'single', container = $(`#${prefix}-guesses`);
  const values = Object.fromEntries([...container.querySelectorAll('input')].map(input => [input.dataset.key, input.value]));
  const keys = system ? [...state.systemUnknowns] : [state.unknown].filter(Boolean);
  container.replaceChildren(...keys.map(key => {
    const label = node('label', 'guess-row', `${key} starting guess`), input = node('input', 'input'); input.dataset.key = key; input.value = values[key] || ''; input.setAttribute('aria-label', `${key} starting guess`);
    input.maxLength = 200;
    input.addEventListener('input', () => invalidateResult(system)); label.append(input); return label;
  }));
  container.hidden = !$(`#${prefix}-numeric`).checked;
}
for (const system of [false, true]) $(`#${system ? 'system' : 'single'}-numeric`).addEventListener('change', () => { renderGuesses(system); invalidateResult(system); });
function showResult(container, result, vars) {
  container.replaceChildren(node('div', 'result-label', 'Result'));
  if (result.message) { const message = node('div'); renderMessage(message, result.message, vars); container.append(message); }
  if (result.setLatex) { const equation = node('div', 'result-formula'); tex(equation, result.setLatex, true); container.append(equation); }
  for (const [index, answer] of (result.answers || []).entries()) {
    if (result.answers.length > 1) container.append(node('h3', '', `Solution ${index + 1}`));
    for (const value of answer.variables) {
      const v = vars.find(v => v.key === value.key), line = node('div', 'answer-row'), formula = node('span');
      tex(formula, `${v?.tex || value.key} = ${value.latex}`);
      line.append(formula, node('span', 'muted', [value.decimal, v?.unit].filter(Boolean).join(' ')));
      const copy = node('button', 'btn btn-ghost btn-sm', 'Copy'); copy.setAttribute('aria-label', `Copy ${value.key} value`);
      copy.addEventListener('click', () => action(async () => { await copyText(value.decimal); notify(`Copied ${value.key}.`); }));
      line.append(copy); container.append(line);
    }
  }
}
async function solve(system) {
  if (state.busy) return;
  const prefix = system ? 'system' : 'single', resultBox = $(`#${prefix}-result`);
  let vars = [];
  try {
    const eq = byId(state.selected);
    if (!system && !eq) throw new Error('Choose an equation.');
    const data = system ? systemData() : { equations: [eq.formula], vars: eq.vars };
    vars = data.vars;
    if (system && data.equations.length < 2) throw new Error('Choose at least two equations.');
    const unknowns = system ? [...state.systemUnknowns] : [state.unknown];
    if (!unknowns.length || unknowns.some(v => !v)) throw new Error('Choose at least one unknown.');
    const values = system ? state.systemValues : state.values[eq.id];
    const guesses = Object.fromEntries([...$(`#${prefix}-guesses`).querySelectorAll('input')].map(input => [input.dataset.key, input.value]));
    state.busy = true; $('#solve-btn').disabled = true; $('#solve-system').disabled = true;
    $$('[data-cancel]').forEach(button => button.hidden = false);
    // Keep the equation and input snapshot stable while its result is being computed.
    $$('input, select, textarea, .library-item, .tab, [data-new], #edit, #duplicate, #clear-values, #add-slot, #import, #export').forEach(e => e.disabled = true);
    resultBox.textContent = 'Solving…';
    const selectedSlots = system ? state.slots.map((id, index) => ({ equation: byId(id), mapping: state.mappings[index] || {} })).filter(slot => slot.equation) : [{ equation: eq, mapping: {} }];
    const result = await api.solve({ equations: data.equations, metadata: metadata(data.vars), unknowns, values, guesses, numeric: $(`#${prefix}-numeric`).checked,
      history: { kind: system ? 'system' : 'equation', equations: selectedSlots.map(slot => slot.equation), mappings: selectedSlots.map(slot => slot.mapping) } });
    showResult(resultBox, result, data.vars);
    if (result.historyEntry) calculationHistory.add(result.historyEntry);
    if (result.historyError) notify(result.historyError, true);
  } catch (error) { showError(resultBox, error.message, vars); }
  finally {
    state.busy = false; $$('input, select, textarea, button').forEach(e => e.disabled = false);
    $('#add-slot').disabled = state.slots.length >= 8; $$('[data-cancel]').forEach(button => button.hidden = true);
  }
}
$('#solve-btn').addEventListener('click', () => solve(false));
$('#solve-system').addEventListener('click', () => solve(true));
$$('[data-cancel]').forEach(button => button.addEventListener('click', () => action(() => api.cancel())));
$('#import').addEventListener('click', () => action(async () => {
  $('#import').disabled = true;
  try { const library = await api.import(); if (library) { state.library = library.equations; renderLibrary(); renderSlots(); warmLatexCache(); notify('Library imported. Existing equations were kept.'); } }
  finally { $('#import').disabled = false; }
}));
$('#export').addEventListener('click', () => action(async () => { if (await api.export()) notify('Library exported.'); }));
$('#ai-import').addEventListener('click', () => {
  $('#copy-ai-prompt').textContent = 'Copy prompt';
  $('#ai-import-status').textContent = '';
  $('#ai-import-dialog').showModal();
});
$('#copy-ai-prompt').addEventListener('click', async () => {
  try {
    await copyText(AI_IMPORT_PROMPT);
    $('#copy-ai-prompt').textContent = 'Copied';
    $('#ai-import-status').textContent = 'Prompt copied. Paste it into your favorite model.';
  } catch {
    $('#ai-import-status').textContent = 'Could not copy the prompt. Please try again.';
  }
});
document.addEventListener('keydown', event => {
  if (!(event.metaKey || event.ctrlKey) || state.busy || $('dialog[open]')) return;
  if (event.key === 'n') { event.preventDefault(); openEditor(); }
  if (event.key === 'f') { event.preventDefault(); toggleSidebar(false); $('#search').focus(); }
  if (event.key === 'Enter') {
    event.preventDefault();
    if (!$('#panel-editor').hidden) $('#editor-form').requestSubmit();
    else solve(!$('#panel-system').hidden);
  }
});
action(async () => {
  if (!api) throw new Error('Open the Electron app to use the math engine and local library. This browser page is a visual preview.');
  state.library = (await api.load()).equations;
  renderLibrary(); renderSlots(); selectEquation(state.library[0]);
  let saved;
  try { saved = Worksheet.read(localStorage, state.library); } catch { /* Storage may be unavailable. */ }
  if (saved) {
    const system = saved.mode === 'system', prefix = system ? 'system' : 'single';
    $(`#${prefix}-numeric`).checked = saved.numeric;
    if (system) {
      state.slots = saved.slots; state.mappings = saved.mappings;
      state.systemUnknowns = new Set(saved.unknowns); state.systemValues = saved.values;
      renderSlots();
    } else {
      state.selected = saved.selected; state.unknown = saved.unknown;
      state.values[saved.selected] = saved.values;
      renderLibrary(); renderEquation();
    }
    for (const input of $(`#${prefix}-guesses`).querySelectorAll('input')) input.value = saved.guesses[input.dataset.key] || '';
    $(`#panel-${saved.mode} .numerical`).open = saved.numeric;
    if (system) $('#mapping').open = Object.values(saved.mappings).some(mapping => Object.keys(mapping).length);
    showTab(saved.mode);
  }
  worksheetReady = true;
  scheduleWorksheetSave();
  warmLatexCache();
});
