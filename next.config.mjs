import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // This is a server-rendered web dashboard; session-aware routes need the server.
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: true },
  // Set explicitly rather than relying on tsconfig `paths` inference, which did
  // not reach webpack in this setup.
  webpack: (cfg) => {
    cfg.resolve.alias = { ...cfg.resolve.alias, '@': path.join(dir, 'src') };
    return cfg;
  },
};

export default config;
