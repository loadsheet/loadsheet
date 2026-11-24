// Every package builds ESM with types and fails on publint.
import { defineConfig, type UserConfig } from "tsdown";

export const definePackage = (config: UserConfig = {}) =>
  defineConfig({
    entry: ["src/index.ts"],
    format: ["esm"],
    fixedExtension: true,
    dts: true,
    clean: true,
    publint: true,
    ...config,
  });
