export const clip = (value, length = 1000) =>
  String(value || "").slice(0, length);
