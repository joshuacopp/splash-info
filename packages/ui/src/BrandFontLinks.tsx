// <link> tags for the Splash brand font (Asap from Google Fonts).
// Place inside Next.js <head> via the metadata API or a layout component.
// Source: legacy/dashboard.js:230-234.

export function BrandFontLinks() {
  return (
    <>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Asap:wght@400;500;600;700;800&display=swap"
      />
    </>
  );
}
