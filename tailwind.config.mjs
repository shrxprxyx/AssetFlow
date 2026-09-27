const { tokens } = require('./styles/tokens');

module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx}',
    './components/**/*.{js,ts,jsx,tsx}',
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