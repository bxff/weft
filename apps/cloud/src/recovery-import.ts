import { RmDocument } from "@weft/rm-format";
import type { OverlayDocument } from "@weft/sync-engine";

type RecoveryPage = {
  id: string;
  overlay: OverlayDocument;
  native: Uint8Array;
  currentNative?: Uint8Array;
  assets: { name: string; bytes: Uint8Array }[];
};

export type RecoveryImport = {
  notebook: {
    id: string;
    name: string;
    pages: { id: string; template: "Blank" }[];
  };
  pages: RecoveryPage[];
};

const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const assetPattern = /^[A-Za-z0-9_-]{1,64}\.(?:png|jpe?g)$/;
const shaPattern = /^[a-f0-9]{64}$/;

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
const hash = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

function reject(message: string): never { throw new Error(message); }

function readCanonicalBase64(value: unknown, digest?: unknown): Uint8Array {
  if (typeof value !== "string" || !value.length || value.length % 4 !== 0) {
    return reject("expected canonical base64 bytes");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) return reject("expected canonical base64 bytes");
  if (digest !== undefined &&
      (typeof digest !== "string" || !shaPattern.test(digest) || hash(bytes) !== digest)) {
    return reject("recovery file digest does not match its bytes");
  }
  return bytes;
}

function readOverlay(value: unknown): OverlayDocument {
  const obj = record(value);
  if (!obj || !Array.isArray(obj.shapes) || !obj.shapes.every((entry: unknown) => {
    const shape = record(entry);
    return !!shape && typeof shape.shapeId === "string" && Array.isArray(shape.rendered) &&
      typeof shape.kind === "string" && record(shape.version) !== null;
  }) || (obj.tombstones !== undefined && !record(obj.tombstones))) {
    return reject("invalid editable page state");
  }
  return obj as unknown as OverlayDocument;
}

/** V1 reuses the existing page codec; a user-selected, top-level native
 * notebook with blank templates deliberately excludes PDF sources and folders. */
export function parseRecoveryImport(value: unknown): RecoveryImport {
  const input = record(value);
  const book = record(input?.notebook);
  if (input?.mode !== undefined && input.mode !== "same-tablet-newer-native") {
    return reject("unsupported recovery mode");
  }
  const id = book?.id;
  const name = book?.name;
  if (input?.version !== 1 || book?.type !== "notebook" || book.parent !== "" ||
      typeof id !== "string" || !uuidPattern.test(id) ||
      typeof name !== "string" || !name.trim() || name.length > 256 ||
      !Array.isArray(book.pages) || book.pages.length < 1 || book.pages.length > 256 ||
      !Array.isArray(input.pages) || input.pages.length !== book.pages.length) {
    return reject("expected one top-level notebook with 1–256 pages");
  }
  const ids = new Set<string>();
  const orderedPages = book.pages.map((entry: unknown) => {
    const meta = record(entry);
    if (!meta || typeof meta.id !== "string" || !uuidPattern.test(meta.id) || ids.has(meta.id) ||
        (meta.template !== undefined && meta.template !== "" && meta.template !== "Blank")) {
      return reject("invalid page id, duplicate page, or unsupported template");
    }
    ids.add(meta.id);
    return { id: meta.id, template: "Blank" as const };
  });
  const pages = input.pages.map((entry: unknown): RecoveryPage => {
    const raw = record(entry);
    if (!raw || typeof raw.id !== "string" || !ids.delete(raw.id) || !Array.isArray(raw.assets) ||
        typeof raw.nativeSha256 !== "string") return reject("invalid recovery page");
    const overlay = readOverlay(raw.overlay);
    const native = readCanonicalBase64(raw.nativeBase64, raw.nativeSha256);
    if (raw.currentNativeBase64 !== undefined) return reject("legacy current native input is ambiguous");
    const current = raw.currentNative === undefined ? null : record(raw.currentNative);
    if (raw.currentNative !== undefined &&
        (input.mode !== "same-tablet-newer-native" || !current || !Array.isArray(current.assets))) {
      return reject("current native requires explicit same-tablet newer-native mode and image digests");
    }
    const currentNative = current ? readCanonicalBase64(current.base64) : undefined;
    const names = new Map<string, string>();
    const assets = raw.assets.map((entry: unknown) => {
      const asset = record(entry);
      if (!asset || typeof asset.name !== "string" || !assetPattern.test(asset.name) ||
          typeof asset.sha256 !== "string" || names.has(asset.name)) {
        return reject("invalid or duplicate recovery image");
      }
      names.set(asset.name, asset.sha256);
      return { name: asset.name, bytes: readCanonicalBase64(asset.base64, asset.sha256) };
    });
    const references = (bytes: Uint8Array) => [...RmDocument.parse(bytes).tree().walk()]
      .flatMap(([, item]) => item.kind === "image" ? [item.filename] : []);
    for (const filename of references(native)) {
      if (!filename || !names.has(filename)) return reject("recovery checkpoint is missing a referenced image");
    }
    if (current && currentNative) {
      const proof = new Map<string, string>();
      for (const entry of current.assets as unknown[]) {
        const asset = record(entry);
        if (!asset || typeof asset.name !== "string" || typeof asset.sha256 !== "string" ||
            proof.has(asset.name) || names.get(asset.name) !== asset.sha256) {
          return reject("current image differs from the checkpoint; restore only the checkpoint instead");
        }
        proof.set(asset.name, asset.sha256);
      }
      for (const filename of references(currentNative)) {
        if (!filename || !proof.has(filename)) {
          return reject("current native references an unverified image; restore only the checkpoint instead");
        }
      }
    }
    return { id: raw.id, overlay, native, ...(currentNative ? { currentNative } : {}), assets };
  });
  return { notebook: { id, name, pages: orderedPages }, pages };
}
