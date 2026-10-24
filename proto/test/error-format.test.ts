import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { prettyError } from "../error-format.ts";

const inner = {
  error: {
    message: "Workspace daily budget of $1.00 exceeded. Contact your org admin.",
    code: 403,
    metadata: { remedy_hint: "Wait for the budget interval to reset,\n or ask your admin." },
  },
};
const outer = {
  message: `litellm.APIError: OpenrouterException - ${JSON.stringify(inner)}\n\nLiteLLM: model group 'x' failed and no fallback was found. No fallbacks are configured.`,
  type: "permission_error",
  code: "403",
};

describe("prettyError", () => {
  it("unwraps a gateway error nested around the provider's error", () => {
    const text = prettyError(`Error: 403: ${JSON.stringify(outer)}`);
    const [head, hint, note] = text.split("\n");
    assert.equal(head, "403 permission_error: Workspace daily budget of $1.00 exceeded. Contact your org admin.");
    assert.equal(hint, "Wait for the budget interval to reset, or ask your admin.");
    assert.equal(note, "LiteLLM: model group 'x' failed and no fallback was found.");
  });

  it("shows a plain message unchanged", () => {
    assert.equal(prettyError("Connection refused"), "Connection refused");
  });

  it("keeps the text of an error body that is not JSON", () => {
    assert.equal(prettyError("Error: 502:  Bad\n gateway"), "502: Bad gateway");
  });
});
