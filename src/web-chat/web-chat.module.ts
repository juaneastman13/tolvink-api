import { Module } from '@nestjs/common';
import { WebChatController } from './web-chat.controller';
import { WebChatService } from './web-chat.service';
import { AiModule } from '../ai/ai.module';
import { GeminiModule } from '../ai/gemini/gemini.module';
import { OcrModule } from '../ocr/ocr.module';

@Module({
  imports: [AiModule, GeminiModule, OcrModule],
  controllers: [WebChatController],
  providers: [WebChatService],
})
export class WebChatModule {}
