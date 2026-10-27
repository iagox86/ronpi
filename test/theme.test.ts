import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mdTheme } from "../src/pi-theme.ts";
import { ageTier, assertTruecolor, byAge, dim, gauge, rampColor, selected, streaming } from "../src/theme.ts";

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

describe("age colouring", () => {
  const H = 3600_000;

  it("buckets recency into a day, a couple of days, a week, and older", () => {
    assert.equal(ageTier(5 * H), 0);
    assert.equal(ageTier(30 * H), 1);
    assert.equal(ageTier(5 * 24 * H), 2);
    assert.equal(ageTier(30 * 24 * H), 3);
  });

  it("treats a session with no known age as the oldest", () => {
    assert.equal(ageTier(undefined), 3);
  });

  it("colours the last day differently from older sessions", () => {
    assert.notEqual(byAge(1 * H, "x"), byAge(10 * 24 * H, "x"));
    assert.notEqual(byAge(1 * H, "x"), byAge(30 * H, "x"));
  });

  it("resets only the foreground so row backgrounds survive", () => {
    assert.ok(byAge(H, "x").endsWith("x\x1b[22m\x1b[39m"));
  });
});
