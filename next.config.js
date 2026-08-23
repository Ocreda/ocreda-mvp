/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep production builds separate from the live dev compiler. Running
  // `next build` while `next dev` is open otherwise replaces dev chunks and
  // leaves the browser requesting CSS/JS hashes that no longer exist.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  eslint: {
    ignoreDuringBuilds: true,
  },
  images: { unoptimized: true },
  webpack(config, { dev }) {
    // Next 13's persistent development cache can race its own temporary pack
    // files on macOS, producing repeated ENOENT rename warnings. Development
    // recompilation remains fully functional without this disk cache, while
    // production keeps Webpack's normal optimized cache behavior.
    if (dev) config.cache = false;
    return config;
  },
};

module.exports = nextConfig;
