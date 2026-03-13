import { Injectable, Logger } from '@nestjs/common';
import { SystemSettingsService } from '../settings/system-settings.service';
import {
  TranscriptionResult,
  TtsRequest,
  VoiceConfig,
  VoiceHealthStatus,
} from './voice.interfaces';

@Injectable()
export class VoiceService {
  private readonly logger = new Logger(VoiceService.name);

  constructor(private readonly settings: SystemSettingsService) {}

  /** Transcribe audio buffer to text via Faster-Whisper STT server */
  async transcribe(
    audioBuffer: Buffer,
    mimeType: string,
  ): Promise<TranscriptionResult> {
    const config = this.getConfig();
    const url = `${config.sttUrl}/v1/audio/transcriptions`;

    // Determine file extension from mime type
    const ext = mimeType.includes('webm')
      ? 'webm'
      : mimeType.includes('ogg')
        ? 'ogg'
        : mimeType.includes('wav')
          ? 'wav'
          : 'webm';

    // Build multipart form data
    const formData = new FormData();
    formData.append(
      'file',
      new Blob([audioBuffer.buffer.slice(
        audioBuffer.byteOffset,
        audioBuffer.byteOffset + audioBuffer.byteLength,
      ) as ArrayBuffer], { type: mimeType }),
      `audio.${ext}`,
    );
    formData.append('model', config.sttModel);
    if (config.sttLanguage !== 'auto') {
      formData.append('language', config.sttLanguage);
    }

    const response = await fetch(url, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`STT transcription failed (${response.status}): ${errorText}`);
    }

    const result = await response.json();
    this.logger.debug(
      `Transcribed: "${result.text}" (lang=${result.language}, duration=${result.duration}s)`,
    );

    return {
      text: result.text?.trim() ?? '',
      language: result.language,
      duration: result.duration,
    };
  }

  /** Synthesize text to audio via TTS server (complete buffer) */
  async synthesize(
    text: string,
    options?: Partial<TtsRequest>,
  ): Promise<Buffer> {
    const config = this.getConfig();
    const url = `${config.ttsUrl}/v1/tts`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        voice: options?.voice ?? config.ttsVoice,
        language: options?.language,
        speed: options?.speed ?? config.ttsSpeed,
        stream: false,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`TTS synthesis failed (${response.status}): ${errorText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  /**
   * Synthesize text to audio as streaming chunks via sentence-based pipelining.
   * Splits text into sentences, renders each independently, and yields audio
   * as soon as each sentence is done — first sentence plays while rest renders.
   */
  async *synthesizeStream(
    text: string,
    options?: Partial<TtsRequest>,
  ): AsyncGenerator<Buffer> {
    const sentences = this.splitIntoSentences(text);

    if (sentences.length === 0) return;

    // For very short text (1 sentence), just render and yield
    if (sentences.length === 1) {
      yield await this.synthesize(sentences[0], options);
      return;
    }

    // Pipeline: start rendering next sentence while yielding current one.
    // This overlaps TTS generation with audio playback on the client.
    let nextPromise: Promise<Buffer> | null = this.synthesize(sentences[0], options);

    for (let i = 0; i < sentences.length; i++) {
      // Wait for current sentence's audio
      const currentBuffer = await nextPromise!;

      // Pre-fetch next sentence (overlaps with client playback)
      if (i + 1 < sentences.length) {
        nextPromise = this.synthesize(sentences[i + 1], options);
      } else {
        nextPromise = null;
      }

      // Yield current audio immediately
      yield currentBuffer;
    }
  }

  /**
   * Split text into sentence-sized chunks for incremental TTS.
   * Balances between small chunks (low latency) and reasonable size (natural speech).
   */
  private splitIntoSentences(text: string): string[] {
    // Split on sentence-ending punctuation, keeping the punctuation
    const raw = text.split(/(?<=[.!?;])\s+/);

    const sentences: string[] = [];
    let current = '';

    for (const part of raw) {
      const trimmed = part.trim();
      if (!trimmed) continue;

      current += (current ? ' ' : '') + trimmed;

      // Yield chunk if it's long enough (>40 chars) or ends with sentence punctuation
      if (current.length > 40 || /[.!?]$/.test(current)) {
        sentences.push(current);
        current = '';
      }
    }

    // Don't forget remainder
    if (current.trim()) {
      sentences.push(current.trim());
    }

    return sentences;
  }

  /** Check health of both STT and TTS services */
  async checkHealth(): Promise<VoiceHealthStatus> {
    const config = this.getConfig();
    const [stt, tts] = await Promise.all([
      this.pingService(config.sttUrl),
      this.pingService(config.ttsUrl),
    ]);
    return { stt, tts };
  }

  /** Get current voice configuration from settings */
  getConfig(): VoiceConfig {
    return this.settings.getVoiceConfig();
  }

  private async pingService(baseUrl: string): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(`${baseUrl}/health`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return response.ok;
    } catch {
      return false;
    }
  }
}
