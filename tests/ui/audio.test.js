import assert from "node:assert/strict";
import test from "node:test";

import { LocalSoundFeedback, showVictoryCelebration } from "../../src/ui/audio.js";

function fakeAudioContext() {
  const calls = [];
  return {
    calls,
    state: "suspended",
    currentTime: 10,
    destination: {},
    resume() { calls.push(["resume"]); this.state = "running"; },
    createOscillator() {
      return {
        type: "",
        frequency: { setValueAtTime: (...args) => calls.push(["frequency", ...args]) },
        connect: () => calls.push(["oscillator-connect"]),
        start: (...args) => calls.push(["start", ...args]),
        stop: (...args) => calls.push(["stop", ...args]),
      };
    },
    createGain() {
      return {
        gain: {
          setValueAtTime: (...args) => calls.push(["gain-set", ...args]),
          exponentialRampToValueAtTime: (...args) => calls.push(["gain-ramp", ...args]),
        },
        connect: () => calls.push(["gain-connect"]),
      };
    },
  };
}

test("local audio remains lazy and silent until the sound preference is enabled", () => {
  let factoryCalls = 0;
  const context = fakeAudioContext();
  const feedback = new LocalSoundFeedback({ contextFactory: () => { factoryCalls += 1; return context; } });
  assert.equal(feedback.play("move"), false);
  assert.equal(factoryCalls, 0);
  feedback.setPreferences({ sound: true });
  assert.equal(feedback.play("move"), true);
  assert.equal(factoryCalls, 1);
  assert.ok(context.calls.some(([name]) => name === "start"));
  feedback.setPreferences({ sound: false });
  assert.equal(feedback.play("win"), false);
  assert.equal(factoryCalls, 1);
});

test("unknown cues fail closed without creating an audio context", () => {
  let factoryCalls = 0;
  const feedback = new LocalSoundFeedback({ contextFactory: () => { factoryCalls += 1; return fakeAudioContext(); } });
  feedback.setPreferences({ sound: true });
  assert.equal(feedback.play("remote-file"), false);
  assert.equal(factoryCalls, 0);
});

test("victory celebration is omitted for reduced motion and removes itself after playback", () => {
  let appended = null;
  let removalTimer = null;
  const documentNode = {
    body: { append(node) { appended = node; } },
    querySelector() { return null; },
    createElement() {
      return {
        className: "",
        attributes: {},
        innerHTML: "",
        setAttribute(name, value) { this.attributes[name] = value; },
        remove() { this.removed = true; },
      };
    },
  };
  const reduced = showVictoryCelebration(documentNode, { animation: true }, { matchMedia: () => ({ matches: true }) });
  assert.equal(reduced, null);
  assert.equal(appended, null);

  const overlay = showVictoryCelebration(documentNode, { animation: true, reduceMotion: false }, {
    matchMedia: () => ({ matches: false }),
    setTimer(callback, delay) { removalTimer = { callback, delay }; },
  });
  assert.equal(appended, overlay);
  assert.equal(overlay.attributes["aria-hidden"], "true");
  assert.match(overlay.innerHTML, /--delay:/);
  assert.equal(removalTimer.delay, 2_400);
  removalTimer.callback();
  assert.equal(overlay.removed, true);
});

