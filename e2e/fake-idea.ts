/** Stands in for IDEA's idea command: it logs how it was called. */
import { appendFileSync } from "node:fs";

appendFileSync(process.env.FAKE_IDEA_LOG!, `${process.argv.slice(2).join(" ")}\n`);
