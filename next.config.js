/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    turbo: {
      rules: {
        '*.ts': ['babel-loader'],
        '*.tsx': ['babel-loader'],
      },
    },
  },
  typescript: {
    ignoreBuildErrors: false,
  },
  webpack: (config, { isServer }) => {
    // Exclude supabase directories from build
    config.module.rules.push({
      test: /\.tsx?$/,
      exclude: [/supabase-core/, /supabase-projects/],
    })
    return config
  },
  // Exclude supabase-core from compilation
  experimental: {
    externalDir: true,
  },
}

module.exports = nextConfig