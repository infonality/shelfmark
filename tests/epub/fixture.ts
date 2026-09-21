import { readFileSync } from "node:fs";
import { join } from "node:path";

export function chapterFixture(name: string): string {
  return readFileSync(
    join(process.cwd(), "tests", "epub", "fixtures-src", "compat-regressions", "EPUB", name),
    "utf8",
  );
}
