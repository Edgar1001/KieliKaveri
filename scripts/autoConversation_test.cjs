const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

function harness({ permissionTransition = false, conversationError, distinctReplies = false } = {}) {
  const hooks = [];
  let cursor = 0;
  let dirty = true;
  let tree;
  let playback;
  let background;
  let recordings = 0;
  let uploads = 0;
  let effects = [];
  const requests = [];
  const preparations = [];
  const alerts = [];
  const keyboardListeners = {};
  const timers = new Map();
  let timerId = 0;
  const recording = { durationMillis: 0, metering: -60, isRecording: false };
  const recorder = {
    uri: 'file:///speech.m4a', isRecording: false,
    getStatus: () => recording,
    prepareToRecordAsync: async (options) => { assert.equal(options.isMeteringEnabled, true); preparations.push(options); },
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
    Keyboard: { dismiss() {}, addListener: (event, callback) => { keyboardListeners[event] = callback; return { remove() {} }; } }, Alert: { alert: (...args) => alerts.push(args) },
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
    requestAnimationFrame() {},
    setTimeout(callback, delay) { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout(id) { timers.delete(id); }, setInterval: () => 0, clearInterval() {},
    require(name) {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' };
      if (name === 'react-native') return native;
      if (name === '@react-native-community/slider') return { default: 'Slider' };
      if (name === './autoSpeech') return detector;
      if (name === 'expo-constants') return { default: {} };
      if (name === 'expo-speech') return speech;
      if (name === 'expo-audio') return {
        AudioModule: { requestRecordingPermissionsAsync: async () => {
          if (permissionTransition) { background('background'); background('active'); }
          return { granted: true };
        } },
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
        requests.push(request);
        assert.equal(request.body.get('level'), 'B2');
        if (conversationError) return { ok: false, json: async () => ({ error: conversationError }) };
        if (distinctReplies) {
          const turn = uploads;
          return { ok: true, json: async () => ({ transcript: `Learner ${turn}`, reply: `Question ${turn}`, correctedText: `Learner ${turn}`, explanation: 'Correct', translation: `Question ${turn}` }) };
        }
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
    async setTimeoutSeconds(value) {
      const slider = find('Automatic reply timeout', tree);
      assert.equal(slider.props.minimumValue, 10);
      assert.equal(slider.props.maximumValue, 60);
      assert.equal(slider.props.step, 1);
      slider.props.onValueChange(value);
      await settle();
    },
    async expireRecording(delay) {
      const entry = [...timers.entries()].find(([, timer]) => timer.delay === delay);
      assert.ok(entry, `Expected a recording timeout of ${delay}ms`);
      timers.delete(entry[0]);
      recording.durationMillis = delay;
      entry[1].callback();
      await settle();
    },
    async press(label) { await find(label, tree).props.onPress(); await settle(); },
    async sample(durationMillis, metering) { Object.assign(recording, { durationMillis, metering }); dirty = true; await settle(); },
    async finishReply() { playback.onDone(); await settle(); },
    async background() { background('background'); await settle(); },
    async inactive() { background('inactive'); await settle(); },
    async write(text) { find('Written Finnish message', tree).props.onChangeText(text); await settle(); },
    visible(label) { return Boolean(find(label, tree)); },
    value(label) { return find(label, tree)?.props.value; },
    edges(label) { return find(label, tree)?.props.edges; },
    style(label) { return Object.assign({}, ...[find(label, tree)?.props.style].flat().filter(Boolean)); },
    async keyboardShown() { keyboardListeners.keyboardDidShow(); await settle(); },
    async keyboardHidden() { keyboardListeners.keyboardDidHide(); await settle(); },
    get requests() { return requests; },
    get preparations() { return preparations; },
    get alerts() { return alerts; },
    get recordings() { return recordings; }, get uploads() { return uploads; }, get recording() { return recorder.isRecording; },
  };
}

test('speech-recognition capture is restricted to Auto puhe', async () => {
  const app = harness();
  await app.settle();
  await app.press('Start recording');
  assert.equal(app.preparations[0].android.audioSource, 'unprocessed');
  await app.press('Stop recording');
  assert.equal(app.requests[0].body.get('automatic'), null);
  await app.press('Automatic voice conversation');
  await app.press('Start automatic conversation');
  assert.equal(app.preparations[1].android.audioSource, 'voice_recognition');
  await app.press('Stop automatic conversation');
  await app.press('Voice conversation');
  await app.press('Start recording');
  assert.equal(app.preparations[2].android.audioSource, 'unprocessed');
  await app.press('Stop recording');
});

test('automatic timer and polling submissions include the latest history after slider changes', async () => {
  const app = harness({ distinctReplies: true });
  await app.settle();
  await app.press('Automatic voice conversation');
  await app.setTimeoutSeconds(10);
  await app.press('Start automatic conversation');
  const history = [];
  let recordingSeconds = 10;
  for (let turn = 1; turn <= 7; turn += 1) {
    await app.setTimeoutSeconds(turn % 2 === 0 ? 20 : 10);
    for (const duration of [100, 200, 300, 400]) await app.sample(duration, -20);
    if (turn % 2 === 0) await app.sample(recordingSeconds * 1000, -60);
    else await app.expireRecording(recordingSeconds * 1000);
    assert.equal(app.uploads, turn);
    assert.deepEqual(JSON.parse(app.requests[turn - 1].body.get('history')), history.slice(-4));
    history.push({ transcript: `Learner ${turn}`, reply: `Question ${turn}` });
    await app.finishReply();
    recordingSeconds = turn % 2 === 0 ? 20 : 10;
    assert.equal(app.recording, true);
  }
  await app.press('Stop automatic conversation');
});

test('written keyboard reduces footer padding and restores the bottom safe area on dismissal', async () => {
  const app = harness();
  await app.settle();
  await app.press('Written conversation');
  assert.deepEqual(Array.from(app.edges('Conversation controls')), ['bottom']);
  assert.equal(app.style('Conversation controls').paddingBottom, 18);
  await app.keyboardShown();
  assert.deepEqual(Array.from(app.edges('Conversation controls')), []);
  assert.equal(app.style('Conversation controls').paddingBottom, 6);
  await app.keyboardHidden();
  assert.deepEqual(Array.from(app.edges('Conversation controls')), ['bottom']);
  assert.equal(app.style('Conversation controls').paddingBottom, 18);
});

test('automatic voice reuses Puhe API and waits for playback before listening again', async () => {
  const app = harness();
  await app.settle();
  await app.press('Automatic voice conversation');
  await app.press('Start automatic conversation');
  assert.equal(app.recording, true);
  for (const duration of [100, 200, 300, 400]) await app.sample(duration, -20);
  await app.sample(2000, -60);
  assert.equal(app.uploads, 0);
  await app.sample(60_000, -60);
  assert.equal(app.uploads, 1);
  assert.equal(app.requests[0].body.get('automatic'), 'true');
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
  await app.sample(60_000, -60);
  await app.press('Stop automatic conversation');
  await app.finishReply();
  assert.equal(app.recordings, 1);
  assert.equal(app.recording, false);
});

test('permission transitions and initially missing metering do not cancel automatic startup', async () => {
  const app = harness({ permissionTransition: true });
  await app.settle();
  await app.press('Automatic voice conversation');
  await app.press('Start automatic conversation');
  await app.sample(100, undefined);
  await app.inactive();
  assert.equal(app.recording, true);
  assert.equal(app.visible('Stop automatic conversation'), true);
  await app.sample(300, -60);
  assert.equal(app.recording, true);
  await app.background();
  assert.equal(app.recording, false);
});

test('text and automatic histories remain independent and restart clears only the current mode', async () => {
  const app = harness();
  await app.settle();
  await app.press('Written conversation');
  await app.write('Text conversation');
  await app.press('Send written message');
  await app.press('Automatic voice conversation');
  await app.press('Start automatic conversation');
  for (const duration of [100, 200, 300, 400]) await app.sample(duration, -20);
  await app.sample(60_000, -60);
  assert.equal(app.requests[1].body.get('history'), '[]');
  await app.press('Stop automatic conversation');
  await app.press('Start a new conversation');
  await app.press('Written conversation');
  await app.write('Continue text');
  await app.press('Send written message');
  assert.equal(JSON.parse(app.requests[2].body.get('history')).length, 1);
  await app.press('Voice conversation');
  await app.press('Start recording');
  await app.press('Stop recording');
  assert.equal(app.requests[3].body.get('history'), '[]');
});

test('written keyboard reclaims space from secondary panels and restores them on dismissal', async () => {
  const app = harness();
  await app.settle();
  await app.press('Written conversation');
  assert.equal(app.visible('OpenAI spending'), true);
  await app.keyboardShown();
  assert.equal(app.visible('OpenAI spending'), false);
  assert.equal(app.visible('Written Finnish message'), true);
  await app.keyboardHidden();
  assert.equal(app.visible('OpenAI spending'), true);
});

test('idle windows recycle without uploads and quiet speech afterward gets a reply', async () => {
  const app = harness();
  await app.settle();
  await app.press('Automatic voice conversation');
  await app.press('Start automatic conversation');
  for (let window = 0; window < 2; window += 1) {
    await app.sample(100, -72);
    await app.sample(60_000, -72);
    assert.equal(app.recording, true);
    assert.equal(app.visible('Stop automatic conversation'), true);
    assert.equal(app.uploads, 0);
  }
  assert.equal(app.recordings, 3);
  for (const duration of [100, 200, 300, 400, 500, 600]) await app.sample(duration, -72);
  for (const duration of [700, 800, 900, 1000, 1100]) await app.sample(duration, -49);
  await app.sample(60_000, -72);
  assert.equal(app.uploads, 1);
  assert.equal(app.recording, false);
  await app.finishReply();
  assert.equal(app.recording, true);
  await app.press('Stop automatic conversation');
  assert.equal(app.recording, false);
});

test('slider controls the automatic timer and empty recording restart', async () => {
  const app = harness();
  await app.settle();
  await app.press('Automatic voice conversation');
  await app.setTimeoutSeconds(10);
  await app.press('Start automatic conversation');
  await app.expireRecording(10_000);
  assert.equal(app.uploads, 0);
  assert.equal(app.recording, true);
  for (const duration of [100, 200, 300, 400]) await app.sample(duration, -20);
  await app.expireRecording(10_000);
  assert.equal(app.uploads, 1);
  assert.equal(app.recording, false);
  await app.finishReply();
  assert.equal(app.recording, true);
  await app.press('Stop automatic conversation');
});

test('timeout slider only occupies layout in automatic mode and retains its selection', async () => {
  const app = harness();
  await app.settle();
  assert.equal(app.visible('Automatic reply timeout'), false);
  assert.equal(app.visible('Start recording'), true);
  await app.press('Automatic voice conversation');
  await app.setTimeoutSeconds(25);
  for (const mode of ['Voice conversation', 'Written conversation', 'Realtime voice conversation']) {
    await app.press(mode);
    assert.equal(app.visible('Automatic reply timeout'), false);
  }
  await app.press('Automatic voice conversation');
  assert.equal(app.visible('Automatic reply timeout'), true);
  assert.equal(app.value('Automatic reply timeout'), 25);
});

test('bottom controls fill the bottom safe area in recorded and written modes', async () => {
  const app = harness();
  await app.settle();
  for (const mode of ['Voice conversation', 'Written conversation', 'Automatic voice conversation']) {
    await app.press(mode);
    assert.deepEqual(Array.from(app.edges('Conversation controls')), ['bottom']);
  }
});

test('empty transcription at timeout silently resumes automatic listening', async () => {
  const app = harness({ conversationError: 'No Finnish speech was detected. Please try again.' });
  await app.settle();
  await app.press('Automatic voice conversation');
  await app.setTimeoutSeconds(10);
  await app.press('Start automatic conversation');
  for (const duration of [100, 200, 300, 400]) await app.sample(duration, -20);
  await app.sample(2000, -60);
  assert.equal(app.uploads, 0);
  await app.expireRecording(10_000);
  assert.equal(app.uploads, 1);
  assert.equal(app.alerts.length, 0);
  assert.equal(app.recording, true);
  assert.equal(app.visible('Stop automatic conversation'), true);
  await app.press('Stop automatic conversation');
  assert.equal(app.recording, false);
});

test('other server errors still stop automatic listening and show an alert', async () => {
  const app = harness({ conversationError: 'The tutor could not answer.' });
  await app.settle();
  await app.press('Automatic voice conversation');
  await app.setTimeoutSeconds(10);
  await app.press('Start automatic conversation');
  for (const duration of [100, 200, 300, 400]) await app.sample(duration, -20);
  await app.expireRecording(10_000);
  assert.equal(app.alerts.length, 1);
  assert.equal(app.recording, false);
});

test('Puhe still reports an empty transcription', async () => {
  const app = harness({ conversationError: 'No Finnish speech was detected. Please try again.' });
  await app.settle();
  await app.press('Start recording');
  await app.press('Stop recording');
  assert.equal(app.alerts.length, 1);
  assert.equal(app.recording, false);
});