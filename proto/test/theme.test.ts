import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mdTheme } from "../pi-theme.ts";
import { assertTruecolor, dim, gauge, rampColor, selected, streaming } from "../theme.ts";

describe("theme", () => {
  it("renders pi components with the solarized theme, not a silent fallback", () => {
    // solarized yellow #b58900
    assert.match(mdTheme.heading("x"), /38;2;181;137;0m/);
  });

  it("keeps the selected row's color after a styled marker inside it", () => {
    const row = selected(`${streaming("*")}  name`);
    const accent = /^\x1b\[1m(\x1b\[38;2;[0-9;]+m)/.exec(row)?.[1] as string;
    assert.ok(row.includes(`\x1b[39m${accent}  name`), "accent restored after the marker's foreground reset");
  });

  it("colours gauges from green at 0 through yellow to red at 100, smoothly", () => {
    assert.deepEqual(rampColor(0), [133, 153, 0]); // solarized green
    assert.deepEqual(rampColor(50), [181, 137, 0]); // yellow
    assert.deepEqual(rampColor(100), [220, 50, 47]); // red
    const [r25] = rampColor(25);
    assert.ok(r25 > 133 && r25 < 181, "halfway between green and yellow");
    assert.deepEqual(rampColor(-20), rampColor(0));
    assert.deepEqual(rampColor(500), rampColor(100));
    assert.match(gauge(100, "x"), /^\x1b\[38;2;220;50;47mx\x1b\[39m$/);
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
