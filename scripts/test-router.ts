#!/usr/bin/env ts-node
/**
 * Standalone test for routeMessage — run with:
 *   npx ts-node scripts/test-router.ts
 */

import { routeMessage } from '../src/ai/prompt/prompt-builder.service';

interface TestCase {
  group: string;
  message: string;
  expected: 'haiku' | 'sonnet';
  sessionState?: { activeFlow?: string; pendingConfirmation?: boolean };
}

const cases: TestCase[] = [
  // 1. Greetings → haiku
  { group: 'greetings → haiku', message: 'hola', expected: 'haiku' },
  { group: 'greetings → haiku', message: 'buenas tardes', expected: 'haiku' },

  // 2. Status queries → haiku
  { group: 'status queries → haiku', message: 'mis fletes', expected: 'haiku' },
  { group: 'status queries → haiku', message: 'cómo va el F26-LCP.1822', expected: 'haiku' },
  { group: 'status queries → haiku', message: 'dashboard', expected: 'haiku' },

  // 3. Create freight → sonnet
  { group: 'create freight → sonnet', message: 'mandá 30 de soja a sofoval', expected: 'sonnet' },
  { group: 'create freight → sonnet', message: 'crear flete nuevo', expected: 'sonnet' },
  { group: 'create freight → sonnet', message: 'quiero enviar una carga', expected: 'sonnet' },

  // 4. Cancellations → sonnet
  { group: 'cancellations → sonnet', message: 'cancelá el flete', expected: 'sonnet' },

  // 5. Confirmations → sonnet
  { group: 'confirmations → sonnet', message: 'ya cargué', expected: 'sonnet' },
  { group: 'confirmations → sonnet', message: 'ya llegué', expected: 'sonnet' },
  { group: 'confirmations → sonnet', message: 'iniciá el viaje', expected: 'sonnet' },

  // 6. Active flows → sonnet
  { group: 'active flows → sonnet', message: 'dale', expected: 'sonnet', sessionState: { activeFlow: 'create_freight' } },
  { group: 'active flows → sonnet', message: 'sí', expected: 'sonnet', sessionState: { pendingConfirmation: true } },

  // 7. Freight codes → haiku
  { group: 'freight codes → haiku', message: 'F26-LCP.1822', expected: 'haiku' },

  // 8. Short ambiguous → haiku
  { group: 'short ambiguous → haiku', message: 'ok', expected: 'haiku' },
  { group: 'short ambiguous → haiku', message: 'gracias', expected: 'haiku' },

  // 9. Long ambiguous → sonnet
  { group: 'long ambiguous → sonnet', message: 'necesito organizar el transporte de grano para la semana que viene con varios camiones', expected: 'sonnet' },
];

let passed = 0;
let failed = 0;

console.log('');
console.log('═══════════════════════════════════════════════');
console.log('  routeMessage — Test Suite');
console.log('═══════════════════════════════════════════════');
console.log('');

let lastGroup = '';
for (const tc of cases) {
  if (tc.group !== lastGroup) {
    console.log(`  ── ${tc.group} ──`);
    lastGroup = tc.group;
  }

  const result = routeMessage(tc.message, tc.sessionState);
  const ok = result.model === tc.expected;

  if (ok) {
    passed++;
    console.log(`  ✅ "${tc.message}" → ${result.model} (${result.reason})`);
  } else {
    failed++;
    console.log(`  ❌ "${tc.message}" → ${result.model} (expected ${tc.expected}) reason: ${result.reason}`);
  }
}

console.log('');
console.log('───────────────────────────────────────────────');
console.log(`  Results: ${passed} passed, ${failed} failed, ${cases.length} total`);
console.log('───────────────────────────────────────────────');
console.log('');

process.exit(failed > 0 ? 1 : 0);
