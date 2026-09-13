/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#fff1f2',
          100: '#ffe4e6',
          500: '#f43f5e',
          600: '#e11d48',
          700: '#be123c',
          airbnb: '#FF385C',
          airbnbDark: '#E00B41',
        },
      },
      boxShadow: {
        'airbnb': '0 3px 10px rgba(0,0,0,0.1)',
        'airbnb-hover': '0 6px 20px rgba(0,0,0,0.15)',
        'pill': '0 2px 4px rgba(0,0,0,0.18)',
        'pill-hover': '0 4px 12px rgba(0,0,0,0.25)',
      },
      fontFamily: {
        sans: [
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          'Roboto',
          'Helvetica',
          'Arial',
          'sans-serif',
        ],
      },
    },
  },
  plugins: [],
}

