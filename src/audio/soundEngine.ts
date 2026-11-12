import { RarityTier, WeatherType } from '../types/game';

class ProceduralSoundEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private ambientGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private isMuted = false;
  private isInitialized = false;
  private weather: WeatherType = 'clear';
  private isReelingCombat = false;

  private waveFilter: BiquadFilterNode | null = null;
  private rainGain: GainNode | null = null;
  private musicTimer: number | null = null;
  private harmonyTimer: number | null = null;
  private reelClickAccumulator = 0;

  // Healing D-Dorian / C-Major pentatonic frequencies
  private readonly calmScale = [
    261.63, // C4
    293.66, // D4
    329.63, // E4
    392.0,  // G4
    440.0,  // A4
    523.25, // C5
    587.33, // D5
    659.25, // E5
    783.99, // G5
  ];

  private readonly tensionScale = [
    293.66, // D4
    349.23, // F4
    392.0,  // G4
    440.0,  // A4
    523.25, // C5
    587.33, // D5
    698.46, // F5
  ];

  public init(): void {
    if (this.isInitialized) {
      if (this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
      return;
    }

    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    try {
      this.ctx = new AudioCtx();
    } catch {
      return;
    }

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = this.isMuted ? 0 : 0.68;
    this.masterGain.connect(this.ctx.destination);

    this.ambientGain = this.ctx.createGain();
    this.ambientGain.gain.value = 0.25;
    this.ambientGain.connect(this.masterGain);

    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.value = 0.22;
    this.musicGain.connect(this.masterGain);

    this.sfxGain = this.ctx.createGain();
    this.sfxGain.gain.value = 0.54;
    this.sfxGain.connect(this.masterGain);

    this.setupAmbientWaterAndRain();
    this.startGenerativeMusic();
    this.isInitialized = true;

    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  private setupAmbientWaterAndRain(): void {
    if (!this.ctx || !this.ambientGain) return;

    const bufferSize = this.ctx.sampleRate * 3;
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let b0 = 0,
      b1 = 0,
      b2 = 0,
      b3 = 0,
      b4 = 0,
      b5 = 0,
      b6 = 0;
    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.969 * b2 + white * 0.153852;
      b3 = 0.8665 * b3 + white * 0.3104856;
      b4 = 0.55 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.016898;
      data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.04;
      b6 = white * 0.115926;
    }

    const waterSrc = this.ctx.createBufferSource();
    waterSrc.buffer = buffer;
    waterSrc.loop = true;

    this.waveFilter = this.ctx.createBiquadFilter();
    this.waveFilter.type = 'lowpass';
    this.waveFilter.frequency.value = 420;
    this.waveFilter.Q.value = 1.2;

    const lfo = this.ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.18;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 210;
    lfo.connect(lfoGain);
    lfoGain.connect(this.waveFilter.frequency);

    const waterLevel = this.ctx.createGain();
    waterLevel.gain.value = 0.55;

    waterSrc.connect(this.waveFilter);
    this.waveFilter.connect(waterLevel);
    waterLevel.connect(this.ambientGain);

    waterSrc.start();
    lfo.start();

    const rainSrc = this.ctx.createBufferSource();
    rainSrc.buffer = buffer;
    rainSrc.loop = true;

    const rainFilter = this.ctx.createBiquadFilter();
    rainFilter.type = 'bandpass';
    rainFilter.frequency.value = 1900;
    rainFilter.Q.value = 0.7;

    this.rainGain = this.ctx.createGain();
    this.rainGain.gain.value =
      this.weather === 'rain' ? 0.45 : this.weather === 'mist' ? 0.1 : 0.0;

    rainSrc.connect(rainFilter);
    rainFilter.connect(this.rainGain);
    this.rainGain.connect(this.ambientGain);
    rainSrc.start();
  }

  private startGenerativeMusic(): void {
    const scheduleNextNote = () => {
      if (!this.isInitialized) return;
      if (this.ctx && this.musicGain && !this.isMuted && this.ctx.state === 'running') {
        const scale = this.isReelingCombat ? this.tensionScale : this.calmScale;
        const freq = scale[Math.floor(Math.random() * scale.length)];
        this.playPluckedHarmonic(
          freq,
          this.isReelingCombat ? 1.1 : 3.2,
          this.isReelingCombat ? 0.14 : 0.11,
        );

        if (!this.isReelingCombat && Math.random() < 0.35) {
          if (this.harmonyTimer) clearTimeout(this.harmonyTimer);
          this.harmonyTimer = window.setTimeout(() => {
            this.playPluckedHarmonic(freq * 1.5, 2.8, 0.06);
          }, 280);
        }
      }
      const nextDelay = this.isReelingCombat
        ? 380 + Math.random() * 260
        : 1650 + Math.random() * 1900;
      this.musicTimer = window.setTimeout(scheduleNextNote, nextDelay);
    };
    this.musicTimer = window.setTimeout(scheduleNextNote, 900);
  }

  private playPluckedHarmonic(freq: number, duration: number, peakGain: number): void {
    if (!this.ctx || !this.musicGain) return;
    const now = this.ctx.currentTime;

    const osc1 = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    osc1.type = 'sine';
    osc2.type = 'triangle';
    osc1.frequency.setValueAtTime(freq, now);
    osc2.frequency.setValueAtTime(freq * 2, now);

    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, now);
    env.gain.linearRampToValueAtTime(peakGain, now + 0.04);
    env.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    const harmonicEnv = this.ctx.createGain();
    harmonicEnv.gain.setValueAtTime(0.22, now);
    harmonicEnv.gain.exponentialRampToValueAtTime(0.01, now + duration * 0.45);

    osc1.connect(env);
    osc2.connect(harmonicEnv);
    harmonicEnv.connect(env);
    env.connect(this.musicGain);

    osc1.onended = () => {
      osc1.disconnect();
      osc2.disconnect();
      harmonicEnv.disconnect();
      env.disconnect();
    };

    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + duration + 0.05);
    osc2.stop(now + duration + 0.05);
  }

  public setMuted(muted: boolean): void {
    this.isMuted = muted;
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(muted ? 0 : 0.68, this.ctx.currentTime, 0.08);
    }
  }

  public getMuted(): boolean {
    return this.isMuted;
  }

  public setWeather(weather: WeatherType): void {
    this.weather = weather;
    if (this.rainGain && this.ctx) {
      const target = weather === 'rain' ? 0.48 : weather === 'mist' ? 0.1 : 0.0;
      this.rainGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.6);
    }
  }

  public setCombatMode(inCombat: boolean): void {
    this.isReelingCombat = inCombat;
  }

  public playCastWhoosh(powerRatio: number): void {
    this.init();
    if (!this.ctx || !this.sfxGain || this.isMuted) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(180, now);
    osc.frequency.exponentialRampToValueAtTime(520 + powerRatio * 280, now + 0.14);
    osc.frequency.exponentialRampToValueAtTime(140, now + 0.32);

    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.001, now);
    env.gain.linearRampToValueAtTime(0.28, now + 0.08);
    env.gain.exponentialRampToValueAtTime(0.001, now + 0.34);

    osc.connect(env);
    env.connect(this.sfxGain);
    osc.onended = () => {
      osc.disconnect();
      env.disconnect();
    };
    osc.start(now);
    osc.stop(now + 0.36);
  }

  public playSplash(intensity = 1.0): void {
    this.init();
    if (!this.ctx || !this.sfxGain || this.isMuted) return;
    const now = this.ctx.currentTime;

    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(240 * intensity, now);
    osc.frequency.exponentialRampToValueAtTime(480 * intensity, now + 0.09);
    osc.frequency.exponentialRampToValueAtTime(160, now + 0.22);

    const plopGain = this.ctx.createGain();
    plopGain.gain.setValueAtTime(0.32 * Math.min(intensity, 1.4), now);
    plopGain.gain.exponentialRampToValueAtTime(0.001, now + 0.24);
    osc.connect(plopGain);
    plopGain.connect(this.sfxGain);
    osc.onended = () => {
      osc.disconnect();
      plopGain.disconnect();
    };
    osc.start(now);
    osc.stop(now + 0.26);

    const len = Math.floor(this.ctx.sampleRate * 0.28);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      ch[i] = (Math.random() * 2 - 1) * Math.exp(-i / (len * 0.35));
    }
    const noise = this.ctx.createBufferSource();
    noise.buffer = buf;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(950, now);
    filter.Q.value = 1.1;

    const sprayGain = this.ctx.createGain();
    sprayGain.gain.value = 0.28 * intensity;
    noise.connect(filter);
    filter.connect(sprayGain);
    sprayGain.connect(this.sfxGain);
    noise.onended = () => {
      noise.disconnect();
      filter.disconnect();
      sprayGain.disconnect();
    };
    noise.start(now);
  }

  public playNibble(): void {
    if (!this.ctx || !this.sfxGain || this.isMuted) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(520, now);
    osc.frequency.exponentialRampToValueAtTime(680, now + 0.07);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.12, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
    osc.connect(gain);
    gain.connect(this.sfxGain);
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
    osc.start(now);
    osc.stop(now + 0.1);
  }

  public playBiteAlert(): void {
    this.init();
    if (!this.ctx || !this.sfxGain || this.isMuted) return;
    this.playSplash(1.25);
    const now = this.ctx.currentTime;
    [587.33, 880.0].forEach((freq, idx) => {
      if (!this.ctx || !this.sfxGain) return;
      const osc = this.ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, now + idx * 0.08);
      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.001, now + idx * 0.08);
      gain.gain.linearRampToValueAtTime(0.32, now + idx * 0.08 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.08 + 0.22);
      osc.connect(gain);
      gain.connect(this.sfxGain);
      osc.onended = () => {
        osc.disconnect();
        gain.disconnect();
      };
      osc.start(now + idx * 0.08);
      osc.stop(now + idx * 0.08 + 0.25);
    });
  }

  public tickReelRatchet(delta: number, isPulling: boolean, tension: number): void {
    if (!this.ctx || !this.sfxGain || this.isMuted) return;
    if (!isPulling && tension < 75) return;
    const rate = isPulling ? 14 + (tension / 100) * 14 : 9;
    this.reelClickAccumulator += delta * rate;
    if (this.reelClickAccumulator >= 1) {
      this.reelClickAccumulator = 0;
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      osc.type = 'triangle';
      const baseFreq = isPulling ? 900 + tension * 6 : 620;
      osc.frequency.setValueAtTime(baseFreq, now);
      osc.frequency.exponentialRampToValueAtTime(baseFreq * 0.6, now + 0.022);
      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(isPulling ? 0.09 : 0.05, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.025);
      osc.connect(gain);
      gain.connect(this.sfxGain);
      osc.onended = () => {
        osc.disconnect();
        gain.disconnect();
      };
      osc.start(now);
      osc.stop(now + 0.03);
    }
  }

  public playCatchFanfare(rarity: RarityTier): void {
    this.init();
    if (!this.ctx || !this.sfxGain || this.isMuted) return;
    const now = this.ctx.currentTime;
    const notes =
      rarity === 'UR' || rarity === 'SSR'
        ? [523.25, 659.25, 783.99, 1046.5, 1318.5]
        : rarity === 'SR'
          ? [523.25, 659.25, 783.99, 1046.5]
          : [440, 554.37, 659.25];

    notes.forEach((freq, i) => {
      if (!this.ctx || !this.sfxGain) return;
      const start = now + i * 0.09;
      const osc = this.ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, start);
      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.001, start);
      gain.gain.linearRampToValueAtTime(0.24, start + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.75);
      osc.connect(gain);
      gain.connect(this.sfxGain);
      osc.onended = () => {
        osc.disconnect();
        gain.disconnect();
      };
      osc.start(start);
      osc.stop(start + 0.8);
    });
  }

  public playEscapeOrSnap(): void {
    if (!this.ctx || !this.sfxGain || this.isMuted) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(340, now);
    osc.frequency.exponentialRampToValueAtTime(95, now + 0.28);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.22, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
    osc.connect(gain);
    gain.connect(this.sfxGain);
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
    osc.start(now);
    osc.stop(now + 0.32);
  }

  public playUiChime(): void {
    this.init();
    if (!this.ctx || !this.sfxGain || this.isMuted) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(660, now);
    osc.frequency.exponentialRampToValueAtTime(880, now + 0.08);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.11, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
    osc.connect(gain);
    gain.connect(this.sfxGain);
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
    osc.start(now);
    osc.stop(now + 0.12);
  }

  public dispose(): void {
    if (this.musicTimer) {
      clearTimeout(this.musicTimer);
      this.musicTimer = null;
    }
    if (this.harmonyTimer) {
      clearTimeout(this.harmonyTimer);
      this.harmonyTimer = null;
    }
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
    this.isInitialized = false;
  }
}

export const soundEngine = new ProceduralSoundEngine();
