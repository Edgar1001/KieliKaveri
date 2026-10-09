const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const exported = {};
vm.runInNewContext(ts.transpileModule(readFileSync(require.resolve('../autoSpeech.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: exported });

test('sends speech only after a sustained pause', () => {
  const detector = new exported.AutoSpeechDetector();
  for (let duration = 100; duration <= 500; duration += 100) assert.equal(detector.sample(duration, -20), 'wait');
  assert.equal(detector.sample(1000, -60), 'wait');
  assert.equal(detector.sample(2100, -60), 'send');
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
  assert.equal(detector.sample(3500, -60), 'send');
});
test('caps long utterances and rejects unsupported metering', () => {
  const detector = new exported.AutoSpeechDetector();
  for (let duration = 100; duration <= 500; duration += 100) detector.sample(duration, -20);
  assert.equal(detector.sample(60_000, -20), 'send');
  assert.throws(() => detector.sample(100), /level detection/);
});