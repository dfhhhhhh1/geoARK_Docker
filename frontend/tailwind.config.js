/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // The logo's gold, from its bright arrow tip (400) down to the bronze of
        // the "o" (600-700). The dark end is deepened past the logo so white
        // text on brand-600 and brand-700 links on white both clear 4.5:1.
        brand: {
          50: '#fdf8ec',
          100: '#faefd2',
          200: '#f4dca0',
          300: '#ecc166',
          400: '#dea12c',
          500: '#c28a17',
          600: '#936410',
          700: '#7a520f',
          800: '#5f400e',
          900: '#46300c',
        },
        // The near-black the logo starts from; warmer than slate-900.
        ink: '#1c1914',
      },
    },
  },
  plugins: [],
};
