import type { Plugin } from "vite";

export interface GsxOptions {}

export function gsx(_options: GsxOptions = {}): Plugin {
  return {
    name: "vite-plugin-gsx",
    apply: "serve",
  };
}

export default gsx;
