// Audio for the streamer: game (system) audio + mic mixed into one stereo
// track per spectateur, so each one can have its own game/voice balance.
export class Mixer {
  constructor() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx({ latencyHint: 'interactive', sampleRate: 48000 });
    this.gameBus = this.ctx.createGain();
    this.voiceBus = this.ctx.createGain();
    this.gameSource = null;
    this.micSource = null;
    this.outputs = new Map();
  }

  resume() {
    if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
  }

  setGameTrack(track) {
    this.gameSource?.disconnect();
    this.gameSource = track ? this.ctx.createMediaStreamSource(new MediaStream([track])) : null;
    this.gameSource?.connect(this.gameBus);
  }

  setMicTrack(track) {
    this.micSource?.disconnect();
    this.micSource = track ? this.ctx.createMediaStreamSource(new MediaStream([track])) : null;
    this.micSource?.connect(this.voiceBus);
  }

  setGameVolume(v) {
    this.gameBus.gain.setTargetAtTime(v, this.ctx.currentTime, 0.03);
  }

  setVoiceVolume(v) {
    this.voiceBus.gain.setTargetAtTime(v, this.ctx.currentTime, 0.03);
  }

  createOutput(id) {
    const game = this.ctx.createGain();
    const voice = this.ctx.createGain();
    const dest = this.ctx.createMediaStreamDestination();
    dest.channelCount = 2;
    this.gameBus.connect(game).connect(dest);
    this.voiceBus.connect(voice).connect(dest);
    const output = {
      track: dest.stream.getAudioTracks()[0],
      setGains: (g, v) => {
        game.gain.setTargetAtTime(g, this.ctx.currentTime, 0.05);
        voice.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
      },
      destroy: () => {
        try {
          this.gameBus.disconnect(game);
          this.voiceBus.disconnect(voice);
        } catch {}
        game.disconnect();
        voice.disconnect();
        output.track.stop();
        this.outputs.delete(id);
      },
    };
    this.outputs.set(id, output);
    return output;
  }

  meter(track) {
    return createMeter(this.ctx, track);
  }

  close() {
    for (const o of this.outputs.values()) o.destroy();
    this.ctx.close().catch(() => {});
  }
}

// Returns a function giving the current level (0..1) of a track.
export function createMeter(ctx, track) {
  const source = ctx.createMediaStreamSource(new MediaStream([track]));
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.4;
  source.connect(analyser);
  const data = new Float32Array(analyser.fftSize);
  const level = () => {
    analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / data.length);
    return Math.min(1, Math.max(0, (20 * Math.log10(rms + 1e-8) + 60) / 50));
  };
  level.stop = () => source.disconnect();
  return level;
}

// Small synthesized UI sounds (no audio files).
let sfxCtx = null;
export function chime(kind = 'join') {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    sfxCtx = sfxCtx || new Ctx();
    if (sfxCtx.state !== 'running') sfxCtx.resume();
    const notes = { join: [660, 880], message: [880], leave: [660, 440], alert: [520, 520] }[kind] || [880];
    const t0 = sfxCtx.currentTime + 0.01;
    notes.forEach((freq, i) => {
      const osc = sfxCtx.createOscillator();
      const gain = sfxCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t = t0 + i * 0.11;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.08, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      osc.connect(gain).connect(sfxCtx.destination);
      osc.start(t);
      osc.stop(t + 0.4);
    });
  } catch {}
}
