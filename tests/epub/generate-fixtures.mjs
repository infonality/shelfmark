import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const here = dirname(fileURLToPath(import.meta.url));
const sourceRoot = join(here, "fixtures-src");
const outputRoot = join(here, "generated");

await mkdir(outputRoot, { recursive: true });
for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const root = join(sourceRoot, entry.name);
  const zip = new JSZip();
  const mimetype = (await readFile(join(root, "mimetype"), "utf8")).trim();
  zip.file("mimetype", mimetype, { compression: "STORE" });

  for (const path of await filesBelow(root)) {
    const name = relative(root, path).split(sep).join("/");
    if (name === "mimetype") continue;
    zip.file(name, await readFile(path));
  }

  const archive = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  await writeFile(resolve(outputRoot, `${basename(root)}.epub`), archive);
}

async function filesBelow(root) {
  const found = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...(await filesBelow(path)));
    else if (entry.isFile()) found.push(path);
  }
  return found.sort();
}
