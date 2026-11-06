declare global {
  var __zod_globalConfig: { jitless: boolean } | undefined;
}

// Zod tests for eval once by calling new Function. The site's policy refuses that, and the browser
// reports the refusal even though Zod catches it. This flag makes Zod skip the test altogether.
globalThis.__zod_globalConfig = { jitless: true };

export {};
