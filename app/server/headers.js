export const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'self'; base-uri 'self'; form-action 'self'",
};

export function jsonResponse(data, status = 200) {
  return Response.json(data, { status, headers: { ...securityHeaders, 'Cache-Control': 'no-store' } });
}

export function assetResponse(path, body) {
  const type = path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html';
  return new Response(body, { headers: { ...securityHeaders, 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-cache' } });
}
