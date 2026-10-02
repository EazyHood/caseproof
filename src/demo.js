import { reconcileCase } from './index.js';
import { fixtureCase, FIXTURE_CASES } from '../fixtures/cases.js';

console.log('CASEPROOF — HAND-AUTHORED SYNTHETIC FIXTURES\nNo PayPal or AI service is contacted. No money moves.\n');
for (const name of FIXTURE_CASES) {
  const result = reconcileCase(fixtureCase(name));
  console.log(JSON.stringify({ case: name, mode: result.mode, state: result.state, completed: `${result.amounts.completed} ${result.amounts.currencyCode}`, expected: result.amounts.expected, duplicateEvents: result.duplicateEvents, permittedActions: result.allowedActions, issues: result.issues.map(x => x.code) }, null, 2));
}
