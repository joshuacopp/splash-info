/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // Splash brand blues (from the master sheet "Logo and Colors")
        splash: {
          50: '#eaf4fb',
          100: '#d5e9f7',
          300: '#3698d4',
          600: '#134b8e',
          700: '#0f3d74',
        },
      },
    },
  },
  plugins: [],
}
