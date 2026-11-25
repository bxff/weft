import { Database } from "bun:sqlite";
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, win32 } from "node:path";

function fileDigest(path: string, buffer: Uint8Array): string {
  const hash = new Bun.CryptoHasher("sha256");
  const fd = openSync(path, "r");
  try {
    for (let size = readSync(fd, buffer); size > 0; size = readSync(fd, buffer)) {
      hash.update(buffer.subarray(0, size));
    }
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}

/** A source blob can change after the database capture. Verify the copied
 * bytes against the captured rows before making the archive visible. */
export function publishBackup(db: Database, filesDir: string, destDir: string): string {
  mkdirSync(destDir, { recursive: true });
  const staging = mkdtempSync(join(destDir, ".incomplete-"));
  try {
    const dbPath = join(staging, "weft.db");
    db.run("VACUUM INTO ?", [dbPath]);
    const capture = new Database(dbPath, { readonly: true });
    try {
      const files = join(staging, "files");
      mkdirSync(join(files, "snapshots"), { recursive: true });
      const buffer = new Uint8Array(128 * 1024);
      const blobs = capture.query<
        { folder: "" | "snapshots"; path: string; size: number; etag: string | null },
        []
      >(`SELECT '' AS folder, path, size, etag FROM files
         UNION ALL SELECT 'snapshots', path, size, NULL FROM page_snapshots`);
      for (const blob of blobs.iterate()) {
        const name = win32.basename(blob.path);
        if (name.length !== 64 || /[^0-9a-f]/.test(name)) {
          throw new Error("Invalid stored blob name in backup database");
        }
        const copy = join(files, blob.folder, name);
        copyFileSync(join(filesDir, blob.folder, name), copy, constants.COPYFILE_EXCL);
        if (statSync(copy).size !== blob.size ||
            (blob.etag !== null && fileDigest(copy, buffer) !== blob.etag)) {
          throw new Error(`Backup blob differs from its saved revision: ${name}`);
        }
      }
    } finally {
      capture.close();
    }

    const prefix = new Date().toISOString().replace(/[:.]/g, "-") + "-";
    let nextSeq = 0;
    for (const name of readdirSync(destDir)) {
      if (!name.startsWith(prefix)) continue;
      const suffix = name.slice(prefix.length);
      if (/^\d{6}$/.test(suffix)) nextSeq = Math.max(nextSeq, Number(suffix) + 1);
    }
    for (let seq = nextSeq; seq < 1_000_000; seq++) {
      const dir = join(destDir, `${prefix}${String(seq).padStart(6, "0")}`);
      if (existsSync(dir)) continue;
      try {
        renameSync(staging, dir);
        return dir;
      } catch (error) {
        // Another publisher can claim the name after our check. A completed
        // archive is nonempty, so rename cannot replace it.
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
      }
    }
    throw new Error("No free backup name for the current timestamp");
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
