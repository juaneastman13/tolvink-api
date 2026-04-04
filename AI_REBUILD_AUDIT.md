# AI Module Rebuild Audit — Phase 0

## 0.1 — Current Structure (32 files)

```
src/ai/
├── ai.module.ts                    # NestJS module (registers all providers)
├── ai.service.ts                   # Main orchestrator — chat(), tool loop, model selection
├── ai.constants.ts                 # Models, tokens, rate limits, status labels
├── ai.utils.ts                     # resolveActiveRole, hasType, sanitizeForPrompt
├── ai-tool-definitions.ts          # 103 tool definitions (Anthropic format)
├── gemini/                         # Gemini provider (parallel, not active in prod)
│   ├── gemini.module.ts
│   ├── gemini.service.ts
│   ├── gemini.constants.ts
│   ├── gemini-prompt-builder.service.ts
│   └── gemini-tool-adapter.ts
├── hybrid/                         # Hybrid system (registered but NOT USED)
│   ├── ai-interpreter.service.ts
│   ├── flow.service.ts
│   ├── freight-flow.service.ts
│   ├── freight-parser.service.ts
│   ├── index.ts
│   ├── intent-detector.service.ts
│   ├── message-router.service.ts
│   └── response-builder.service.ts
├── interceptor/
│   └── message-interceptor.service.ts  # Layer 0 — greetings, dashboard without AI
├── prompt/
│   ├── prompt-builder.service.ts       # System prompt builder (12 XML sections)
│   └── prompt-builder.service.old.ts   # Backup
├── response/
│   └── response-formatter.service.ts   # Strip UUIDs, truncate, audio cleanup
├── routing/
│   ├── intent-router.service.ts        # Model selection (Haiku/Sonnet) + tool filtering
│   └── tool-domain-router.ts           # Domain-based tool filtering
├── session/
│   └── session-manager.service.ts      # History, side-effects, action staging
└── tools/
    ├── ai-context.service.ts           # Freight resolution, access control
    ├── freight-query-tools.service.ts  # Read-only freight tools
    ├── freight-action-tools.service.ts # Mutation freight tools (prepare, confirm)
    ├── transport-tools.service.ts      # Assignment, trucks, drivers
    ├── admin-tools.service.ts          # User mgmt, company, branches
    ├── location-tools.service.ts       # Maps, tracking, GPS, navigate
    └── definitions/index.ts            # Re-exports
```

## 0.2 — External Consumers

| Consumer | Imports from AI | Usage |
|----------|----------------|-------|
| whatsapp/whatsapp.module.ts | AiModule, GeminiModule | Module imports |
| whatsapp/whatsapp-router.service.ts | AiService, GeminiService, MessageRouterService | chat(), AI_PROVIDER switch |
| web-chat/web-chat.module.ts | AiModule, GeminiModule | Module imports |
| web-chat/web-chat.service.ts | AiService, GeminiService | chat() with streaming |
| diagnostic/diagnostic.controller.ts | Anthropic SDK directly (NOT from ai/) | Mechanic diagnostic agent |
| ocr/ocr.service.ts | Anthropic SDK directly (NOT from ai/) | Claude Vision OCR |

**Contract**: `chat(phone, userMessage, user, session, onDelta?) → { text, buttons?, navigate? }`

## 0.3 — Active Tools (103 total, 1 deprecated)

**Deprecated**: `escalate_to_sonnet` (Anthropic-specific, remove)
**Active**: 102 tools across 8 domains

**Injected NestJS Services** (business logic, NOT touched):
- FreightsService, FieldsService, TrucksService, AdminService
- WhatsAppService, OcrService, AssignmentSuggestionsService
- PrismaService, ConfigService

## 0.4 — Prompt Structure

12 XML sections: identity, tone, freight_states, core_rules, safety, behavior,
create_freight, assign_transport, selection, fleet_management+fleet_economics,
documents+locations+links, proactive_data

## 0.5 — Session & Conversation

- MAX_HISTORY: 15 messages
- Session timeout: 60 min
- Per-phone lock (prevent concurrent)
- Tool loop: max 5 iterations, 90s timeout
- Read-only tools: parallel execution
- Mutation tools: sequential

## 0.6 — Code to Remove

- `@anthropic-ai/sdk` in package.json
- `@google/genai` already installed (keep)
- Anthropic usage in diagnostic.controller.ts and ocr.service.ts (migrate to Gemini)
- Entire src/ai/ directory
