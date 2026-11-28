/** Offline-only entry point. Does not start the relay or modify existing data. */
import { parseArgs } from "node:util";
import { restoreWithLedger } from "./offline-restore-ledger";

const usage = "bun apps/cloud/src/restore-backup.ts --offline --archive DIR --destination NEW_DIR --ledger FILE --deployment ID --minimum-generation N";

try {
  const { values } = parseArgs({
    options: {
      help: { type: "boolean" },
      offline: { type: "boolean" },
      archive: { type: "string" },
      destination: { type: "string" },
      ledger: { type: "string" },
      deployment: { type: "string" },
      "minimum-generation": { type: "string" },
    },
  });
  if (values.help) {
    console.log(usage);
    console.log("Stop the previous primary first. Supply the trusted generation from outside the archive. This command never starts the relay.");
  } else {
    const { offline, archive, destination, ledger, deployment, "minimum-generation": generation } = values;
    if (!offline || !archive || !destination || !ledger || !deployment || !generation || !/^(0|[1-9][0-9]*)$/.test(generation)) {
      throw new Error("An explicit offline confirmation and every restore input are required.");
    }
    console.log(restoreWithLedger({ archive, finalDir: destination, ledger, deployment, minimumGeneration: Number(generation) }));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Offline restore failed");
  console.error(usage);
  process.exitCode = 1;
}
