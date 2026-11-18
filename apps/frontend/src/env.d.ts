/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional build-time backend origin; empty means same-origin relative requests. */
  readonly VITE_API_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
