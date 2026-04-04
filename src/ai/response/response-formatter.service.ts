import { Injectable } from '@nestjs/common';
import { MAX_RESPONSE_CHARS, WEB_MAX_RESPONSE_CHARS, AUDIO_FILLERS } from '../ai.constants';

@Injectable()
export class ResponseFormatterService {

  /** Clean audio transcription: strip filler words, normalize whitespace, expand spelled-out letters */
  preprocessMessage(text: string): string {
    let clean = text
      .replace(AUDIO_FILLERS, ' ')
      .replace(/\bv\s+corta\b/gi, 'v')
      .replace(/\bb\s+larga\b/gi, 'b')
      .replace(/\bese\s+de\b/gi, 's')
      .replace(/\bdoble\s+ele\b/gi, 'll')
      .replace(/\s{2,}/g, ' ')
      .replace(/^[\s,.:;]+/, '')
      .trim();
    return clean || text.trim();
  }

  /** Post-process AI response: strip UUIDs, enforce length, quality check */
  validateResponse(text: string, isWeb = false): string {
    const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
    let clean = text.replace(UUID_RE, (match, offset) => {
      const before = text.slice(Math.max(0, offset - 80), offset);
      if (/https?:\/\/\S*$/i.test(before)) return match;
      return '[ID interno]';
    });

    const maxChars = isWeb ? WEB_MAX_RESPONSE_CHARS : MAX_RESPONSE_CHARS;
    if (clean.length > maxChars && !/F\d{2}-[A-Z]{3}\.\d{4}|FLT-\d{4,}/i.test(clean)) {
      const lineBreak = clean.lastIndexOf('\n', maxChars);
      if (lineBreak > maxChars * 0.5) {
        clean = clean.slice(0, lineBreak);
      } else {
        const sentenceBreak = clean.lastIndexOf('. ', maxChars);
        if (sentenceBreak > maxChars * 0.5) {
          clean = clean.slice(0, sentenceBreak + 1);
        } else {
          clean = clean.slice(0, maxChars);
        }
      }
    }

    return clean.replace(/\n{3,}/g, '\n\n').trim();
  }
}
