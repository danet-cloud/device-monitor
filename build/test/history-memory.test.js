'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { HistoryStore } = require('../../history');
const GiB = 2 ** 30;
const minute = Math.floor(Date.now() / 60000) * 60000 - 600000;
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-history-memory-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, store: new HistoryStore(dir) };
}
function point(store, t, available, headroom) {
  store.add('edge-test', { t, mem: 90, memAvailable: available, guardHeadroom: headroom });
}
function read(store) { return fs.readFileSync(store.file('edge-test'), 'utf8').trim().split('\n').map(JSON.parse); }

test('persisted minute keeps memory minima, averages and exact report counts after reload', t => {
  const { dir, store } = fixture(t);
  point(store, minute + 1000, 11 * GiB, 3 * GiB);
  point(store, minute + 3000, 9 * GiB, GiB);
  point(store, minute + 5000, 10 * GiB, 2 * GiB);
  store.close();
  const saved = read(store)[0];
  assert.equal(saved.n, 3);
  assert.equal(saved.memAvailable, 10 * GiB);
  assert.equal(saved.memAvailableMin, 9 * GiB);
  assert.equal(saved.guardHeadroomMin, GiB);
  assert.equal(saved.memAvailableN, 3);
  assert.equal(saved.guardHeadroomN, 3);
  const loaded = new HistoryStore(dir);
  const result = loaded.query('edge-test', minute, minute + 60000).points[0];
  assert.equal(result.memAvailableMin, saved.memAvailableMin);
  assert.equal(result.guardHeadroomMin, saved.guardHeadroomMin);
  assert.equal(result.n, 3);
  loaded.close();
});

test('same-minute restart merges exact counts, weighted averages and lowest observed memory', t => {
  const { dir, store } = fixture(t);
  point(store, minute + 1000, 12 * GiB, 4 * GiB);
  point(store, minute + 3000, 10 * GiB, 2 * GiB);
  store.close();
  const restarted = new HistoryStore(dir);
  point(restarted, minute + 5000, 8 * GiB, 0);
  restarted.close();
  const saved = read(restarted)[0];
  assert.equal(saved.n, 3);
  assert.equal(saved.memAvailable, 10 * GiB);
  assert.equal(saved.memAvailableMin, 8 * GiB);
  assert.equal(saved.guardHeadroomMin, 0);
  assert.equal(saved.memAvailableN, 3);
  assert.equal(saved.guardHeadroomN, 3);
});

test('coarser queries preserve minima and sum reports rather than count minute rows', t => {
  const { dir, store } = fixture(t);
  point(store, minute + 1000, 12 * GiB, 4 * GiB);
  point(store, minute + 3000, 10 * GiB, 2 * GiB);
  point(store, minute + 61000, 6 * GiB, -2 * GiB);
  store.close();
  const loaded = new HistoryStore(dir);
  const result = loaded.query('edge-test', minute, minute + 120000, 1).points[0];
  assert.equal(result.n, 3);
  assert.equal(result.memAvailableMin, 6 * GiB);
  assert.equal(result.guardHeadroomMin, -2 * GiB);
  assert.equal(result.memAvailableN, 3);
  assert.equal(result.guardHeadroomN, 3);
  assert.equal(result.memAvailable, +((28 * GiB) / 3).toFixed(2));
  loaded.close();
});

test('partial memory metrics retain their own observation counts and valid zero/negative values', t => {
  const { store } = fixture(t);
  point(store, minute + 1000, 10 * GiB, 2 * GiB);
  point(store, minute + 3000, null, null);
  point(store, minute + 5000, 7 * GiB, -GiB);
  store.close();
  const saved = read(store)[0];
  assert.equal(saved.n, 3);
  assert.equal(saved.memAvailableN, 2);
  assert.equal(saved.guardHeadroomN, 2);
  assert.equal(saved.memAvailable, 8.5 * GiB);
  assert.equal(saved.guardHeadroomMin, -GiB);
});

