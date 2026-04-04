import { Module, forwardRef } from '@nestjs/common';
import { GeminiService } from './gemini.service';
import { GeminiPromptBuilderService } from './gemini-prompt-builder.service';
import { AiModule } from '../ai.module';

/**
 * Gemini module — parallel AI provider using Google Gemini Flash/Pro.
 * Does NOT replace AiModule. Import alongside it and switch at the router level.
 *
 * Tool execution is delegated to AiService (from AiModule) to avoid
 * duplicating 188 tool handlers.
 */
@Module({
  imports: [forwardRef(() => AiModule)],
  providers: [GeminiService, GeminiPromptBuilderService],
  exports: [GeminiService],
})
export class GeminiModule {}
