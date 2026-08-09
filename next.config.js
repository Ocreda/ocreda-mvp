/** @type {import('next').NextConfig} */
const nextConfig = {
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
