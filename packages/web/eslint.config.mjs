import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // eslint-config-next's own ignores, plus the second build directory the proof uses.
  globalIgnores([".next/**", ".next-verify/**", "out/**", "build/**", "next-env.d.ts"]),
]);

export default eslintConfig;
