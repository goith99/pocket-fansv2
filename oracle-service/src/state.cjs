// Lightweight fixture-metadata persistence. Because finished fixtures drop off
// the forward snapshot, we remember every fixture we've seen (id -> participants
// + start) so we can still find/resolve a match after it finishes and vanishes.
const fs = require('fs');
const path = require('path');

const FILE = process.env.STATE_FILE || path.resolve(__dirname, '../state/fixtures.json');

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { fixtures: {} }; }
}
function save(s) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(s, null, 2));
}
// Merge the current snapshot into persisted state; returns the merged state.
function mergeSnapshot(fixtures) {
  const s = load();
  for (const f of fixtures) {
    s.fixtures[f.FixtureId] = {
      FixtureId: Number(f.FixtureId),
      Participant1Id: Number(f.Participant1Id),
      Participant2Id: Number(f.Participant2Id),
      Participant1: f.Participant1,
      Participant2: f.Participant2,
      Participant1IsHome: f.Participant1IsHome === true,
      StartTime: Number(f.StartTime),
    };
  }
  s.lastSeen = Date.now();
  save(s);
  return s;
}

module.exports = { load, save, mergeSnapshot, FILE };
