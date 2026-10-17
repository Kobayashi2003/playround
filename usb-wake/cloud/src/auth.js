const encode = (value) => new TextEncoder().encode(value);
const base64 = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
const unbase64 = (value) =>
  Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
    c.charCodeAt(0),
  );
const SESSION_MS = 12 * 60 * 60 * 1000;

export async function ownerAuthorized(request, expected) {
  if (typeof expected !== "string" || expected.length < 32) return false;
  const received = request.headers.get("Authorization") ?? "";
  if (received.length > 512) return false;
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encode(received)),
    crypto.subtle.digest("SHA-256", encode(`Bearer ${expected}`)),
  ]);
  return equal(new Uint8Array(left), new Uint8Array(right));
}

function equal(left, right) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let i = 0; i < left.length; i++) mismatch |= left[i] ^ right[i];
  return mismatch === 0;
}

async function derive(password, salt) {
  const key = await crypto.subtle.importKey(
    "raw",
    encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    key,
    256,
  );
}

export async function createAccess(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return {
    enabled: true,
    version: crypto.randomUUID(),
    salt: base64(salt),
    hash: base64(await derive(password, salt)),
  };
}

export async function passwordMatches(password, access) {
  if (typeof password !== "string" || encode(password).length > 256)
    return false;
  return equal(
    new Uint8Array(await derive(password, unbase64(access.salt))),
    unbase64(access.hash),
  );
}

async function sessionKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function makeSession(access, secret, secure) {
  const content = `${access.version}.${Date.now() + SESSION_MS}`;
  const signature = base64(
    await crypto.subtle.sign("HMAC", await sessionKey(secret), encode(content)),
  );
  return `wake_session=${content}.${signature}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure ? "; Secure" : ""}`;
}

export async function controlAuthorized(request, access, secret) {
  if (!access.enabled || (await ownerAuthorized(request, secret))) return true;
  const value = request.headers
    .get("Cookie")
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith("wake_session="))
    ?.slice(13);
  if (!value) return false;
  const [version, expires, signature, extra] = value.split(".");
  if (
    extra ||
    version !== access.version ||
    Number(expires) <= Date.now() ||
    !signature
  )
    return false;
  try {
    return await crypto.subtle.verify(
      "HMAC",
      await sessionKey(secret),
      unbase64(signature),
      encode(`${version}.${expires}`),
    );
  } catch {
    return false;
  }
}