test('legacy averages do not acquire invented memory minima or report counts', t => {
  const { dir, store } = fixture(t);
  fs.writeFileSync(store.file('edge-test'), JSON.stringify({ id: 'edge-test', t: minute, mem: 95 }) + '\n', { mode: 0o600 });
  const loaded = new HistoryStore(dir);
  const result = loaded.query('edge-test', minute, minute + 60000, 1).points[0];
  assert.equal(result.n, null);
  assert.equal(result.memAvailableMin, null);
  assert.equal(result.guardHeadroomMin, null);
  assert.equal(result.memAvailableN, 0);
  assert.equal(result.guardHeadroomN, 0);
  loaded.close();
});

test('mixed legacy/new buckets expose partial coverage and unknown total count', t => {
  const { dir, store } = fixture(t);
  fs.writeFileSync(store.file('edge-test'), JSON.stringify({ id: 'edge-test', t: minute, mem: 95 }) + '\n', { mode: 0o600 });
  const loaded = new HistoryStore(dir);
  point(loaded, minute + 61000, 9 * GiB, GiB);
  loaded.close();
  const reloaded = new HistoryStore(dir);
  const result = reloaded.query('edge-test', minute, minute + 120000, 1).points[0];
  assert.equal(result.n, null);
  assert.equal(result.memAvailableMin, 9 * GiB);
  assert.equal(result.memAvailableN, 1);
  assert.equal(result.guardHeadroomN, 1);
  reloaded.close();
});

test('legacy same-minute merge preserves only new memory coverage', t => {
  const { dir, store } = fixture(t);
  fs.writeFileSync(store.file('edge-test'), JSON.stringify({ id: 'edge-test', t: minute, mem: 95 }) + '\n', { mode: 0o600 });
  const loaded = new HistoryStore(dir);
  point(loaded, minute + 3000, 9 * GiB, GiB);
  loaded.close();
  const saved = read(loaded)[0];
  assert.equal(saved.n, null);
  assert.equal(saved.memAvailableMin, 9 * GiB);
  assert.equal(saved.memAvailableN, 1);
  assert.equal(saved.guardHeadroomN, 1);
});

test('raw history exposes one actual report per point without waiting for a minute flush', t => {
  const { store } = fixture(t);
  point(store, minute + 1000, 9 * GiB, GiB);
  const result = store.query('edge-test', minute, minute + 10000).points[0];
  assert.equal(result.n, 1);
  assert.equal(result.memAvailableN, 1);
  assert.equal(result.memAvailableMin, 9 * GiB);
  assert.equal(result.guardHeadroomMin, GiB);
  store.close();
});

test('queries show an unflushed same-minute restart dip without losing earlier reports', t => {
  const { dir, store } = fixture(t);
  point(store, minute + 1000, 12 * GiB, 4 * GiB);
  point(store, minute + 3000, 10 * GiB, 2 * GiB);
  store.close();
  const restarted = new HistoryStore(dir);
  point(restarted, minute + 5000, 6 * GiB, -2 * GiB);
  for (const count of [1, 1200]) {
    const result = restarted.query('edge-test', minute, minute + 60000, count).points;
    assert.equal(result.length, 1);
    assert.equal(result[0].n, 3);
    assert.equal(result[0].memAvailableMin, 6 * GiB);
    assert.equal(result[0].guardHeadroomMin, -2 * GiB);
  }
  point(restarted, minute + 61000, 9 * GiB, GiB);
  const fine = restarted.query('edge-test', minute, minute + 120000).points;
  assert.equal(fine.reduce((n, p) => n + p.n, 0), 4);
  assert.equal(fine[0].n, 3);
  assert.equal(fine[0].memAvailableMin, 6 * GiB);
  restarted.close();
});

test('historical fine query excludes saved minutes beyond its requested end', t => {
  const { dir, store } = fixture(t);
  point(store, minute + 1000, 12 * GiB, 4 * GiB);
  point(store, minute + 61000, 10 * GiB, 2 * GiB);
  store.close();
  const loaded = new HistoryStore(dir);
  const result = loaded.query('edge-test', minute, minute + 59000).points;
  assert.equal(result.length, 1);
  assert.equal(result[0].t, minute);
  loaded.close();
});
