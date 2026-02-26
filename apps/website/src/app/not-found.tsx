export default function NotFound() {
  return (
    <html lang="en" className="dark">
      <body style={{ fontFamily: 'system-ui, sans-serif', background: '#080d19', color: '#e2e8f0', display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>
        <div style={{ textAlign: 'center' }}>
          <h1 style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>404</h1>
          <p style={{ color: '#64748b' }}>Page not found</p>
        </div>
      </body>
    </html>
  );
}
