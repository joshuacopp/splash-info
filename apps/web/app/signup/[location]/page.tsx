// Step 7: package picker. Will server-fetch packages via @splash/db-supabase
// and render the simplified picker (port from legacy/signupworker.js
// renderPicker). Note Next.js 15 — params is a Promise.

interface PageProps {
  params: Promise<{ location: string }>;
}

export default async function SignupLocationPage({ params }: PageProps) {
  const { location } = await params;
  return (
    <section style={{ padding: 24 }}>
      <h1>Signup — {location}</h1>
      <p>Step 4 placeholder. Port from renderPicker (legacy/signupworker.js) in Step 7.</p>
    </section>
  );
}
