// Transposer — simple MusicXML playback.
//
// Parses a (transposed) MusicXML DOM into note events and plays them with a
// small WebAudio synth so you can hear the piece in the new key. Repeats,
// dynamics and articulations are ignored — this is an audition aid, not a
// sequencer.

(function () {
  const LETTER_SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const MAX_EVENTS = 6000;

  // → { events: [{start, dur, midi}] in quarter notes, tempo: quarter BPM }
  function collectEvents(doc) {
    const events = [];
    let tempo = 0;
    for (const part of doc.querySelectorAll('part')) {
      let divisions = 1;
      let pos = 0;
      let lastStart = 0;
      for (const measure of part.querySelectorAll(':scope > measure')) {
        for (const el of measure.children) {
          switch (el.tagName) {
            case 'attributes': {
              const d = el.querySelector('divisions');
              if (d) divisions = parseInt(d.textContent, 10) || 1;
              break;
            }
            case 'direction':
            case 'sound': {
              const sound = el.tagName === 'sound' ? el : el.querySelector('sound');
              const t = sound && parseFloat(sound.getAttribute('tempo'));
              if (t && !tempo) tempo = t;
              break;
            }
            case 'backup':
            case 'forward': {
              const d = el.querySelector('duration');
              const q = d ? (parseInt(d.textContent, 10) || 0) / divisions : 0;
              pos += el.tagName === 'backup' ? -q : q;
              break;
            }
            case 'note': {
              if (el.querySelector('grace')) break;
              const d = el.querySelector('duration');
              const q = d ? (parseInt(d.textContent, 10) || 0) / divisions : 0;
              const isChord = !!el.querySelector('chord');
              const start = isChord ? lastStart : pos;
              if (!isChord) {
                lastStart = pos;
                pos += q;
              }
              const pitchEl = el.querySelector('pitch');
              if (!pitchEl || q <= 0) break;
              const step = pitchEl.querySelector('step').textContent.trim();
              const alterEl = pitchEl.querySelector('alter');
              const alter = alterEl ? parseInt(alterEl.textContent, 10) || 0 : 0;
              const octave = parseInt(pitchEl.querySelector('octave').textContent, 10);
              const midi = (octave + 1) * 12 + LETTER_SEMITONES[step] + alter;
              if (el.querySelector('tie[type="stop"]')) {
                const prev = events.find(
                  (e) => e.midi === midi && Math.abs(e.start + e.dur - start) < 1e-6,
                );
                if (prev) {
                  prev.dur += q;
                  break;
                }
              }
              events.push({ start, dur: q, midi });
              if (events.length >= MAX_EVENTS) return { events, tempo: tempo || 100 };
              break;
            }
          }
        }
      }
    }
    return { events, tempo: tempo || 100 };
  }

  // Play events; returns a handle with stop(). onDone fires at natural end.
  function play(doc, { onDone } = {}) {
    const { events, tempo } = collectEvents(doc);
    if (!events.length) {
      if (onDone) onDone();
      return { stop() {} };
    }
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const master = ctx.createGain();
    master.gain.value = 0.5;
    const comp = ctx.createDynamicsCompressor();
    master.connect(comp).connect(ctx.destination);

    const secPerQuarter = 60 / tempo;
    const t0 = ctx.currentTime + 0.15;
    let end = 0;
    for (const ev of events) {
      const at = t0 + ev.start * secPerQuarter;
      const dur = Math.max(0.08, ev.dur * secPerQuarter - 0.04);
      const freq = 440 * Math.pow(2, (ev.midi - 69) / 12);
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.22, at + 0.012);
      gain.gain.setTargetAtTime(0.13, at + 0.03, 0.25);
      gain.gain.setTargetAtTime(0, at + dur, 0.03);
      osc.connect(gain).connect(master);
      osc.start(at);
      osc.stop(at + dur + 0.25);
      end = Math.max(end, ev.start * secPerQuarter + dur);
    }
    let stopped = false;
    const timer = setTimeout(() => {
      if (!stopped) {
        stopped = true;
        ctx.close();
        if (onDone) onDone();
      }
    }, (end + 0.8) * 1000);
    return {
      stop() {
        if (stopped) return;
        stopped = true;
        clearTimeout(timer);
        ctx.close();
      },
    };
  }

  const api = { collectEvents, play };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.Player = api;
})();
