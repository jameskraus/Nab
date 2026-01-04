import { test } from "bun:test";

const REQUIRED_BUDGET_ID = "06443689-ec9d-45d9-a37a-53dc60014769";

const token = process.env.YNAC_TOKEN;
const budgetId = process.env.YNAC_BUDGET_ID;

if (!token || !budgetId) {
  test.skip("integration: set YNAC_TOKEN and YNAC_BUDGET_ID to run", () => {});
} else if (budgetId !== REQUIRED_BUDGET_ID) {
  test("integration: budget id must be the dedicated test budget", () => {
    throw new Error(
      `YNAC_BUDGET_ID must be ${REQUIRED_BUDGET_ID} (got ${budgetId}). Refuse to run.`,
    );
  });
} else {
  test.todo("integration: end-to-end transaction mutation flow", () => {
    // Bead 9 will implement real API-backed tests.
  });
}
