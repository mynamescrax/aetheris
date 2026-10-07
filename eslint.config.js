import js from "@eslint/js";
import globals from "globals";

export default [
  // third-party/vendored content: never lint or rewrite these
  {
    ignores: [
      "node_modules/**",
      "public/assets/games/**",
      "public/js/vendor/**",
      "mynamescraxbackuphtmlfiles/**",
      "pnpm-lock.yaml",
    ],
  },
  js.configs.recommended,
  {
    files: [
      "index.js",
      "monitor.js",
      "lc-relay.js",
      "movie-relay.js",
      "eslint.config.js",
      "lib/**/*.js",
      "tests/**/*.js",
      "scripts/**/*.js",
    ],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
  },
  {
    // browser scripts (classic scripts, no modules)
    files: [
      "public/js/**/*.js",
      "public/sw.js",
      "public/register-sw.js",
      "public/assets/data/*.js",
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        ...globals.browser,
        ...globals.serviceworker,
        // cross-script globals: defined in one file, called/assigned
        // from another (or from inline HTML onclick= handlers)
        $scramjet: "readonly",
        $scramjetController: "readonly",
        registersw: "readonly",
        Aetheris: "readonly",
        AetherisCache: "readonly",
        TMDB_API: "readonly",
        TMDB_IMG: "readonly",
        MOVIES_SOURCES: "readonly",
        apps: "writable",
        autologin: "writable",
        authtoken: "writable",
        myusername: "writable",
        cleartoken: "readonly",
        getdeviceid: "readonly",
        ini: "readonly",
        esc: "readonly",
        timeago: "readonly",
        switchtab: "readonly",
        submitauth: "readonly",
        showapp: "writable",
        savetoken: "readonly",
      },
    },
    rules: {
      // old-Safari-friendly classic scripts wired to inline handlers
      "no-unused-vars": "off",
      // globals are shared across files (dm-shared.js -> chat.js)
      "no-redeclare": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      // `<\/script>` in strings is deliberate (safe to inline in HTML)
      "no-useless-escape": "off",
      "no-useless-assignment": "off",
    },
  },
  {
    // deliberately minified-style ad-spoof shim
    files: ["public/js/ad-spoof.js"],
    rules: {
      "no-setter-return": "off",
    },
  },
];
