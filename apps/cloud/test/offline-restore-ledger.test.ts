import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CloudStore } from "../src/store";
import { startCloud } from "../src/server";
import { provisionLedger, recordDeletion, restoreWithLedger, RESTORE_LEDGER_KEY } from "../src/offline-restore-ledger";

test("offline restore fails closed without its current external deletion ledger", async () => {
  const root = mkdtempSync(join(tmpdir(), "weft-restore-ledger-test-"));
  const store = new CloudStore(join(root, "live.db"));
  const ext = join(root, "external-only"); mkdirSync(ext);
  const ledger = join(ext, "ledger.sqlite");
  const stale = join(ext, "stale.sqlite");
  const foreign = join(ext, "foreign.sqlite");
  const target = "synthetic-target", peer = "synthetic-neighbor", doc = "same-doc";
  const deployment = crypto.randomUUID();
  try {
    provisionLedger(ledger, deployment);
    cpSync(ledger, stale);
    provisionLedger(foreign, "other-" + deployment);
    for (const [user, bytes] of [[target, Uint8Array.of(1,2,3)], [peer, Uint8Array.of(7)]] as const) {
      store.putDocuments(user, JSON.stringify({documents:[{id:doc,name:"Synthetic"}]}));
      store.putFile(user, doc, bytes);
    }
    const targetToken = store.mintDeviceToken(target, "synthetic target");
    const peerToken = store.mintDeviceToken(peer, "synthetic peer");
    const legacyArchive = store.backup(join(root, "legacy-archives"));
    store["db"].run("INSERT INTO config (key,value) VALUES (?,?)", [RESTORE_LEDGER_KEY, deployment]);
    const archive = store.backup(join(root, "archives"));
    expect(readdirSync(archive).sort()).toEqual(["files","weft.db"]);
    // Parent deliberately kills a real child after its external FULL commit
    // but before any live stage/drain or durable in-volume fence.
    const committed = join(ext,"committed");
    const child = Bun.spawn([process.execPath, "--eval", `
      import {recordDeletion} from ${JSON.stringify(import.meta.resolve("../src/offline-restore-ledger.ts"))};
      const generation=recordDeletion(${JSON.stringify(ledger)},${JSON.stringify(deployment)},${JSON.stringify(target)});
      await Bun.write(${JSON.stringify(committed)},String(generation));
      await new Promise(r=>setTimeout(r,15000));
    `], {stdout:"ignore",stderr:"inherit"});
    try {
      const deadline=Date.now()+3000;
      for (;;) {
        if ((await Bun.file(committed).exists()) && (await Bun.file(committed).size)>0) break;
        if (child.exitCode!==null || Date.now()>=deadline) throw Error("Ledger worker did not commit");
        await Bun.sleep(10);
      }
    } finally {
      if (child.exitCode===null) child.kill("SIGKILL");
      await child.exited;
    }
    expect(child.signalCode).toBe("SIGKILL");
    const generation=Number(await Bun.file(committed).text());
    expect(generation).toBe(1);
    expect(recordDeletion(ledger, deployment, target)).toBe(generation);
    expect(store.getFile(target, doc)).toEqual(Uint8Array.of(1,2,3));
    expect(store.isAccountFenced(target)).toBe(false);
    const dest = join(root, "promoted");
    const guard = {archive,finalDir:dest,ledger,deployment,minimumGeneration:generation};
    expect(()=>restoreWithLedger({...guard,ledger:join(ext,"absent.sqlite")})).toThrow("existing external ledger");
    expect(()=>restoreWithLedger({...guard,ledger:foreign})).toThrow("Wrong ledger identity");
    expect(()=>restoreWithLedger({...guard,ledger:stale})).toThrow("Ledger is stale");
    expect(()=>restoreWithLedger({...guard,archive:legacyArchive})).toThrow("Wrong archive identity");
    // Even a valid file copied into the backup tree is not a trusted external ledger.
    const embedded = join(archive, "embedded-ledger.sqlite"); cpSync(ledger, embedded);
    expect(()=>restoreWithLedger({...guard,ledger:embedded})).toThrow("outside the restore image");
    const copyDb = new Database(join(archive,"weft.db"));
    copyDb.run("UPDATE config SET value=? WHERE key=?", ["foreign-archive", RESTORE_LEDGER_KEY]);
    copyDb.close();
    expect(()=>restoreWithLedger(guard)).toThrow("Wrong archive identity");
    const fixDb = new Database(join(archive,"weft.db"));
    fixDb.run("UPDATE config SET value=? WHERE key=?", [deployment, RESTORE_LEDGER_KEY]); fixDb.close();
    expect(existsSync(dest)).toBe(false);
    expect(readdirSync(root).some(name=>name.startsWith(".weft-restore-"))).toBe(false);

    const command = new URL("../src/restore-backup.ts", import.meta.url).pathname;
    const input = ["--archive", archive, "--destination", dest, "--ledger", ledger,
      "--deployment", deployment, "--minimum-generation", String(generation)];
    const run = (...args: string[]) => Bun.spawnSync([process.execPath, command, ...args], {
      env: {}, stdout: "pipe", stderr: "pipe",
    });
    const fail = (args: string[], reason: string) => {
      const result = run(...args);
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain(reason);
      expect(existsSync(dest)).toBe(false);
    };
    fail([], "every restore input");
    fail(input, "offline confirmation");
    fail(["--offline", ...input, "--ledger", join(ext, "absent.sqlite")], "existing external ledger");
    fail(["--offline", ...input, "--ledger", foreign], "Wrong ledger identity");
    fail(["--offline", ...input, "--ledger", stale], "Ledger is stale");
    fail(["--offline", ...input, "--archive", legacyArchive], "Wrong archive identity");
    fail(["--offline", ...input, "--destination", join(archive, "nested")], "cannot overlap");
    fail(["--offline", ...input, "--minimum-generation", "1.1"], "every restore input");

    const originalDatabase = readFileSync(join(archive, "weft.db"));
    const originalLive = readFileSync(join(root, "live.db"));
    const output = run("--offline", ...input);
    expect(output.exitCode).toBe(0);
    const restored = output.stdout.toString().trim();
    expect(restored).toEndWith("/promoted/relay.db");
    expect(readFileSync(join(archive, "weft.db"))).toEqual(originalDatabase);
    expect(readFileSync(join(root, "live.db"))).toEqual(originalLive);
    const repeated = run("--offline", ...input);
    expect(repeated.exitCode).toBe(1);
    expect(repeated.stderr.toString()).toContain("fresh destination");
    const relay = startCloud({port:0,db:restored});
    try {
      const list = (token:string) => fetch("http://localhost:"+relay.port+"/api/documents",{headers:{"x-device-token":token}});
      expect((await list(targetToken)).status).toBe(401);
      expect((await list(peerToken)).status).toBe(200);
      expect(relay.store.isAccountFenced(target)).toBe(true);
      expect(relay.store.getFile(target,doc)).toBeNull();
      expect(relay.store.getFile(peer,doc)).toEqual(Uint8Array.of(7));
      expect(()=>relay.store.putFile(target,doc,Uint8Array.of(99))).toThrow("Account is fenced");
    } finally { relay.stop(); relay.store["db"].close(); }
  } finally { store["db"].close(); rmSync(root,{recursive:true,force:true}); }
});
