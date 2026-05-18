-- Etapa 0: Remove old agent tables (Gemini + LangGraph based system)
-- These tables were specific to Agent V2 and are being replaced by new architecture

DROP TABLE IF EXISTS "WhatsAppSession" CASCADE;
DROP TABLE IF EXISTS "whatsapp_message_logs" CASCADE;
