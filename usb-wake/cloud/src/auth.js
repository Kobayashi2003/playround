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
  return digestsEqual(received, `Bearer ${expected}`);
}

async function digestsEqual(left, right) {
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encode(left)),
    crypto.subtle.digest("SHA-256", encode(right)),
  ]);
  return equal(new Uint8Array(a), new Uint8Array(b));
}

function equal(left, right) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let i = 0; i < left.length; i++) mismatch |= left[i] ^ right[i];
  return mismatch === 0;
}

// The password is the ACCESS_PASSWORD secret, set from cloud/.dev.vars before
// deployment; there is deliberately no way to change it from the web page.
export function configuredPassword(env) {
  const value = env.ACCESS_PASSWORD;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function passwordMatches(password, env) {
  const expected = configuredPassword(env);
  if (!expected || typeof password !== "string") return false;
  if (encode(password).length > 256) return false;
  return digestsEqual(password, expected);
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

// Derived from the password, so changing it signs every session out.
async function accessVersion(env) {
  const mac = await crypto.subtle.sign(
    "HMAC",
    await sessionKey(env.ADMIN_TOKEN),
    encode(`access:${configuredPassword(env)}`),
  );
  return base64(mac).slice(0, 22);
}

export async function makeSession(env, secure) {
  const content = `${await accessVersion(env)}.${Date.now() + SESSION_MS}`;
  const signature = base64(
    await crypto.subtle.sign(
      "HMAC",
      await sessionKey(env.ADMIN_TOKEN),
      encode(content),
    ),
  );
  return `wake_session=${content}.${signature}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure ? "; Secure" : ""}`;
}

export async function controlAuthorized(request, env) {
  if (await ownerAuthorized(request, env.ADMIN_TOKEN)) return true;
  if (!configuredPassword(env)) return false;
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
    version !== (await accessVersion(env)) ||
    Number(expires) <= Date.now() ||
    !signature
  )
    return false;
  try {
    return await crypto.subtle.verify(
      "HMAC",
      await sessionKey(env.ADMIN_TOKEN),
      unbase64(signature),
      encode(`${version}.${expires}`),
    );
  } catch {
    return false;
  }
}
