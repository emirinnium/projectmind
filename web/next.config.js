/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  turbopack: {
    root: require('path').resolve(__dirname, '..'),
  },
};

// The App Router owns the API handlers in this package. A proxy is opt-in so
// local and standalone deployments do not silently bypass those handlers.
if (process.env.PROJECTMIND_API_PROXY) {
  nextConfig.rewrites = async () => [
    {
      source: '/api/:path*',
      destination: `${process.env.PROJECTMIND_API_PROXY}/api/:path*`,
    },
  ];
}

module.exports = nextConfig;
