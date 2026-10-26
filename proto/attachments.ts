// Images pasted into the chat box. The picture itself is kept here; the box
// holds a short marker like "[image #1 png 340 KB]" that stands for it, so
// deleting the marker drops the image and the text around it stays editable.
import type { PromptImage } from "./shared.ts";

/** Largest image sent (most providers cap a single image well above this). */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const MARKER = /( ?)\[image #(\d+)[^\]]*\]/g;

export function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) {
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

export class Attachments {
  private readonly images = new Map<number, PromptImage>();
  private nextId = 1;

  /** Remember an image and return the marker to put in the chat box. */
  add(mimeType: string, data: Buffer): string {
    return this.put({ type: "image", data: data.toString("base64"), mimeType });
  }

  /** Like add, for an image already in message form (to give back one that was taken but not sent). */
  put(image: PromptImage): string {
    const id = this.nextId++;
    this.images.set(id, image);
    const kind = image.mimeType.replace(/^image\//, "");
    return `[image #${id} ${kind} ${fmtBytes(Math.floor((image.data.length * 3) / 4))}]`;
  }

  /** Split a message into its text (markers removed) and the images its markers stand for; forgets all images. */
  take(text: string): { text: string; images: PromptImage[] } {
    const images: PromptImage[] = [];
    const clean = text
      .replace(MARKER, (_all, _space, id: string) => {
        const image = this.images.get(Number(id));
        if (image) {
          images.push(image);
        }
        return "";
      })
      .trim();
    this.images.clear();
    return { text: clean, images };
  }

  clear(): void {
    this.images.clear();
  }
}
