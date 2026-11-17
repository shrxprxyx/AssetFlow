const { tokens } = require('./src/styles/tokens');

module.exports = {
  content: [
    './src/app/**/*.{js,ts,jsx,tsx}',
    './src/components/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: tokens.colors,
      spacing: tokens.spacing,
      fontSize: tokens.fontSize,
      borderRadius: tokens.radius,
      boxShadow: tokens.shadows,
    },
  },
  plugins: [],
};

export default config;