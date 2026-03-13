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

export interface VoiceConfig {
  sttUrl: string;
  ttsUrl: string;
  sttModel: string;
  sttLanguage: string;
  ttsVoice: string;
  ttsSpeed: number;
  enabled: boolean;
}

export interface VoiceHealthStatus {
  stt: boolean;
  tts: boolean;
}
