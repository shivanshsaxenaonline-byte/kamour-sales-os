// Next injects these at build time, but `moduleResolution: bundler` with strict
// TS still wants an explicit declaration for side-effect CSS imports.
declare module '*.css';
