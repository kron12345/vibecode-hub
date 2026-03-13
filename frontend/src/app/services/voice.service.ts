import { Injectable, OnDestroy, signal } from '@angular/core';
import { ChatSocketService } from './chat-socket.service';
import { Subscription } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class VoiceService implements OnDestroy {
  /** Whether the user is currently recording audio */
  readonly isRecording = signal(false);
  /** Whether voice mode is active for the current session */
  readonly isVoiceMode = signal(false);
  /** Whether TTS audio is currently playing */
  readonly isSpeaking = signal(false);
  /** Latest transcript from STT */
  readonly transcript = signal('');
  /** Whether the browser supports audio recording */
  readonly voiceSupported = signal(false);

  private mediaRecorder: MediaRecorder | null = null;
  private mediaStream: MediaStream | null = null;
  private audioChunks: Blob[] = [];

  // Audio playback
  private audioContext: AudioContext | null = null;
  private audioQueue: ArrayBuffer[] = [];
  private isProcessingQueue = false;

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
        }
      }),
      this.chatSocket.voiceAudioStart$.subscribe(() => {
        this.isSpeaking.set(true);
        this.audioQueue = [];
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
        // Mark end — audio will finish playing from queue
      }),
      this.chatSocket.voiceError$.subscribe((event) => {
        console.error('Voice error:', event.error);
        this.isRecording.set(false);
        this.isSpeaking.set(false);
      }),
    );
  }

  /** Clean up socket listeners */
  teardownSocketListeners(): void {
    this.subs.forEach((s) => s.unsubscribe());
    this.subs = [];
  }

  /** Start recording audio (Push-to-Talk) */
  async startRecording(): Promise<void> {
    if (!this.voiceSupported() || this.isRecording()) return;

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
        const blob = new Blob(this.audioChunks, { type: mimeType });
        this.sendAudioToServer(blob, mimeType);
        this.stopMediaStream();
      };

      this.mediaRecorder.start();
      this.isRecording.set(true);
      this.transcript.set('');
    } catch (error) {
      console.error('Failed to start recording:', error);
      this.isRecording.set(false);
    }
  }

  /** Stop recording and send audio to server */
  stopRecording(): void {
    if (this.mediaRecorder && this.isRecording()) {
      this.mediaRecorder.stop();
      this.isRecording.set(false);
    }
  }

  /** Cancel recording without sending */
  cancelRecording(): void {
    if (this.mediaRecorder && this.isRecording()) {
      this.mediaRecorder.ondataavailable = null;
      this.mediaRecorder.onstop = null;
      this.mediaRecorder.stop();
      this.stopMediaStream();
      this.isRecording.set(false);
      this.audioChunks = [];
    }
  }

  /** Toggle voice mode on/off */
  toggleVoiceMode(): void {
    const newState = !this.isVoiceMode();
    this.isVoiceMode.set(newState);
    this.chatSocket.emitVoiceModeToggle(newState);

    if (!newState) {
      this.cancelRecording();
      this.stopPlayback();
    }
  }

  /** Stop TTS playback */
  stopPlayback(): void {
    this.audioQueue = [];
    this.isProcessingQueue = false;
    this.isSpeaking.set(false);
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
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
    this.isSpeaking.set(false);
  }

  /** Play a single AudioBuffer and wait for completion */
  private playAudioBuffer(audioBuffer: AudioBuffer): Promise<void> {
    return new Promise((resolve) => {
      const source = this.audioContext!.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.audioContext!.destination);
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
    this.cancelRecording();
    this.stopPlayback();
    this.teardownSocketListeners();
  }
}
