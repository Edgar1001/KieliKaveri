const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

function harness() {
  const hooks = [];
  let cursor = 0;
  let dirty = true;
  let tree;
  let playback;
  let background;
  let recordings = 0;
  let uploads = 0;
  let effects = [];
  const recording = { durationMillis: 0, metering: -60, isRecording: false };
  const recorder = {
    uri: 'file:///speech.m4a', isRecording: false,
    getStatus: () => recording,
    prepareToRecordAsync: async () => {},
    record() { recordings += 1; recording.durationMillis = 0; recording.isRecording = true; this.isRecording = true; dirty = true; },
    async stop() { recording.isRecording = false; this.isRecording = false; dirty = true; },
  };
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = initial;
      return [hooks[index], (value) => {
        const next = typeof value === 'function' ? value(hooks[index]) : value;
        if (next !== hooks[index]) { hooks[index] = next; dirty = true; }
      }];
    },
    useRef(initial) {
      const index = cursor++;
      hooks[index] ??= { current: initial };
      return hooks[index];
    },
    useEffect(effect, dependencies) {
      const index = cursor++;
      const previous = hooks[index];
      if (!previous || dependencies.some((value, position) => value !== previous.dependencies[position])) {
        effects.push(() => { previous?.cleanup?.(); hooks[index] = { dependencies, cleanup: effect() }; });
      }
    },
  };
  const player = { pause() {}, addListener: () => ({ remove() {} }) };
  const native = new Proxy({
    Platform: { OS: 'android' }, StyleSheet: { create: (styles) => styles },
    Keyboard: { dismiss() {} }, Alert: { alert() {} },
    AppState: { addEventListener: (_name, callback) => { background = callback; return { remove() {} }; } },
  }, { get: (object, name) => object[name] ?? name });
  const jsx = (type, props) => ({ type, props });
  const speech = {
    VoiceQuality: { Enhanced: 'enhanced' },
    getAvailableVoicesAsync: async () => [{ language: 'fi-FI', quality: 'enhanced', identifier: 'finnish' }],
    stop: async () => {}, speak: (_text, options) => { playback = options; options.onStart(); },
  };
  const compile = (filename) => ts.transpileModule(readFileSync(require.resolve(filename), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const detector = {};
  vm.runInNewContext(compile('../autoSpeech.ts'), { exports: detector });
  const exported = {};
  vm.runInNewContext(compile('../App.tsx'), {
    exports: exported, console, process: { env: {} }, AbortController, FormData,
    requestAnimationFrame() {}, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    require(name) {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' };
      if (name === 'react-native') return native;
      if (name === './autoSpeech') return detector;
      if (name === 'expo-constants') return { default: {} };
      if (name === 'expo-speech') return speech;
      if (name === 'expo-audio') return {
        AudioModule: { requestRecordingPermissionsAsync: async () => ({ granted: true }) },
        RecordingPresets: { HIGH_QUALITY: { android: {} } }, setAudioModeAsync: async () => {},
        useAudioRecorder: () => recorder, useAudioPlayer: () => player, useAudioRecorderState: () => ({ ...recording }),
      };
      if (name === 'expo-file-system') return {
        File: class extends Blob { constructor() { super(['audio']); this.exists = true; } delete() { this.exists = false; } }, Paths: {},
      };
      if (name === 'expo/fetch') return { fetch: async (url, request) => {
        if (url.endsWith('/api/usage')) return { ok: false };
        assert.equal(url.endsWith('/api/conversation'), true);
        uploads += 1;
        assert.equal(request.body.get('level'), 'B2');
        return { ok: true, json: async () => ({ transcript: 'Moi', reply: 'Hei', correctedText: 'Moi', explanation: 'Correct', translation: 'Hi' }) };
      } };
      return new Proxy({}, { get: (_object, property) => property });
    },
  });
  async function settle() {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (dirty) {
        dirty = false; cursor = 0;
        tree = exported.default();
        const pending = effects; effects = []; pending.forEach((effect) => effect());
      }
      await Promise.resolve();
    }
  }
  function find(label, node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.map((child) => find(label, child)).find(Boolean);
    if (node.props?.accessibilityLabel === label) return node;
    return find(label, node.props?.children);
  }
  return {
    settle,
    async press(label) { await find(label, tree).props.onPress(); await settle(); },
    async sample(durationMillis, metering) { Object.assign(recording, { durationMillis, metering }); dirty = true; await settle(); },
    async finishReply() { playback.onDone(); await settle(); },
    async background() { background('background'); await settle(); },
    get recordings() { return recordings; }, get uploads() { return uploads; }, get recording() { return recorder.isRecording; },
  };
}

test('automatic voice reuses Puhe API and waits for playback before listening again', async () => {
  const app = harness();
  await app.settle();
  await app.press('Automatic voice conversation');
  await app.press('Start automatic conversation');
  assert.equal(app.recording, true);
  for (const duration of [100, 200, 300, 400]) await app.sample(duration, -20);
  await app.sample(2000, -60);
  assert.equal(app.uploads, 1);
  assert.equal(app.recording, false);
  assert.equal(app.recordings, 1);
  await app.finishReply();
  assert.equal(app.recordings, 2);
  assert.equal(app.recording, true);
  await app.background();
  assert.equal(app.recording, false);
});

test('stopping during a reply prevents delayed completion from restarting recording', async () => {
  const app = harness();
  await app.settle();
  await app.press('Automatic voice conversation');
  await app.press('Start automatic conversation');
  for (const duration of [100, 200, 300, 400]) await app.sample(duration, -20);
  await app.sample(2000, -60);
  await app.press('Stop automatic conversation');
  await app.finishReply();
  assert.equal(app.recordings, 1);
  assert.equal(app.recording, false);
});