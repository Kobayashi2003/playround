// OTA image store. tools/ota.py uploads an ESP-IDF app image; the board
// downloads it when its running image digest differs.

// SQLite-backed Durable Object values may be up to 2 MB; stay well below.
const CHUNK = 128 * 1024;
// Size of one app slot (app0/app1) in the board's default partition table.
export const MAX_IMAGE = 0x140000;

const hex = (bytes) =>
  [...new Uint8Array(bytes)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

// ESP-IDF appends the SHA-256 of the image to the image; the board identifies
// its running firmware by that digest.
export async function imageDigest(image) {
  if (image.byteLength < 64 || image.byteLength > MAX_IMAGE) return null;
  const body = image.slice(0, image.byteLength - 32);
  const computed = hex(await crypto.subtle.digest("SHA-256", body));
  return computed === hex(image.slice(image.byteLength - 32)) ? computed : null;
}

export async function store(storage, image, digest) {
  const previous = await storage.get("firmware");
  const chunks = Math.ceil(image.byteLength / CHUNK);
  const entries = {};
  for (let i = 0; i < chunks; i++)
    entries[`fw:${i}`] = new Uint8Array(
      image.slice(i * CHUNK, (i + 1) * CHUNK),
    );
  await storage.put(entries);
  for (let i = chunks; i < (previous?.chunks ?? 0); i++)
    await storage.delete(`fw:${i}`);
  const meta = {
    digest,
    size: image.byteLength,
    chunks,
    uploadedAt: Date.now(),
  };
  await storage.put("firmware", meta);
  return meta;
}

export async function clear(storage) {
  const previous = await storage.get("firmware");
  const keys = Array.from(
    { length: previous?.chunks ?? 0 },
    (_, i) => `fw:${i}`,
  );
  await storage.delete([...keys, "firmware"]);
}

export async function download(storage) {
  const meta = await storage.get("firmware");
  if (!meta) return new Response("No firmware offered.", { status: 404 });
  // Sent whole rather than streamed: a streamed body reaches the board
  // re-chunked, and its HTTP client times out parsing the chunk framing.
  const keys = Array.from({ length: meta.chunks }, (_, i) => `fw:${i}`);
  const chunks = await storage.get(keys);
  const image = new Uint8Array(meta.size);
  let offset = 0;
  for (const key of keys) {
    const chunk = chunks.get(key);
    image.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(image, {
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Firmware-Digest": meta.digest,
      "Cache-Control": "no-store",
    },
  });
}
