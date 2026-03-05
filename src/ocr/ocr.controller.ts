import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OcrService } from './ocr.service';
import { AnalyzeDocumentDto } from './ocr.dto';

@Controller('ocr')
@UseGuards(JwtAuthGuard)
export class OcrController {
  constructor(private readonly ocrService: OcrService) {}

  @Post('analyze')
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  async analyze(@Body() dto: AnalyzeDocumentDto) {
    return this.ocrService.analyzeFromUrl(dto.url, dto.docType);
  }
}
