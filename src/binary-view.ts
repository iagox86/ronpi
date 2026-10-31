// Display-only: a binary file read through pi's `read` tool arrives as the
// file's bytes decoded as text (a PDF becomes screens of replacement
// characters and control codes). Showing that is noise, so the transcript shows
// a hexdump of the start of the file instead. The model still gets exactly what
// pi sent it; this only changes what toriel draws.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SAMPLE_BYTES = 4096;
const SHOWN_BYTES = 256;

/** `xxd -g1` style: offset, 16 bytes in hex, then the printable characters. */
export function hexdump(buf: Uint8Array): string {
  const lines: string[] = [];
  for (let off = 0; off < buf.length; off += 16) {
    const row = buf.subarray(off, off + 16);
    const hex = [...row].map((b) => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = [...row].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".")).join("");
    lines.push(`${off.toString(16).padStart(8, "0")}: ${hex.padEnd(47)}  ${ascii}`);
  }
  return lines.join("\n");
}

/** Binary when the start has a NUL byte or is not valid UTF-8 (a cut multi-byte character at the end is forgiven). */
export function looksBinary(sample: Uint8Array): boolean {
  if (sample.includes(0)) {
    return true;
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let cut = 0; cut <= 3 && cut < sample.length; cut++) {
    try {
      decoder.decode(sample.subarray(0, sample.length - cut));
      return false;
    } catch {
      // a multi-byte character may just be cut off at the end of the sample
    }
  }
  return true;
}

function resolvePath(p: string, cwd: string): string {
  const bare = p.startsWith("@") ? p.slice(1) : p;
  return path.resolve(cwd, bare.replace(/^~(?=$|\/)/, os.homedir()));
}

/**
 * For a `read` of a binary file: the same result with its text replaced by a
 * hexdump of the first bytes. undefined when this is not such a result (other
 * tool, image result, text file, unreadable path) - the caller keeps pi's.
 */
export function binaryReadDisplay<R extends { content?: unknown }>(name: string, args: unknown, result: R, cwd: string): R | undefined {
  const file = (args as { path?: unknown } | undefined)?.path;
  if (name !== "read" || typeof file !== "string") {
    return undefined;
  }
  const content = result.content;
  if (Array.isArray(content) && content.some((b) => (b as { type?: string })?.type === "image")) {
    return undefined;
  }
  try {
    const target = resolvePath(file, cwd);
    const size = fs.statSync(target).size;
    const fd = fs.openSync(target, "r");
    let head: Buffer;
    try {
      head = Buffer.alloc(Math.min(size, SAMPLE_BYTES));
      fs.readSync(fd, head, 0, head.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    if (!looksBinary(head)) {
      return undefined;
    }
    const shown = head.subarray(0, SHOWN_BYTES);
    const note = `binary file, ${size.toLocaleString("en-US")} bytes - first ${shown.length} shown (display only)`;
    return { ...result, content: [{ type: "text", text: `${hexdump(shown)}\n\n${note}` }] };
  } catch {
    return undefined;
  }
}
