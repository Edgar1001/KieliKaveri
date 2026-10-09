const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const exported = {};
vm.runInNewContext(ts.transpileModule(readFileSync(require.resolve('../autoSpeech.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: exported });

test('pauses do not send speech before the selected timeout', () => {
  const detector = new exported.AutoSpeechDetector();
  for (let duration = 100; duration <= 500; duration += 100) assert.equal(detector.sample(duration, -20), 'wait');
  assert.equal(detector.sample(1000, -60), 'wait');
  assert.equal(detector.sample(2100, -60), 'wait');
  assert.equal(detector.sample(59_900, -60), 'wait');
  assert.equal(detector.sample(60_000, -60), 'send');
});
test('never uploads silence or a short noise spike', () => {
  const detector = new exported.AutoSpeechDetector();
  detector.sample(100, -15);
  assert.equal(detector.sample(3000, -60), 'wait');
  assert.equal(detector.sample(60_000, -60), 'discard');
});
test('continuing speech resets the silence interval', () => {
  const detector = new exported.AutoSpeechDetector();
  for (let duration = 100; duration <= 500; duration += 100) detector.sample(duration, -20);
  detector.sample(1900, -20);
  assert.equal(detector.sample(2200, -60), 'wait');
  assert.equal(detector.sample(3500, -60), 'wait');
  assert.equal(detector.sample(60_000, -60), 'send');
});
test('caps long utterances and rejects unsupported metering', () => {
  const detector = new exported.AutoSpeechDetector();
  for (let duration = 100; duration <= 500; duration += 100) detector.sample(duration, -20);
  assert.equal(detector.sample(60_000, -20), 'send');
  assert.equal(detector.sample(100), 'wait');
  assert.equal(detector.sample(2100), 'wait');
  assert.equal(detector.sample(59_900), 'wait');
  assert.throws(() => detector.sample(60_000), /level detection/);
});

test('quiet microphone speech below the old fixed threshold triggers a reply', () => {
  const detector = new exported.AutoSpeechDetector();
  for (let duration = 100; duration <= 600; duration += 100) detector.sample(duration, -72);
  for (let duration = 700; duration <= 1500; duration += 100) detector.sample(duration, -49);
  assert.equal(detector.sample(3100, -72), 'wait');
  assert.equal(detector.sample(60_000, -72), 'send');
});

test('background noise alone is not speech and quiet syllable gaps are tolerated', () => {
  const detector = new exported.AutoSpeechDetector();
  for (let duration = 100; duration <= 1000; duration += 100) detector.sample(duration, -48);
  assert.equal(detector.sample(3000, -48), 'wait');
  detector.sample(3100, -39);
  detector.sample(3200, -48);
  detector.sample(3300, -39);
  detector.sample(3400, -48);
  detector.sample(3500, -39);
  assert.equal(detector.sample(5100, -48), 'wait');
  assert.equal(detector.sample(60_000, -48), 'send');
});

test('selected timeout sends ongoing speech and discards empty windows', () => {
  const detector = new exported.AutoSpeechDetector(10_000);
  for (let duration = 100; duration < 10_000; duration += 100) {
    assert.equal(detector.sample(duration, -20), 'wait');
  }
  assert.equal(detector.sample(10_000, -20), 'send');
  const silent = new exported.AutoSpeechDetector(10_000);
  assert.equal(silent.sample(9900, -72), 'wait');
  assert.equal(silent.sample(10_000, -72), 'discard');
});