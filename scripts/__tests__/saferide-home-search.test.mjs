import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = ts.createSourceFile(
  'Home.tsx',
  readFileSync(new URL('../../src/screens/Home.tsx', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
let callback;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'handleSearch') {
    assert.ok(ts.isCallExpression(node.initializer));
    assert.equal(node.initializer.expression.getText(source), 'useCallback');
    callback = node.initializer;
  }
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(callback, 'run the actual Home search callback, not a duplicate implementation');

function search(query) {
  const result = { routes: [], reports: 0, messages: [] };
  const context = {
    searchQuery: query,
    navigation: { navigate: route => result.routes.push(route) },
    handleContinueDraft: () => { result.reports++; },
    toast: { show: message => result.messages.push(message.title) },
  };
  vm.runInNewContext(`(${callback.arguments[0].getText(source)})()`, context);
  return result;
}

test('report searches reuse the current primary report/draft action', () => {
  for (const query of ['report', 'reports', 'file report', '  REPORT  ']) {
    assert.deepEqual(search(query), { routes: [], reports: 1, messages: [] }, query);
  }
  const dependencies = callback.arguments[1].elements.map(node => node.getText(source));
  assert.ok(dependencies.includes('handleContinueDraft'), 'keep the resume action current when draft state changes');
});

test('existing destinations keep their precedence for mixed report searches', () => {
  for (const [query, route] of [
    ['case report', 'Cases'], ['draft report', 'Cases'],
    ['support report', 'Support'], ['help report', 'Support'], ['chat report', 'Support'],
    ['tips report', 'TipsRights'], ['rights report', 'TipsRights'],
    ['learn report', 'Learn'], ['video report', 'Learn'],
  ]) {
    assert.deepEqual(search(query), { routes: [route], reports: 0, messages: [] }, query);
  }
});

test('empty and unmatched searches retain feedback without navigation', () => {
  assert.deepEqual(search('  '), { routes: [], reports: 0, messages: ['Search SafeRide'] });
  assert.deepEqual(search('unmatched'), { routes: [], reports: 0, messages: ['No quick match'] });
});
