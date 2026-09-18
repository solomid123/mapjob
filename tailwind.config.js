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
        // iCloud surfaces: two soft layers plus a hairline ring, never a border.
        'ic-rest': '0 1px 2px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.05)',
        'ic-lift': '0 2px 6px rgba(0,0,0,0.06), 0 12px 32px rgba(0,0,0,0.11)',
        'ic-pop': '0 8px 20px rgba(0,0,0,0.09), 0 24px 56px rgba(0,0,0,0.16)',
      },
      transitionTimingFunction: {
        apple: 'cubic-bezier(0.32, 0.72, 0, 1)',
        'apple-out': 'cubic-bezier(0.22, 1, 0.36, 1)',
        'apple-spring': 'cubic-bezier(0.34, 1.32, 0.52, 1)',
      },
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"SF Pro Text"',
          'Inter',
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

