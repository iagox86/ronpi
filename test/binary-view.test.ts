import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { binaryReadDisplay, hexdump, looksBinary } from "../src/binary-view.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ronpi-binview-"));
const garbled = { content: [{ type: "text", text: "%PDF-1.7\n���" }], isError: false };

describe("hexdump", () => {
  it("lays bytes out like xxd -g1: offset, hex columns, printable characters", () => {
    const bytes = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from([0xe2, 0xe3, 0xcf, 0xd3, 0x00, 0x0a, 0x31]), Buffer.from("tail")]);
    assert.equal(
      hexdump(bytes),
      [
        "00000000: 25 50 44 46 2d 31 2e 37 0a e2 e3 cf d3 00 0a 31  %PDF-1.7.......1",
        "00000010: 74 61 69 6c                                      tail",
      ].join("\n"),
    );
  });
});

describe("looksBinary", () => {
  it("is true for NUL bytes and invalid UTF-8, false for text", () => {
    assert.equal(looksBinary(Buffer.from([0x25, 0x50, 0x00, 0x01])), true);
    assert.equal(looksBinary(Buffer.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3])), true);
    assert.equal(looksBinary(Buffer.from("plain text\nwith lines\n")), false);
    assert.equal(looksBinary(Buffer.from("café ☃ text")), false);
  });

  it("forgives a multi-byte character cut off at the end of the sample", () => {
    assert.equal(looksBinary(Buffer.from("abc☃").subarray(0, 5)), false);
  });
});

describe("binaryReadDisplay", () => {
  function fileWith(bytes: Buffer): { dir: string; name: string } {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "doc.pdf"), bytes);
    return { dir, name: "doc.pdf" };
  }

  it("replaces a read of a binary file with a hexdump of its start and a size note", () => {
    const { dir, name } = fileWith(Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(1000, 0x00)]));
    const shown = binaryReadDisplay("read", { path: name }, garbled, dir)!;
    const text = (shown.content as Array<{ text: string }>)[0]!.text;
    assert.match(text, /^00000000: 25 50 44 46 2d 31 2e 37 0a 00/);
    assert.match(text, /binary file, 1,009 bytes - first 256 shown \(display only\)/);
    assert.equal(text.split("\n").filter((l) => /^[0-9a-f]{8}:/.test(l)).length, 16);
    assert.equal(shown.isError, false, "the rest of the result is kept");
  });

  it("leaves text files, other tools, image results and unreadable paths alone", () => {
    const { dir, name } = fileWith(Buffer.from("just text\n"));
    assert.equal(binaryReadDisplay("read", { path: name }, garbled, dir), undefined);
    const bin = fileWith(Buffer.alloc(40, 0));
    assert.equal(binaryReadDisplay("bash", { path: bin.name }, garbled, bin.dir), undefined);
    assert.equal(binaryReadDisplay("read", { path: bin.name }, { content: [{ type: "image", data: "x" }] }, bin.dir), undefined);
    assert.equal(binaryReadDisplay("read", { path: "missing.bin" }, garbled, bin.dir), undefined);
    assert.equal(binaryReadDisplay("read", {}, garbled, bin.dir), undefined);
  });

  it("understands an @ prefix on the path, as pi accepts", () => {
    const { dir, name } = fileWith(Buffer.alloc(40, 0));
    assert.ok(binaryReadDisplay("read", { path: `@${name}` }, garbled, dir));
  });
});
