// Trusted, optional host integration. Agent reports never supply this metadata.
const path = require('node:path');
const { readJson, writeJson } = require('./safe-json');
const { isValidId, cleanText } = require('./security');
const KEEP = 30 * 86400e3;
const EVENT_TYPES = new Set(['monitor','model','run','monitoring','guard','memory']);
function normalizeMonitoring(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  if (typeof value.enabled === 'boolean') result.enabled = value.enabled;
  if (Number.isFinite(value.guardBytes) && value.guardBytes > 0 && value.guardBytes <= 2**50) result.guardBytes = value.guardBytes;
  if (typeof value.model === 'string') result.model = cleanText(value.model, 120);
  if (Number.isInteger(value.contextTokens) && value.contextTokens > 0 && value.contextTokens <= 1e8) result.contextTokens = value.contextTokens;
  if (typeof value.runId === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(value.runId)) result.runId = value.runId;
  if (['armed', 'tripped', 'unknown'].includes(value.guardState)) result.guardState = value.guardState;
  return Object.keys(result).length ? result : null;
}
class MonitoringStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'monitoring-events.json');
    const input = readJson(this.file, {});
    const saved = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    this.events = (Array.isArray(saved.events) ? saved.events : []).filter(e => isValidId(e?.id) && Number.isFinite(e.t) && e.t >= Date.now() - KEEP && e.t <= Date.now() && EVENT_TYPES.has(e.type) && typeof e.title === 'string').slice(-5000).map(e => ({id:e.id,t:e.t,type:cleanText(e.type,40),title:cleanText(e.title,240)}));
    this.snapshots = Object.create(null);
    for (const [id, value] of Object.entries(saved.snapshots || {})) if (isValidId(id)) this.snapshots[id] = normalizeMonitoring(value);
    this.started = new Set();
    this.timer = null;
  }
  saveSoon() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.save(); }, 1000);
  }
  save() { writeJson(this.file, {events:this.events,snapshots:this.snapshots}); }
  add(id, type, title, t = Date.now()) {
    if (!isValidId(id) || !EVENT_TYPES.has(type) || !Number.isFinite(t) || t > Date.now() || t < Date.now() - KEEP) return;
    this.events.push({id,t,type:cleanText(type,40),title:cleanText(title,240)});
    this.events = this.events.filter(e => e.t >= Date.now() - KEEP).slice(-5000);
    this.saveSoon();
  }
  observe(id, current) {
    if (!current) return;
    const previous = this.snapshots[id];
    if (!this.started.has(id)) { this.started.add(id); this.add(id, 'monitor', 'Monitoring hub started'); }
    if (!previous || previous.model !== current.model || previous.contextTokens !== current.contextTokens) {
      if (current.model) this.add(id, 'model', 'Model: ' + current.model + (current.contextTokens ? ' · Context ' + current.contextTokens.toLocaleString('en-AU') + ' tokens' : ''));
    }
    if (previous?.runId && current.runId && previous.runId !== current.runId) this.add(id, 'run', 'Serving run changed');
    if (previous && previous.enabled !== current.enabled && typeof current.enabled === 'boolean') this.add(id, 'monitoring', current.enabled ? 'Monitoring enabled' : 'Monitoring disabled');
    if (previous?.guardState !== current.guardState && current.guardState && current.guardState !== 'unknown') this.add(id, 'guard', current.guardState === 'tripped' ? 'Host memory guard tripped' : 'Host memory guard armed');
    if (JSON.stringify(previous) !== JSON.stringify(current)) { this.snapshots[id] = current; this.saveSoon(); }
  }
  query(id, from, to) { return this.events.filter(e => e.id === id && e.t >= from && e.t <= to).map(({id, ...e}) => e); }
  remove(id) { delete this.snapshots[id]; this.events = this.events.filter(e => e.id !== id); this.saveSoon(); }
  close() { clearTimeout(this.timer); this.timer = null; this.save(); }
}
module.exports = { normalizeMonitoring, MonitoringStore };
