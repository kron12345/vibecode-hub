export type TtsEngine = 'piper' | 'qwen3' | 'f5-tts';

export interface TranscriptionResult {
  text: string;
  language?: string;
  duration?: number;
}

export interface TtsRequest {
  text: string;
  voice?: string;
  language?: string;
  speed?: number;
  stream?: boolean;
}

export interface TtsVoiceInfo {
  id: string;
  name: string;
  locale?: string;
  quality?: string;
}

export interface VoiceConfig {
  sttUrl: string;
  ttsUrl: string;
  sttModel: string;
  sttLanguage: string;
  ttsEngine: TtsEngine;
  ttsVoice: string;
  ttsSpeed: number;
  enabled: boolean;
}

export interface VoiceHealthStatus {
  stt: boolean;
  tts: boolean;
  ttsEngine?: string;
  ttsVoices?: number;
}
