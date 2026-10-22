// Framing smoke test: LF-only splitting, U+2028/2029 survive inside JSON.
import { LineSplitter, encodeLine } from "../shared.ts";

const splitter = new LineSplitter();
const tricky = encodeLine({ type: "event", text: "line\u2028sep\u2029para\nactual newline" });
const chunk = `{"a":1}\n${tricky}${tricky}partial`;
const lines = splitter.push(chunk);

const expected = 3; // two complete records + one partial (buffered, not emitted)
if (lines.length !== expected) {
  console.error(`FAIL: expected ${expected} lines, got ${lines.length}: ${JSON.stringify(lines)}`);
  process.exit(1);
}
const parsed = lines.map((l) => JSON.parse(l));
if (parsed[0].a !== 1) {
  console.error("FAIL: first record wrong");
  process.exit(1);
}
if (parsed[1].text !== parsed[2].text || !parsed[1].text.includes("\u2028")) {
  console.error("FAIL: U+2028/2029 content corrupted");
  process.exit(1);
}
console.log("FRAMING PASS (U+2028/2029 preserved, partial line buffered)");
