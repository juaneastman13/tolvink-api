import { GeminiClient } from '../gemini.client';
import {
  DEFAULT_GEMINI_MODEL,
  getConfiguredAiProvider,
  getGeminiMaxOutputTokens,
  getGeminiModel,
  getGeminiTemperature,
} from '../llm-provider';

describe('Gemini LLM provider', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('uses Gemini as the default provider and model', () => {
    delete process.env.AI_PROVIDER;
    delete process.env.GEMINI_MODEL;

    expect(getConfiguredAiProvider()).toBe('gemini');
    expect(getGeminiModel()).toBe(DEFAULT_GEMINI_MODEL);
  });

  it('reads Gemini tuning from env', () => {
    process.env.GEMINI_MODEL = 'gemini-test-model';
    process.env.GEMINI_MAX_OUTPUT_TOKENS = '512';
    process.env.GEMINI_TEMPERATURE = '0.15';

    expect(getGeminiModel()).toBe('gemini-test-model');
    expect(getGeminiMaxOutputTokens()).toBe(512);
    expect(getGeminiTemperature()).toBe(0.15);
  });

  it('converts Tolvink tool definitions into Gemini function declarations', () => {
    const client = new GeminiClient();

    const tools = client.convertTools([{
      name: 'buscar_fletes',
      description: 'Busca fletes',
      input_schema: {
        type: 'object',
        properties: {
          estado: { type: 'string', description: 'Estado del flete', enum: ['pendiente', 'activo'] },
          limite: { type: 'number', description: 'Cantidad maxima' },
          trucks: {
            type: 'array',
            description: 'Camiones a asignar',
            items: {
              type: 'object',
              properties: {
                truckId: { type: 'string' },
                tons: { type: 'number' },
              },
              required: ['truckId'],
            },
          },
        },
        required: ['estado'],
      },
    }]);

    expect(tools).toEqual([{
      name: 'buscar_fletes',
      description: 'Busca fletes',
      parameters: {
        type: 'OBJECT',
        properties: {
          estado: { type: 'STRING', description: 'Estado del flete', enum: ['pendiente', 'activo'] },
          limite: { type: 'NUMBER', description: 'Cantidad maxima' },
          trucks: {
            type: 'ARRAY',
            description: 'Camiones a asignar',
            items: {
              type: 'OBJECT',
              properties: {
                truckId: { type: 'STRING' },
                tons: { type: 'NUMBER' },
              },
              required: ['truckId'],
            },
          },
        },
        required: ['estado'],
      },
    }]);
  });

  it('parses Gemini text and function calls', async () => {
    process.env.GEMINI_MODEL = 'gemini-test-model';
    process.env.GEMINI_MAX_OUTPUT_TOKENS = '99';
    process.env.GEMINI_TEMPERATURE = '0.2';
    const client = new GeminiClient();
    const generateContent = jest.fn().mockResolvedValue({
      candidates: [{
        content: {
          parts: [
            { text: 'Listo' },
            { functionCall: { name: 'crear_flete', args: { origen: 'Mercedes' } } },
          ],
        },
      }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    });

    (client as any).client = { models: { generateContent } };

    const result = await client.sendMessage({
      system: 'Sos Tolvink',
      messages: [{ role: 'user', parts: [{ text: 'crear flete' }] }],
      tools: [{ name: 'crear_flete', description: 'Crea flete', parameters: { type: 'OBJECT', properties: {} } }],
    });

    expect(generateContent).toHaveBeenCalledWith({
      model: 'gemini-test-model',
      contents: [{ role: 'user', parts: [{ text: 'crear flete' }] }],
      config: {
        systemInstruction: 'Sos Tolvink',
        maxOutputTokens: 99,
        temperature: 0.2,
        tools: [{ functionDeclarations: [{ name: 'crear_flete', description: 'Crea flete', parameters: { type: 'OBJECT', properties: {} } }] }],
      },
    });
    expect(result.text).toBe('Listo');
    expect(result.functionCalls).toEqual([{ name: 'crear_flete', args: { origen: 'Mercedes' } }]);
    expect(result.usageMetadata).toEqual({ promptTokenCount: 10, candidatesTokenCount: 5 });
  });

  it('fails clearly when Gemini is not initialized', async () => {
    const client = new GeminiClient();

    await expect(client.sendMessage({ system: '', messages: [], tools: [] }))
      .rejects.toThrow('Gemini client not initialized');
  });
});
