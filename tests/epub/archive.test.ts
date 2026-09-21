import { readFileSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

describe("generated EPUB compatibility fixture", () => {
  it("is a real EPUB archive with an uncompressed first mimetype entry", async () => {
    const path = join(process.cwd(), "tests", "epub", "generated", "compat-regressions.epub");
    const bytes = readFileSync(path);
    const firstNameLength = bytes.readUInt16LE(26);
    const firstName = bytes.subarray(30, 30 + firstNameLength).toString("utf8");
    const compressionMethod = bytes.readUInt16LE(8);
    const zip = await JSZip.loadAsync(bytes);

    expect(bytes.readUInt32LE(0)).toBe(0x04034b50);
    expect(firstName).toBe("mimetype");
    expect(compressionMethod).toBe(0);
    expect(await zip.file("mimetype")?.async("string")).toBe("application/epub+zip");
    expect(zip.file("META-INF/container.xml")).not.toBeNull();
    expect(zip.file("EPUB/package.opf")).not.toBeNull();
    expect(zip.file("EPUB/self-closing.xhtml")).not.toBeNull();
  });
});
