import { Injectable, OnDestroy, signal } from '@angular/core';
import { ChatSocketService } from './chat-socket.service';
import { Subscription } from 'rxjs';

export type VoiceState = 'IDLE' | 'LISTENING' | 'PROCESSING' | 'SPEAKING';

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

  // Convenience computed-like getters
  get isRecording(): boolean {
    return this.voiceState() === 'LISTENING';
  }
  get isSpeaking(): boolean {
    return this.voiceState() === 'SPEAKING';
  }

  private mediaRecorder: MediaRecorder | null = null;
  private mediaStream: MediaStream | null = null;
  private audioChunks: Blob[] = [];

  // Audio playback
  private audioContext: AudioContext | null = null;
  private audioQueue: ArrayBuffer[] = [];
  private isProcessingQueue = false;
  private ttsComplete = false;

  // Socket subscriptions
  private subs: Subscription[] = [];

  constructor(private readonly chatSocket: ChatSocketService) {
    // Check browser support
    this.voiceSupported.set(
      typeof navigator !== 'undefined' &&
        !!navigator.mediaDevices?.getUserMedia &&
        typeof MediaRecorder !== 'undefined',
    );
  }

  /** Set up socket listeners for voice events */
  setupSocketListeners(): void {
    // Clean up previous subs
    this.teardownSocketListeners();

    this.subs.push(
      this.chatSocket.voiceTranscript$.subscribe((event) => {
        if (event.isFinal) {
          this.transcript.set(event.text);
          // Backend saves message + triggers agent — we just show processing state
          // (the newMessage event will show it in the chat)
        }
      }),
      this.chatSocket.voiceAudioStart$.subscribe(() => {
        this.voiceState.set('SPEAKING');
        this.audioQueue = [];
        this.ttsComplete = false;
      }),
      this.chatSocket.voiceAudioChunk$.subscribe((event) => {
        // Decode base64 to ArrayBuffer and queue
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
        // If queue is already empty, cycle back to listening
        if (this.audioQueue.length === 0 && !this.isProcessingQueue) {
          this.onTtsFinished();
        }
      }),
      this.chatSocket.voiceError$.subscribe((event) => {
        console.error('Voice error:', event.error);
        // On error, go back to listening if voice mode is active
        if (this.isVoiceMode()) {
          this.voiceState.set('LISTENING');
          this.startRecordingInternal();
        } else {
          this.voiceState.set('IDLE');
        }
      }),
    );
  }

  /** Clean up socket listeners */
  teardownSocketListeners(): void {
    this.subs.forEach((s) => s.unsubscribe());
    this.subs = [];
  }

  /** Toggle voice mode overlay on/off */
  toggleVoiceMode(): void {
    if (this.isVoiceMode()) {
      this.exitVoiceMode();
    } else {
      this.enterVoiceMode();
    }
  }

  /** Enter voice mode — show overlay, start listening */
  enterVoiceMode(): void {
    this.isVoiceMode.set(true);
    this.transcript.set('');
    this.chatSocket.emitVoiceModeToggle(true);
    this.voiceState.set('LISTENING');
    this.startRecordingInternal();
  }

  /** Exit voice mode — stop everything, hide overlay */
  exitVoiceMode(): void {
    this.isVoiceMode.set(false);
    this.chatSocket.emitVoiceModeToggle(false);
    this.cancelRecording();
    this.stopPlayback();
    this.voiceState.set('IDLE');
  }

  /** Stop recording and send audio to server */
  stopRecording(): void {
    if (this.mediaRecorder && this.voiceState() === 'LISTENING') {
      this.voiceState.set('PROCESSING');
      this.mediaRecorder.stop();
    }
  }

  /** Cancel recording without sending */
  cancelRecording(): void {
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

  /** Stop TTS playback */
  stopPlayback(): void {
    this.audioQueue = [];
    this.isProcessingQueue = false;
    this.ttsComplete = false;
    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
  }

  /** Start recording audio internally */
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

      // Choose best supported format
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

      this.mediaRecorder.start();
      this.transcript.set('');
    } catch (error) {
      console.error('Failed to start recording:', error);
      if (this.isVoiceMode()) {
        this.voiceState.set('LISTENING');
      } else {
        this.voiceState.set('IDLE');
      }
    }
  }

  /** Called when TTS playback is fully done — auto-cycle to listening */
  private onTtsFinished(): void {
    if (this.isVoiceMode()) {
      // Auto-cycle: start listening again for the next turn
      this.voiceState.set('LISTENING');
      this.transcript.set('');
      this.startRecordingInternal();
    } else {
      this.voiceState.set('IDLE');
    }
  }

  /** Send recorded audio blob to server via WebSocket */
  private async sendAudioToServer(blob: Blob, mimeType: string): Promise<void> {
    const arrayBuffer = await blob.arrayBuffer();
    const base64 = this.arrayBufferToBase64(arrayBuffer);
    this.chatSocket.emitVoiceMessage(base64, mimeType);
  }

  /** Process queued audio chunks for playback */
  private async processAudioQueue(): Promise<void> {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;

    if (!this.audioContext) {
      this.audioContext = new AudioContext();
    }

    while (this.audioQueue.length > 0) {
      const chunk = this.audioQueue.shift()!;
      try {
        const audioBuffer = await this.audioContext.decodeAudioData(chunk.slice(0));
        await this.playAudioBuffer(audioBuffer);
      } catch {
        // Skip undecodable chunks (e.g. partial WAV headers)
      }
    }

    this.isProcessingQueue = false;

    // If TTS stream has ended and queue is drained, cycle back
    if (this.ttsComplete) {
      this.onTtsFinished();
    }
  }

  /** Play a single AudioBuffer and wait for completion */
  private playAudioBuffer(audioBuffer: AudioBuffer): Promise<void> {
    return new Promise((resolve) => {
      if (!this.audioContext) {
        resolve();
        return;
      }
      const source = this.audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.audioContext.destination);
      source.onended = () => resolve();
      source.start(0);
    });
  }

  /** Stop the media stream tracks */
  private stopMediaStream(): void {
    this.mediaStream?.getTracks().forEach((track) => track.stop());
    this.mediaStream = null;
  }

  /** Convert ArrayBuffer to base64 string */
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
