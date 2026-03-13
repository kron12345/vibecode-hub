import { Injectable, OnDestroy, signal } from '@angular/core';
import { ChatSocketService } from './chat-socket.service';
import { Subscription } from 'rxjs';

export type VoiceState = 'IDLE' | 'LISTENING' | 'PROCESSING' | 'SPEAKING';

// ─── VAD Configuration ─────────────────────────────────────
/** RMS level below which audio counts as silence */
const SILENCE_THRESHOLD = 0.015;
/** Milliseconds of silence after speech before auto-stop */
const SILENCE_DURATION_MS = 1500;
/** Minimum speech duration before silence detection activates */
const MIN_SPEECH_MS = 500;

@Injectable({ providedIn: 'root' })
export class VoiceService implements OnDestroy {
  /** Current voice conversation state */
  readonly voiceState = signal<VoiceState>('IDLE');
  /** Whether voice mode overlay is active */
  readonly isVoiceMode = signal(false);
  /** Latest transcript from STT */
  readonly transcript = signal('');
  /** Whether the browser supports audio recording */
  readonly voiceSupported = signal(false);
  /** Current mic audio level (0–1), for reactive UI visualization */
  readonly audioLevel = signal(0);

  private mediaRecorder: MediaRecorder | null = null;
  private mediaStream: MediaStream | null = null;
  private audioChunks: Blob[] = [];

  // Audio playback
  private playbackContext: AudioContext | null = null;
  private audioQueue: ArrayBuffer[] = [];
  private isProcessingQueue = false;
  private ttsComplete = false;

  // VAD (Voice Activity Detection)
  private vadContext: AudioContext | null = null;
  private vadAnalyser: AnalyserNode | null = null;
  private vadAnimFrame: number | null = null;
  private speechDetected = false;
  private speechStart: number | null = null;
  private silenceStart: number | null = null;

  // Socket subscriptions
  private subs: Subscription[] = [];

  constructor(private readonly chatSocket: ChatSocketService) {
    this.voiceSupported.set(
      typeof navigator !== 'undefined' &&
        !!navigator.mediaDevices?.getUserMedia &&
        typeof MediaRecorder !== 'undefined',
    );
  }

  // ─── Socket Listeners ──────────────────────────────────────

  setupSocketListeners(): void {
    this.teardownSocketListeners();

    this.subs.push(
      this.chatSocket.voiceTranscript$.subscribe((event) => {
        if (event.isFinal) {
          this.transcript.set(event.text);
        }
      }),
      this.chatSocket.voiceAudioStart$.subscribe(() => {
        this.voiceState.set('SPEAKING');
        this.audioQueue = [];
        this.ttsComplete = false;
      }),
      this.chatSocket.voiceAudioChunk$.subscribe((event) => {
        const binary = atob(event.audio);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        this.audioQueue.push(bytes.buffer as ArrayBuffer);
        this.processAudioQueue();
      }),
      this.chatSocket.voiceAudioEnd$.subscribe(() => {
        this.ttsComplete = true;
        if (this.audioQueue.length === 0 && !this.isProcessingQueue) {
          this.onTtsFinished();
        }
      }),
      this.chatSocket.voiceError$.subscribe((event) => {
        console.error('Voice error:', event.error);
        if (this.isVoiceMode()) {
          this.voiceState.set('LISTENING');
          this.startRecordingInternal();
        } else {
          this.voiceState.set('IDLE');
        }
      }),
    );
  }

  teardownSocketListeners(): void {
    this.subs.forEach((s) => s.unsubscribe());
    this.subs = [];
  }

  // ─── Voice Mode Control ────────────────────────────────────

  toggleVoiceMode(): void {
    if (this.isVoiceMode()) {
      this.exitVoiceMode();
    } else {
      this.enterVoiceMode();
    }
  }

  enterVoiceMode(): void {
    this.isVoiceMode.set(true);
    this.transcript.set('');
    this.chatSocket.emitVoiceModeToggle(true);
    this.voiceState.set('LISTENING');
    this.startRecordingInternal();
  }

  exitVoiceMode(): void {
    this.isVoiceMode.set(false);
    this.chatSocket.emitVoiceModeToggle(false);
    this.cancelRecording();
    this.stopPlayback();
    this.voiceState.set('IDLE');
  }

  /** Stop recording and send audio (manual or VAD-triggered) */
  stopRecording(): void {
    if (this.mediaRecorder && this.voiceState() === 'LISTENING') {
      this.stopVad();
      this.voiceState.set('PROCESSING');
      this.mediaRecorder.stop();
    }
  }

  cancelRecording(): void {
    this.stopVad();
    if (this.mediaRecorder) {
      this.mediaRecorder.ondataavailable = null;
      this.mediaRecorder.onstop = null;
      try {
        if (this.mediaRecorder.state !== 'inactive') {
          this.mediaRecorder.stop();
        }
      } catch {
        // already stopped
      }
      this.stopMediaStream();
      this.audioChunks = [];
    }
  }

  stopPlayback(): void {
    this.audioQueue = [];
    this.isProcessingQueue = false;
    this.ttsComplete = false;
    if (this.playbackContext) {
      this.playbackContext.close().catch(() => {});
      this.playbackContext = null;
    }
  }

  // ─── Recording ─────────────────────────────────────────────

