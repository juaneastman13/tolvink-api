import { IsNotEmpty, IsOptional, IsIn, IsUrl, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export const DOC_TYPES = ['carta_porte', 'remito', 'pesaje', 'general'] as const;
export type DocType = (typeof DOC_TYPES)[number];

export class AnalyzeDocumentDto {
  @ApiProperty({ description: 'URL pública de la imagen (Supabase Storage)' })
  @IsNotEmpty()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(500)
  url: string;

  @ApiProperty({ required: false, enum: DOC_TYPES, default: 'general' })
  @IsOptional()
  @IsIn(DOC_TYPES)
  docType?: DocType;
}

export interface OcrResult {
  tipoDocumento: string;
  datos: Record<string, any>;
  confianza: number;
  textoOriginal?: string;
  structured?: boolean;
  processedAt?: string;
  model?: string;
}
