import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Attachments, fmtBytes } from "../src/attachments.ts";

describe("Attachments", () => {
  it("gives each image a marker that names its kind and size", () => {
    const a = new Attachments();
    assert.equal(a.add("image/png", Buffer.alloc(340 * 1024)), "[image #1 png 340 KB]");
    assert.equal(a.add("image/jpeg", Buffer.alloc(2 * 1024 * 1024)), "[image #2 jpeg 2.0 MB]");
  });

  it("turns markers in a message back into their images and strips them from the text", () => {
    const a = new Attachments();
    const marker = a.add("image/png", Buffer.from("PNGDATA"));
    const { text, images } = a.take(`what is wrong here ${marker} please`);
    assert.equal(text, "what is wrong here please");
    assert.deepEqual(images, [{ type: "image", data: Buffer.from("PNGDATA").toString("base64"), mimeType: "image/png" }]);
  });

  it("drops an image whose marker was deleted from the message", () => {
    const a = new Attachments();
    a.add("image/png", Buffer.from("x"));
    assert.deepEqual(a.take("no marker left"), { text: "no marker left", images: [] });
  });

  it("forgets everything after a message is taken", () => {
    const a = new Attachments();
    const marker = a.add("image/png", Buffer.from("x"));
    a.take(marker);
    assert.deepEqual(a.take(marker).images, []);
  });

  it("works for a message that is only an image", () => {
    const a = new Attachments();
    const { text, images } = a.take(a.add("image/png", Buffer.from("x")));
    assert.equal(text, "");
    assert.equal(images.length, 1);
  });
});

describe("fmtBytes", () => {
  it("never shows 0 KB", () => {
    assert.equal(fmtBytes(10), "1 KB");
  });
});
