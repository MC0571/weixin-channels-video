const encoder = new TextEncoder();

export function isSafeRelativeMp4Filename(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !value.toLowerCase().endsWith(".mp4") ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f<>:"|?*]/.test(value)
  ) return false;

  const parts = value.split("/");
  return parts.every((part) => {
    if (!part || part === "." || part === "..") return false;
    return encoder.encode(part).byteLength <= 255;
  });
}
