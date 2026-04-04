import { OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
export declare const MODELS: {
    readonly haiku: "claude-haiku-4-5-20251001";
    readonly sonnet: "claude-sonnet-4-6-20260401";
};
export type ModelTier = keyof typeof MODELS;
export declare const HAIKU_TOOLS: Set<string>;
export declare const SONNET_ONLY_TOOLS: Set<string>;
export interface RouteDecision {
    model: ModelTier;
    reason: string;
}
export declare function routeMessage(message: string, sessionState?: {
    activeFlow?: string;
    pendingConfirmation?: boolean;
}): RouteDecision;
export interface PromptBlocks {
    system: Array<{
        type: 'text';
        text: string;
        cache_control?: {
            type: 'ephemeral';
        };
    }>;
    contextMessage?: string;
    model: ModelTier;
    toolFilter: Set<string>;
    routeReason: string;
}
export declare class PromptBuilderService implements OnModuleInit {
    private prisma;
    private readonly logger;
    private staticBlockCache;
    constructor(prisma: PrismaService);
    onModuleInit(): void;
    private precomputeStaticBlocks;
    private buildStaticBlock;
    private buildDynamicBlock;
    private buildProactiveData;
    private resolveProducerCompanyId;
    private resolveRoleKey;
    build(user: any, companyType: string, isWeb?: boolean, plantAccessMap?: Map<string, string>, tier?: ModelTier): Promise<PromptBlocks>;
}
