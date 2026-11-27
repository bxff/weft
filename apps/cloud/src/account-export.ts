// Stream a POSIX ustar archive, at most one notebook page or resource resident.
// Generated entry paths never include user-controlled IDs or filenames.
import type { CloudStore } from "./store";

async function* tarEntry(
  path: string, bytes: Uint8Array | Blob, open: () => void,
): AsyncGenerator<Uint8Array> {
  open();
  const size = bytes instanceof Uint8Array ? bytes.length : bytes.size;
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, "ascii");
  header.write("0000600\0", 100, "ascii");
  header.write("0000000\0", 108, "ascii");
  header.write("0000000\0", 116, "ascii");
  if (size > 0o77777777777) throw new Error("Source is too large for this archive format");
  header.write(size.toString(8).padStart(11, "0") + "\0", 124, "ascii");
  header.write("00000000000\0", 136, "ascii");
  header.fill(32, 148, 156);
  header[156] = 48;
  header.write("ustar\0" + "00", 257, "ascii");
  const sum = header.reduce((total, value) => total + value, 0);
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  yield header;
  if (bytes instanceof Uint8Array) {
    open();
    yield bytes;
  } else {
    let emitted = 0;
    const reader = bytes.stream().getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        open();
        emitted += value.byteLength;
        if (emitted > size) throw new Error("Archived file grew during download");
        yield value;
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    if (emitted !== size) throw new Error("Archived file disappeared during download");
  }
  if (size % 512) yield new Uint8Array(512 - size % 512);
}

export function streamNotebookExport(store: CloudStore, user: string, finish: () => void): ReadableStream<Uint8Array> {
  const open = () => {
    if (store.isAccountFenced(user)) throw new Error("Account closed during export");
  };
  const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v, null, 2));
  async function* entries() {
    yield* tarEntry("about.json", json({
      format: "weft-notebooks-v1", exportedAt: new Date().toISOString(),
      scope: "Current synced notebook content; not edit history, device-only files or login data.",
    }), open);
    yield* tarEntry("documents.json", json(JSON.parse(store.getDocuments(user))), open);
    for (const [i, { doc, page }] of store.accountExportPages(user).entries()) {
      open();
      const path = "pages/" + i;
      const recovery = store.readRecoveryPage(user, doc, page, null, null)?.body;
      const assets = store.listAssets(user, doc, page);
      const { nativeBase64, ...pageState } = recovery ?? {};
      yield* tarEntry(path + "/page.json", json({
        doc, page, assetFiles: assets, ...pageState,
        overlay: recovery?.overlay ?? JSON.parse(store.getOverlay(user, doc, page) ?? '{"shapes":[]}'),
      }), open);
      if (nativeBase64) yield* tarEntry(path + "/native.rm", Buffer.from(nativeBase64, "base64"), open);
      for (const [index, name] of assets.entries()) {
        const bytes = store.getAsset(user, doc, page, name);
        if (!bytes) throw new Error("A notebook asset changed during export");
        yield* tarEntry(path + "/assets/" + index, bytes, open);
      }
    }
    for (const [i, doc] of store.residentSources(user).entries()) {
      open();
      const ref = store.getFileRef(user, doc);
      if (!ref) throw new Error("A source file changed during export");
      const path = "sources/" + i;
      yield* tarEntry(path + "/source.json", json({ doc, mime: ref.mime }), open);
      yield* tarEntry(path + "/content", Bun.file(ref.path), open);
    }
    for (const [i, template] of store.accountExportTemplates(user).entries()) {
      open();
      const bytes = store.getTemplate(user, template.name);
      if (!bytes) throw new Error("A template changed during export");
      yield* tarEntry("templates/" + i + "/template.json", json(template), open);
      yield* tarEntry("templates/" + i + "/content", bytes.bytes, open);
    }
    open();
    yield new Uint8Array(1024);
  }
  const generator = entries();
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await generator.next();
        if (!done) controller.enqueue(value);
        else { finish(); controller.close(); }
      } catch (error) {
        finish();
        throw error;
      }
    },
    async cancel() {
      try { await generator.return(undefined); } finally { finish(); }
    },
  }, { highWaterMark: 0 });
}
