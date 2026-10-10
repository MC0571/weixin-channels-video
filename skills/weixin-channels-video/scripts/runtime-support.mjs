export const RUNTIME_PROTOCOL = 2;
export const MIN_NODE_VERSION = "22.22.2";

function versionParts(value) {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+$/.test(value)) return null;
  return value.split(".").map(Number);
}

export function supportsNodeVersion(value = process.versions.node) {
  const actual = versionParts(value);
  const minimum = versionParts(MIN_NODE_VERSION);
  if (!actual) return false;
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
  }
  return true;
}
