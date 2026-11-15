// Import this before feature modules: ESM evaluates their top-level constants
// before the body of index.js. Host-provided values keep precedence over .env.
try {
  process.loadEnvFile();
} catch (error) {
  if (error.code !== "ENOENT") {
    console.warn("[config] Could not load .env:", error.message);
  }
}
