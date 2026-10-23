import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mdTheme } from "../pi-theme.ts";
import { assertTruecolor, dim } from "../theme.ts";

describe("theme", () => {
  it("renders pi components with the solarized theme, not a silent fallback", () => {
    // solarized yellow #b58900
    assert.match(mdTheme.heading("x"), /38;2;181;137;0m/);
  });

  it("draws switcher chrome from the same theme file", () => {
    // solarized base01 #586e75 is the theme's muted color
    assert.match(dim("x"), /38;2;88;110;117m/);
  });

  it("refuses terminals without truecolor", () => {
    assert.throws(() => assertTruecolor({}), /24-bit/);
    assert.doesNotThrow(() => assertTruecolor({ COLORTERM: "truecolor" }));
    assert.doesNotThrow(() => assertTruecolor({ COLORTERM: "24bit" }));
  });
});
