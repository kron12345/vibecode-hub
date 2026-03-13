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

  // Persistent mic stream (acquired once on enterVoiceMode, released on exit)
  private mediaStream: MediaStream | null = null;

  // Per-round recording
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private currentMimeType = '';

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

  // Processing timeout (auto-recover if stuck)
  private processingTimeout: ReturnType<typeof setTimeout> | null = null;

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
        this.clearProcessingTimeout();
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
        console.error('[Voice] Server error:', event.error);
        if (this.isVoiceMode()) {
          this.voiceState.set('LISTENING');
          this.startRecordingRound();
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

  async enterVoiceMode(): Promise<void> {
    if (!this.voiceSupported()) return;

    try {
      // Acquire mic ONCE — this happens during user gesture (button click)
      console.debug('[Voice] Acquiring mic stream...');
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      console.debug('[Voice] Mic acquired, tracks:', this.mediaStream.getAudioTracks().length);

      // Determine supported mime type once
      this.currentMimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : 'audio/ogg';

      this.isVoiceMode.set(true);
      this.transcript.set('');
      this.chatSocket.emitVoiceModeToggle(true);
      this.voiceState.set('LISTENING');

      // Start first recording round
      this.startRecordingRound();
    } catch (error) {
      console.error('[Voice] Failed to acquire mic:', error);
      this.voiceState.set('IDLE');
    }
  }

  exitVoiceMode(): void {
    this.isVoiceMode.set(false);
    this.chatSocket.emitVoiceModeToggle(false);
    this.clearProcessingTimeout();
    this.stopCurrentRound();
    this.stopPlayback();
    this.releaseMediaStream();
    this.voiceState.set('IDLE');
  }

  /** Stop recording and send audio (manual or VAD-triggered) */
  stopRecording(): void {
    if (this.mediaRecorder && this.voiceState() === 'LISTENING') {
      this.stopVad();
      this.voiceState.set('PROCESSING');

      // Stop MediaRecorder — onstop handler will send audio
      this.mediaRecorder.stop();

      // Safety timeout: if stuck in PROCESSING for 30s, auto-recover
      this.clearProcessingTimeout();
      this.processingTimeout = setTimeout(() => {
        if (this.voiceState() === 'PROCESSING' && this.isVoiceMode()) {
          console.warn('[Voice] Processing timeout — recovering to LISTENING');
          this.voiceState.set('LISTENING');
          this.startRecordingRound();
        }
      }, 30_000);
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

  // ─── Per-Round Recording (reuses persistent mediaStream) ──

  private startRecordingRound(): void {
    if (!this.mediaStream) {
      console.warn('[Voice] No media stream — cannot start round');
      return;
    }

    // Check stream is still alive
    const track = this.mediaStream.getAudioTracks()[0];
    if (!track || track.readyState === 'ended') {
      console.warn('[Voice] Media stream track ended — cannot start round');
      if (this.isVoiceMode()) {
        this.exitVoiceMode();
      }
      return;
    }

    // Clean up previous round's MediaRecorder (stream stays alive)
    this.stopCurrentRound();

    try {
      this.mediaRecorder = new MediaRecorder(this.mediaStream, { mimeType: this.currentMimeType });
      this.audioChunks = [];

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.audioChunks.push(event.data);
        }
      };

      this.mediaRecorder.onstop = () => {
        console.debug('[Voice] MediaRecorder stopped, chunks:', this.audioChunks.length);
        if (this.audioChunks.length > 0 && this.voiceState() === 'PROCESSING') {
          const blob = new Blob(this.audioChunks, { type: this.currentMimeType });
          this.sendAudioToServer(blob, this.currentMimeType);
        }
        // NOTE: Do NOT stop mediaStream here — it persists across rounds
      };

      // Collect chunks every 250ms so short utterances have data
      this.mediaRecorder.start(250);
      this.transcript.set('');

      // Start Voice Activity Detection on the persistent stream
      this.startVad();
      console.debug('[Voice] Recording round started');
    } catch (error) {
      console.error('[Voice] Failed to start recording round:', error);
    }
  }

  /** Stop current MediaRecorder + VAD without releasing the mic stream */
  private stopCurrentRound(): void {
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
      this.mediaRecorder = null;
    }
    this.audioChunks = [];
  }

  // ─── Voice Activity Detection ──────────────────────────────

  private startVad(): void {
    if (!this.mediaStream) return;

    // Reuse a single AudioContext for VAD if possible, or create a new one
    if (!this.vadContext || this.vadContext.state === 'closed') {
      this.vadContext = new AudioContext();
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
    // Don't close vadContext — we reuse it across rounds
    this.vadAnalyser = null;
    this.audioLevel.set(0);
  }

  // ─── TTS Playback ─────────────────────────────────────────

  private onTtsFinished(): void {
    if (this.isVoiceMode()) {
      console.debug('[Voice] TTS finished, preparing next listen cycle');

      // Close playback context to free audio output
      if (this.playbackContext) {
        this.playbackContext.close().catch(() => {});
        this.playbackContext = null;
      }

      this.voiceState.set('LISTENING');
      this.transcript.set('');

      // Small delay to let browser release audio output, then start next round
      // No getUserMedia needed — stream is still alive!
      setTimeout(() => {
        if (this.isVoiceMode() && this.voiceState() === 'LISTENING') {
          console.debug('[Voice] Starting next recording round...');
          this.startRecordingRound();
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

  private releaseMediaStream(): void {
    this.mediaStream?.getTracks().forEach((track) => track.stop());
    this.mediaStream = null;
    // Close VAD context when releasing stream
    if (this.vadContext) {
      this.vadContext.close().catch(() => {});
      this.vadContext = null;
    }
  }

  private clearProcessingTimeout(): void {
    if (this.processingTimeout) {
      clearTimeout(this.processingTimeout);
      this.processingTimeout = null;
    }
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
