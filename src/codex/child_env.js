// A positive list: new service credentials must never become child credentials.
const RUNTIME_KEYS = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE",
  "TZ", "TERM", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR", "PATHEXT",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "CODEX_HOME", "CODEX_REAL_PATH"
]);
const AUTH_KEYS = new Set(["CODEX_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL"]);

export function buildCodexChildEnv(overrides, { base = process.env, managed = false, home } = {}) {
  const env = {};
  for (const source of [base, overrides]) {
    if (!source || typeof source !== "object" || Array.isArray(source)) continue;
    for (const [key, value] of Object.entries(source)) {
      if ((RUNTIME_KEYS.has(key) || (!managed && AUTH_KEYS.has(key))) && typeof value === "string") env[key] = value;
    }
  }
  if (home) env.CODEX_HOME = home;
  return env;
}
