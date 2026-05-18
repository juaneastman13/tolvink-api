import { Module } from '@nestjs/common';
// TODO: Etapa 0 - Web chat service removed pending agent system rebuild
// import { WebChatController } from './web-chat.controller';
// import { WebChatService } from './web-chat.service';
import { OcrModule } from '../ocr/ocr.module';

// TODO: AiModule + WebChatService removed in Etapa 0. Needs refactoring in Etapa 1
// to use the new agent system (Anthropic SDK instead of Gemini + LangChain)
@Module({
  imports: [OcrModule],
  controllers: [],
  providers: [],
})
export class WebChatModule {}