  private async startRecordingInternal(): Promise<void> {
    if (!this.voiceSupported()) return;

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : 'audio/ogg';

      this.mediaRecorder = new MediaRecorder(this.mediaStream, { mimeType });
      this.audioChunks = [];

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.audioChunks.push(event.data);
        }
      };

      this.mediaRecorder.onstop = () => {
        if (this.audioChunks.length > 0 && this.voiceState() === 'PROCESSING') {
          const blob = new Blob(this.audioChunks, { type: mimeType });
          this.sendAudioToServer(blob, mimeType);
        }
        this.stopMediaStream();
      };

      // Collect chunks every 250ms so short utterances have data
      this.mediaRecorder.start(250);
      this.transcript.set('');

      // Start Voice Activity Detection
      this.startVad();
    } catch (error) {
      console.error('Failed to start recording:', error);
      if (this.isVoiceMode()) {
        this.voiceState.set('LISTENING');
      } else {
        this.voiceState.set('IDLE');
      }
    }
  }

  // ─── Voice Activity Detection ──────────────────────────────

  private async startVad(): Promise<void> {
    if (!this.mediaStream) return;

    this.vadContext = new AudioContext();
    // Chrome/Firefox require explicit resume after creation
    if (this.vadContext.state === 'suspended') {
      await this.vadContext.resume();
    }

    const source = this.vadContext.createMediaStreamSource(this.mediaStream);
    this.vadAnalyser = this.vadContext.createAnalyser();
    this.vadAnalyser.fftSize = 512;
    source.connect(this.vadAnalyser);

    this.speechDetected = false;
    this.speechStart = null;
    this.silenceStart = null;

    const dataArray = new Float32Array(this.vadAnalyser.fftSize);

    const checkLevel = () => {
      if (!this.vadAnalyser || this.voiceState() !== 'LISTENING') return;

      this.vadAnalyser.getFloatTimeDomainData(dataArray);

      // Calculate RMS (root mean square) of the audio signal
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i] * dataArray[i];
      }
      const rms = Math.sqrt(sum / dataArray.length);

      // Expose normalized level (0–1) for UI visualization
      this.audioLevel.set(Math.min(1, rms * 15));

      const now = Date.now();

      if (rms > SILENCE_THRESHOLD) {
        // ── Speech detected ──
        if (!this.speechDetected) {
          this.speechDetected = true;
          this.speechStart = now;
        }
        this.silenceStart = null; // reset silence timer
      } else if (this.speechDetected) {
        // ── Silence after speech ──
        if (!this.silenceStart) {
          this.silenceStart = now;
        }

        const speechDuration = now - (this.speechStart ?? now);
        const silenceDuration = now - this.silenceStart;

        if (speechDuration >= MIN_SPEECH_MS && silenceDuration >= SILENCE_DURATION_MS) {
          // Enough speech followed by enough silence → auto-stop
          this.stopRecording();
          return;
        }
      }

      this.vadAnimFrame = requestAnimationFrame(checkLevel);
    };

    this.vadAnimFrame = requestAnimationFrame(checkLevel);
  }

  private stopVad(): void {
    if (this.vadAnimFrame) {
      cancelAnimationFrame(this.vadAnimFrame);
      this.vadAnimFrame = null;
    }
    if (this.vadContext) {
      this.vadContext.close().catch(() => {});
      this.vadContext = null;
    }
    this.vadAnalyser = null;
    this.audioLevel.set(0);
  }

  // ─── TTS Playback ─────────────────────────────────────────

  private onTtsFinished(): void {
    if (this.isVoiceMode()) {
      // Close playback context to free audio resources before re-acquiring mic
      if (this.playbackContext) {
        this.playbackContext.close().catch(() => {});
        this.playbackContext = null;
      }

      // Small delay to let browser release audio resources, then auto-listen
      this.voiceState.set('LISTENING');
      this.transcript.set('');
      setTimeout(() => {
        if (this.isVoiceMode() && this.voiceState() === 'LISTENING') {
          this.startRecordingInternal();
        }
      }, 300);
    } else {
      this.voiceState.set('IDLE');
    }
  }

  private async processAudioQueue(): Promise<void> {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;

    if (!this.playbackContext) {
      this.playbackContext = new AudioContext();
    }

    while (this.audioQueue.length > 0) {
      const chunk = this.audioQueue.shift()!;
      try {
        const audioBuffer = await this.playbackContext.decodeAudioData(chunk.slice(0));
        await this.playAudioBuffer(audioBuffer);
      } catch {
        // Skip undecodable chunks
      }
    }

    this.isProcessingQueue = false;

    if (this.ttsComplete) {
      this.onTtsFinished();
    }
  }

  private playAudioBuffer(audioBuffer: AudioBuffer): Promise<void> {
    return new Promise((resolve) => {
      if (!this.playbackContext) {
        resolve();
        return;
      }
      const source = this.playbackContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.playbackContext.destination);
      source.onended = () => resolve();
      source.start(0);
    });
  }

  // ─── Helpers ───────────────────────────────────────────────

  private async sendAudioToServer(blob: Blob, mimeType: string): Promise<void> {
    const arrayBuffer = await blob.arrayBuffer();
    const base64 = this.arrayBufferToBase64(arrayBuffer);
    this.chatSocket.emitVoiceMessage(base64, mimeType);
  }

  private stopMediaStream(): void {
    this.mediaStream?.getTracks().forEach((track) => track.stop());
    this.mediaStream = null;
  }

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  ngOnDestroy(): void {
    this.exitVoiceMode();
    this.teardownSocketListeners();
  }
}
