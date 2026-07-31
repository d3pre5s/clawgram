// `node --test <glob>` exits 0 when the glob matches nothing, so a broken test
// build would report a silent green run. Fail loudly instead.
import { readdirSync } from "node:fs";

const dir = "dist-test/test";
const compiled = readdirSync(dir).filter((name) => name.endsWith(".test.js"));

if (compiled.length === 0) {
  console.error(`No compiled test files in ${dir}/. Did "npm run build:test" emit anything?`);
  process.exit(1);
}
